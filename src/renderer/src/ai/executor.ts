/**
 * AI 도구 실행기 (7.2.1) — 툴콜 → 검증 → 커맨드 dispatch → 한국어 결과.
 * 렌더러에 사는 단일 진실: SDK 우회 테스트(__test.aiRunTools)와 실제 IPC 경로가 같은 함수를 탄다.
 *
 * 규칙:
 *  - 편집 도구 1콜 = dispatch 1회 = undo 1회 (턴 롤백은 aiStore 가 개수로 관리)
 *  - 검증/불변식 위반은 크래시 없이 한국어 에러 메시지로 반환 → 모델이 읽고 자가 수정
 *  - 파괴적(delete/remove_silence/export)·프라이버시(capture_preview) 도구는 확인 게이트를 거친다
 */
import { z } from 'zod'
import type { Clip, Project } from '@shared/model/types'
import type { AiToolReply } from '@shared/ipc-types'
import { AI_TOOL_BY_NAME } from '@shared/aiTools'
import { summarizeProject } from '@shared/aiSummary'
import { rangesCoverage } from '@shared/silence'
import { applyTextPreset, TEXT_PRESETS } from '@shared/textPresets'
import { createMediaClip, createTextClip, createTrack, genId, subtitleBottomY } from '@shared/model/factory'
import { useEditor } from '../state/store'
import {
  addClipOverlay,
  addSubtitleClips,
  findClip,
  mergeClip,
  moveClip,
  moveClipToTrack,
  removeClip,
  splitClip,
  trimClip,
  updateClip
} from '../state/commands'
import { playback } from '../engine/playback'
import { useAi } from './aiStore'
// 고수준 도구(무음/자막/내보내기/캡처)의 무거운 의존성(WebGL/ffmpeg 경로)은 케이스 내부에서
// 동적 import — 코어 편집 도구만 쓰는 유닛 테스트가 그 그래프를 끌어오지 않도록 한다.

export interface ToolCall {
  name: string
  input: Record<string, unknown>
}

const ok = (message: string, imageDataUrl?: string): AiToolReply => ({ ok: true, message, imageDataUrl })
const err = (message: string): AiToolReply => ({ ok: false, message })

/** dispatch 후 프로젝트가 실제로 바뀌었는지(no-op 감지) — 바뀌면 프리뷰 갱신 */
function dispatchChange(label: string, fn: (p: Project) => Project): boolean {
  const before = useEditor.getState().project
  useEditor.getState().dispatch(label, fn)
  const changed = useEditor.getState().project !== before
  if (changed) playback.refresh()
  return changed
}

function requireClip(clipId: string): { clip: Clip } | { error: string } {
  const found = findClip(useEditor.getState().project, clipId)
  if (!found) return { error: `클립 id "${clipId}" 를 찾을 수 없습니다. get_project_state 로 현재 클립 목록을 확인하세요.` }
  return { clip: found.clip }
}

export async function executeTool(call: ToolCall): Promise<AiToolReply> {
  const spec = AI_TOOL_BY_NAME.get(call.name)
  if (!spec) return err(`알 수 없는 도구 "${call.name}".`)

  const parsed = z.object(spec.shape).safeParse(call.input ?? {})
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join(', ')
    return err(`입력 검증 실패: ${msg}`)
  }
  const input = parsed.data as Record<string, unknown>

  try {
    return await run(call.name, input)
  } catch (e) {
    return err(`실행 오류: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function run(name: string, input: Record<string, unknown>): Promise<AiToolReply> {
  const ai = useAi.getState()
  const ed = (): ReturnType<typeof useEditor.getState> => useEditor.getState()

  switch (name) {
    // ── 조회 ──
    case 'get_project_state': {
      const s = ed()
      const summary = summarizeProject(s.project, { selectedClipId: s.selectedClipId, playhead: s.playhead })
      return ok(JSON.stringify(summary))
    }
    case 'seek': {
      const t = input.timeSec as number
      void playback.seek(t)
      return ok(`플레이헤드를 ${t}s 로 옮겼습니다.`)
    }
    case 'select_clip': {
      const r = requireClip(input.clipId as string)
      if ('error' in r) return err(r.error)
      ed().select(r.clip.id)
      return ok(`클립 "${r.clip.id}" 를 선택했습니다.`)
    }

    // ── 컷 ──
    case 'split_clip': {
      const clipId = input.clipId as string
      const atSec = input.atSec as number
      const r = requireClip(clipId)
      if ('error' in r) return err(r.error)
      if (atSec <= r.clip.timelineStart || atSec >= r.clip.timelineEnd)
        return err(`분할 시각 ${atSec}s 가 클립 범위(${r.clip.timelineStart}~${r.clip.timelineEnd}s) 밖입니다.`)
      const changed = dispatchChange('AI: 클립 분할', (p) => splitClip(p, clipId, atSec, genId('clip')))
      return changed ? ok(`${atSec}s 에서 분할했습니다.`) : err('분할하지 못했습니다(경계가 너무 가깝습니다).')
    }
    case 'trim_clip': {
      const clipId = input.clipId as string
      const r = requireClip(clipId)
      if ('error' in r) return err(r.error)
      const changed = dispatchChange('AI: 트림', (p) => trimClip(p, clipId, input.edge as 'start' | 'end', input.toSec as number))
      return changed ? ok(`${input.edge === 'start' ? '시작' : '끝'} 경계를 트림했습니다.`) : err('트림이 적용되지 않았습니다(범위 제약으로 클램프됨).')
    }
    case 'move_clip': {
      const clipId = input.clipId as string
      const r = requireClip(clipId)
      if ('error' in r) return err(r.error)
      const toTrackId = input.toTrackId as string | undefined
      const toSec = input.toSec as number
      if (toTrackId && !ed().project.tracks.some((t) => t.id === toTrackId)) return err(`트랙 id "${toTrackId}" 를 찾을 수 없습니다.`)
      const changed = dispatchChange('AI: 클립 이동', (p) =>
        toTrackId ? moveClipToTrack(p, clipId, toTrackId, toSec) : moveClip(p, clipId, toSec)
      )
      return changed ? ok(`클립을 ${toSec}s${toTrackId ? ' (다른 트랙)' : ''} 로 옮겼습니다.`) : err('이동이 적용되지 않았습니다(트랙 종류 불일치이거나 이미 그 위치).')
    }
    case 'merge_clip': {
      const clipId = input.clipId as string
      const r = requireClip(clipId)
      if ('error' in r) return err(r.error)
      const changed = dispatchChange('AI: 컷 병합', (p) => mergeClip(p, clipId))
      return changed ? ok('인접 클립과 병합했습니다.') : err('병합 가능한 인접 클립이 없습니다(같은 소스에서 맞닿아 있어야 합니다).')
    }
    case 'delete_clip': {
      const clipId = input.clipId as string
      const r = requireClip(clipId)
      if ('error' in r) return err(r.error)
      const label = r.clip.kind === 'text' ? `자막 "${r.clip.text?.value ?? ''}"` : `${r.clip.kind} 클립`
      const confirmed = await ai.requestConfirm(
        '클립 삭제',
        `${label} (${r.clip.timelineStart.toFixed(2)}~${r.clip.timelineEnd.toFixed(2)}s) 를 삭제합니다.\n⌘Z 로 복구할 수 있습니다.`
      )
      if (!confirmed) return err('사용자가 삭제를 취소했습니다.')
      if (ed().selectedClipId === clipId) ed().select(null)
      const changed = dispatchChange('AI: 클립 삭제', (p) => removeClip(p, clipId))
      return changed ? ok('클립을 삭제했습니다.') : err('삭제하지 못했습니다.')
    }

    // ── 텍스트/자막 ──
    case 'add_text': {
      const value = input.value as string
      const atSec = input.atSec as number
      const dur = (input.durationSec as number | undefined) ?? 3
      const clip = createTextClip(atSec, dur)
      clip.text = { ...clip.text!, value }
      // 자막 세로 위치 — 기본은 화면 하단 자막 기준선(요청: 최초 생성 위치를 하단에)
      const position = (input.position as 'bottom' | 'center' | 'top' | undefined) ?? 'bottom'
      const bottomY = subtitleBottomY(ed().project.settings.height, clip.text.fontSize)
      const y = position === 'center' ? 0 : position === 'top' ? -bottomY : bottomY
      clip.transform = { ...clip.transform!, y }
      dispatchChange('AI: 자막 추가', (p) => addSubtitleClips(p, [clip], createTrack('text')))
      ed().select(clip.id)
      const posLabel = position === 'center' ? '중앙' : position === 'top' ? '상단' : '하단'
      return ok(`"${value}" 자막을 ${atSec}s 에 ${posLabel}에 추가했습니다. (id: ${clip.id})`)
    }
    case 'update_text_style': {
      const clipId = input.clipId as string
      const r = requireClip(clipId)
      if ('error' in r) return err(r.error)
      if (r.clip.kind !== 'text' || !r.clip.text) return err('텍스트 클립이 아닙니다.')
      let text = { ...r.clip.text }
      const preset = input.preset as string | undefined
      if (preset) {
        const p = TEXT_PRESETS.find((x) => x.id === preset)
        if (!p) return err(`알 수 없는 프리셋 "${preset}".`)
        text = applyTextPreset(text, p)
      }
      if (input.fontSize !== undefined) text.fontSize = input.fontSize as number
      if (input.color !== undefined) text.color = input.color as string
      if (input.bold !== undefined) text.bold = input.bold as boolean
      if (input.italic !== undefined) text.italic = input.italic as boolean
      if (input.align !== undefined) text.align = input.align as 'left' | 'center' | 'right'
      if (input.animationIn !== undefined) text.animationIn = { type: input.animationIn as string, duration: 0.5 }
      if (input.loop !== undefined) {
        const loop = input.loop as string
        if (loop === 'none') delete text.loop
        else text.loop = { type: loop, duration: 1 }
      }
      dispatchChange('AI: 자막 스타일', (p) => updateClip(p, clipId, { text }))
      return ok(preset ? `프리셋 "${preset}" 을 적용했습니다.` : '자막 스타일을 바꿨습니다.')
    }

    // ── 효과/변형 ──
    case 'apply_filter': {
      const clipId = input.clipId as string
      const r = requireClip(clipId)
      if ('error' in r) return err(r.error)
      const type = input.type as string
      const value = input.value as number
      const effects = [...(r.clip.effects ?? []).filter((e) => e.type !== type), { type, params: { value }, enabled: true }]
      dispatchChange('AI: 필터', (p) => updateClip(p, clipId, { effects }))
      return ok(`${type} 필터를 ${value} 로 적용했습니다.`)
    }
    case 'add_transition': {
      const clipId = input.clipId as string
      const r = requireClip(clipId)
      if ('error' in r) return err(r.error)
      const found = findClip(ed().project, clipId)!
      const sorted = [...found.track.clips].sort((a, b) => a.timelineStart - b.timelineStart)
      const idx = sorted.findIndex((c) => c.id === clipId)
      const next = sorted[idx + 1]
      const adjacent = next && Math.abs(next.timelineStart - found.clip.timelineEnd) < 1e-3
      const duration = (input.durationSec as number | undefined) ?? 0.5
      dispatchChange('AI: 전환', (p) => updateClip(p, clipId, { transitionOut: { type: input.type as string, duration } }))
      return ok(
        `${input.type} 전환(${duration}s)을 걸었습니다.` + (adjacent ? '' : ' (다음 클립과 맞닿아 있지 않아 화면에 보이지 않을 수 있습니다.)')
      )
    }
    case 'set_volume_fade': {
      const clipId = input.clipId as string
      const r = requireClip(clipId)
      if ('error' in r) return err(r.error)
      const patch: Partial<Clip> = {}
      if (input.volume !== undefined) patch.volume = input.volume as number
      if (input.fadeInSec !== undefined) patch.fadeIn = input.fadeInSec as number
      if (input.fadeOutSec !== undefined) patch.fadeOut = input.fadeOutSec as number
      if (Object.keys(patch).length === 0) return err('바꿀 값(volume/fadeInSec/fadeOutSec)이 없습니다.')
      dispatchChange('AI: 볼륨/페이드', (p) => updateClip(p, clipId, patch))
      return ok('볼륨/페이드를 설정했습니다.')
    }
    case 'set_transform': {
      const clipId = input.clipId as string
      const r = requireClip(clipId)
      if ('error' in r) return err(r.error)
      const base = r.clip.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 }
      const transform = {
        x: (input.x as number | undefined) ?? base.x,
        y: (input.y as number | undefined) ?? base.y,
        scale: (input.scale as number | undefined) ?? base.scale,
        rotation: (input.rotation as number | undefined) ?? base.rotation
      }
      const patch: Partial<Clip> = { transform }
      if (input.opacity !== undefined) patch.opacity = input.opacity as number
      dispatchChange('AI: 변형', (p) => updateClip(p, clipId, patch))
      return ok('위치/크기/회전/불투명도를 설정했습니다.')
    }

    // ── 고수준 (7.3) ──
    case 'auto_captions': {
      const clipId = input.clipId as string
      const r = requireClip(clipId)
      if ('error' in r) return err(r.error)
      if (r.clip.kind === 'text' || r.clip.kind === 'image') return err('비디오/오디오 클립에만 자막을 생성할 수 있습니다.')
      const { generateCaptions } = await import('../stt/autoCaption')
      const count = await generateCaptions(clipId, {
        model: ((input.model as string | undefined) ?? 'whisper-base') as never,
        language: (input.language as string | undefined) ?? 'korean'
      })
      return count > 0 ? ok(`자막 ${count}개를 생성했습니다.`) : err('말소리를 인식하지 못했습니다(무음이거나 언어 설정 확인).')
    }
    case 'remove_silence': {
      const clipId = input.clipId as string
      const r = requireClip(clipId)
      if ('error' in r) return err(r.error)
      if (r.clip.kind === 'text' || r.clip.kind === 'image') return err('비디오/오디오 클립에만 무음 컷을 적용할 수 있습니다.')
      const { detectSilence } = await import('../silence/autoCut')
      const count = await detectSilence(clipId, {
        noiseDb: (input.noiseDb as number | undefined) ?? -35,
        minDurationSec: (input.minDurationSec as number | undefined) ?? 0.5,
        scope: (input.scope as 'this-track' | 'all-tracks' | undefined) ?? 'this-track'
      })
      if (count === 0) return err('무음 구간을 찾지 못했습니다(임계치를 낮추거나 최소 길이를 줄여 보세요).')
      // 같은 응답 안에서 감지→적용 연쇄를 막기 위해 이번 run 의 requestId 를 미리보기에 각인 (7.4)
      const reqId = useAi.getState().currentRequestId
      const pv = ed().silencePreview
      if (reqId && pv) ed().setSilencePreview({ ...pv, detectedByAiRequest: reqId })
      const found = findClip(ed().project, clipId)!
      const ranges = (ed().silencePreview?.candidates ?? []).map((c) => [c.start, c.end] as [number, number])
      const cov = rangesCoverage(ranges, found.clip.timelineStart, found.clip.timelineEnd)
      const totalSec = ranges.reduce((s, [a, b]) => s + (b - a), 0)
      const warn =
        cov >= 0.95
          ? ` ⚠️ 클립의 ${Math.round(cov * 100)}%가 무음으로 잡혔습니다 — 임계값이 너무 높을 수 있으니 -45dB 등으로 낮춰 다시 감지하는 것을 권합니다.`
          : ''
      return ok(
        `무음 ${count}개 구간(총 ${totalSec.toFixed(1)}초, 클립의 약 ${Math.round(cov * 100)}%)을 감지해 타임라인에 표시했습니다. 이 도구는 아직 아무것도 삭제하지 않았습니다.${warn} 사용자가 확인하고 적용을 지시하면 apply_silence_cut 을 호출하세요.`
      )
    }
    case 'apply_silence_cut': {
      const preview = ed().silencePreview
      if (!preview) return err('적용할 무음 미리보기가 없습니다. 먼저 remove_silence 로 감지하세요.')
      const cur = useAi.getState().currentRequestId
      if (preview.detectedByAiRequest && cur && preview.detectedByAiRequest === cur)
        return err(
          '방금 감지한 결과라 이번 응답에서는 적용하지 않습니다. 감지 결과를 사용자에게 보고하고 응답을 마치세요 — 사용자가 타임라인에서 확인한 뒤 "적용해"라고 지시하면 그때 적용됩니다.'
        )
      const selected = preview.candidates.filter((c) => c.selected)
      if (selected.length === 0) return err('선택된 무음 구간이 없습니다.')
      const ranges = selected.map((c) => [c.start, c.end] as [number, number])
      const totalSec = ranges.reduce((s, [a, b]) => s + (b - a), 0)
      const found = findClip(ed().project, preview.clipId)
      if (found) {
        const cov = rangesCoverage(ranges, found.clip.timelineStart, found.clip.timelineEnd)
        if (cov >= 0.95)
          return err(
            `선택 구간이 클립의 ${Math.round(cov * 100)}%를 덮어 클립이 통째로 사라집니다. 감지 오류일 가능성이 높으니, 임계값을 낮춰(예: -45dB) 다시 감지하거나 정말 삭제할 의도라면 인스펙터의 "무음 자동 컷"에서 직접 적용하세요. (안전을 위해 AI 는 클립 전체 삭제를 자동 적용하지 않습니다.)`
          )
      }
      const { applySilenceCut } = await import('../silence/autoCut')
      const confirmed = await ai.requestConfirm(
        '무음 컷 적용',
        `${selected.length}개 구간 · 총 ${totalSec.toFixed(1)}초 삭제 · 범위: ${preview.scope === 'all-tracks' ? '전체 트랙' : '이 트랙만'}\n⌘Z 로 되돌릴 수 있습니다.`
      )
      if (!confirmed) return err('사용자가 적용을 취소했습니다(미리보기는 유지).')
      applySilenceCut()
      playback.refresh()
      return ok(`무음 ${selected.length}개 구간(총 ${totalSec.toFixed(1)}초)을 잘라냈습니다. 되돌리려면 ⌘Z.`)
    }
    case 'add_overlay': {
      const assetId = input.assetId as string
      const asset = ed().project.assets.find((a) => a.id === assetId)
      if (!asset) return err(`자산 id "${assetId}" 를 찾을 수 없습니다. get_project_state 의 assets 에서 고르세요.`)
      const atSec = input.atSec as number
      const clip = createMediaClip(asset, atSec)
      const dur = input.durationSec as number | undefined
      if (dur !== undefined) {
        if (clip.sourceIn !== undefined && clip.kind !== 'image') {
          const speed = clip.speed ?? 1
          const maxDur = (asset.duration - clip.sourceIn) / speed
          const d = Math.min(dur, maxDur)
          clip.timelineEnd = atSec + d
          clip.sourceOut = clip.sourceIn + d * speed
        } else {
          clip.timelineEnd = atSec + dur
        }
      }
      dispatchChange('AI: 오버레이 추가', (p) => addClipOverlay(p, clip, createTrack('video')))
      ed().select(clip.id)
      return ok(`${asset.kind} 오버레이("${asset.path.split(/[/\\]/).pop()}")를 ${atSec}s 에 얹었습니다.`)
    }
    case 'export_video': {
      const confirmed = await ai.requestConfirm('영상 내보내기', '타임라인을 mp4 파일로 내보냅니다. 시간이 걸릴 수 있습니다.')
      if (!confirmed) return err('사용자가 내보내기를 취소했습니다.')
      const path = await window.editor.saveFileDialog(`${ed().project.name || 'export'}.mp4`)
      if (!path) return err('저장 위치가 선택되지 않아 내보내기를 취소했습니다.')
      const { exportTimeline, DEFAULT_EXPORT_SETTINGS } = await import('../engine/exporter')
      const handle = exportTimeline(ed().project, path, DEFAULT_EXPORT_SETTINGS, (percent) =>
        ed().setExportProgress({ active: true, percent, cancel: () => handle.cancel() })
      )
      ed().setExportProgress({ active: true, percent: 0, cancel: () => handle.cancel() })
      const result = await handle.promise
      ed().setExportProgress(null)
      return result.ok ? ok(`내보내기 완료: ${path}`) : err(`내보내기 실패: ${result.error ?? '알 수 없는 오류'}`)
    }
    case 'capture_preview': {
      const already = useAi.getState().visionOptIn
      if (!already) {
        const okd = await ai.requestConfirm(
          '화면 캡처 전송',
          '현재 프리뷰 화면(픽셀)을 캡처해 AI 에 이미지로 전송합니다. 이후 이 대화에서는 다시 묻지 않습니다.',
          true
        )
        if (!okd) return err('사용자가 화면 전송을 거부했습니다.')
        useAi.getState().setVisionOptIn(true)
      }
      const t = (input.atSec as number | undefined) ?? ed().playhead
      const { captureReferenceFrame } = await import('../engine/exporter')
      const dataUrl = await captureReferenceFrame(ed().project, t)
      return ok(`${t}s 시점의 프리뷰를 캡처했습니다.`, dataUrl)
    }

    default:
      return err(`도구 "${name}" 는 아직 구현되지 않았습니다.`)
  }
}
