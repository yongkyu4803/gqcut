/**
 * 자동 자막 오케스트레이션 (3.2) — 렌더러.
 * 선택한 비디오 클립의 오디오를 메인에서 전사 → 소스시간을 타임라인으로 변환 →
 * 자막 트랙에 일괄 배치(단일 undo). 진행률은 스토어 sttProgress 로 오버레이에 표시.
 */
import { genId, createSubtitleClip, createTrack } from '@shared/model/factory'
import { segmentsToPlacements, placementsToSrt, type SttModel } from '@shared/subtitles'
import type { Clip } from '@shared/model/types'
import { useEditor } from '@renderer/state/store'
import { addSubtitleClips, findClip } from '@renderer/state/commands'
import { decodePath } from '@renderer/engine/scene'

const PHASE_LABEL: Record<string, string> = {
  extract: '오디오 추출 중…',
  download: '음성인식 모델 준비 중…',
  transcribe: '자막 생성 중…',
  done: '완료'
}

export interface AutoCaptionOptions {
  model: SttModel
  language: string
}

/**
 * 선택된 클립에 자동 자막 생성. 성공 시 생성된 자막 개수 반환, 실패/취소 시 throw/0.
 */
export async function generateCaptions(clipId: string, opts: AutoCaptionOptions): Promise<number> {
  const state = useEditor.getState()
  const found = findClip(state.project, clipId)
  if (!found || found.clip.kind !== 'video' || !found.clip.assetId) {
    throw new Error('자막을 생성하려면 오디오가 있는 비디오 클립을 선택하세요')
  }
  const asset = state.project.assets.find((a) => a.id === found.clip.assetId)
  if (!asset?.hasAudio) throw new Error('이 클립에는 오디오가 없습니다')

  // STT 소스: 호환 프록시(원본 오디오를 AAC 로 재인코딩·보존) 우선, 없으면 원본.
  // 저화질 성능 프록시(perfProxyPath)는 오디오 품질이 낮아 쓰지 않는다.
  const sourcePath = asset.proxyPath ?? asset.path
  void decodePath // (프리뷰 경로 로직과 구분: STT 는 원본 오디오)

  const clip = found.clip
  const jobId = genId('stt')
  const off = window.editor.onSttProgress((p) => {
    if (p.jobId !== jobId) return
    useEditor.getState().setSttProgress({
      active: true,
      phase: PHASE_LABEL[p.phase] ?? p.phase,
      percent: p.percent,
      cancel: () => void window.editor.sttCancel(jobId)
    })
  })

  useEditor.getState().setSttProgress({ active: true, phase: PHASE_LABEL.extract, percent: 0, cancel: () => void window.editor.sttCancel(jobId) })

  try {
    const result = await window.editor.sttTranscribe({
      jobId,
      sourcePath,
      sourceIn: clip.sourceIn ?? 0,
      sourceOut: clip.sourceOut ?? asset.duration,
      speed: clip.speed ?? 1,
      model: opts.model,
      language: opts.language
    })
    if (!result.ok) {
      if (result.error === 'cancelled') return 0
      throw new Error(result.error ?? '자막 생성 실패')
    }
    const segments = result.segments ?? []
    const placements = segmentsToPlacements(segments, {
      timelineStart: clip.timelineStart,
      timelineEnd: clip.timelineEnd,
      speed: clip.speed ?? 1
    })
    if (placements.length === 0) return 0

    const height = state.project.settings.height
    const clips: Clip[] = placements.map((pl) => createSubtitleClip(pl.timelineStart, pl.timelineEnd, pl.text, height))
    useEditor.getState().dispatch('자동 자막 생성', (p) => addSubtitleClips(p, clips, createTrack('text')))
    return clips.length
  } finally {
    off()
    useEditor.getState().setSttProgress(null)
  }
}

/** 자막 트랙의 모든 텍스트 클립을 SRT 로 내보내기 (3.2.4) */
export async function exportSubtitlesSrt(): Promise<boolean> {
  const project = useEditor.getState().project
  const items = project.tracks
    .filter((t) => t.kind === 'text')
    .flatMap((t) => t.clips)
    .filter((c) => c.text?.value?.trim())
    .map((c) => ({ timelineStart: c.timelineStart, timelineEnd: c.timelineEnd, text: c.text!.value }))
  if (items.length === 0) {
    alert('내보낼 자막이 없습니다')
    return false
  }
  const srt = placementsToSrt(items)
  const path = await window.editor.saveSrtDialog(`${project.name}.srt`, srt)
  return !!path
}
