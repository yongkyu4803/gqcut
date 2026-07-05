/**
 * 무음 감지 자동 컷 오케스트레이션 — 렌더러.
 * 선택한 비디오 클립의 무음 구간을 메인에서 감지 → 타임라인 좌표로 변환 →
 * silencePreview 스토어에 채워 미리보기(적용 전, dispatch 안 함). 사용자가 후보를
 * 선택/해제한 뒤 적용하면 단일 undo 로 rippleDeleteRanges 를 실행한다.
 */
import { genId } from '@shared/model/factory'
import { mapSilenceToTimeline, mergeRanges } from '@shared/silence'
import { useEditor, type SilenceCandidate, type SilenceScope } from '@renderer/state/store'
import { findClip, rippleDeleteRanges, rippleDeleteRangesAllTracks } from '@renderer/state/commands'

export interface DetectSilenceOptions {
  noiseDb: number
  minDurationSec: number
  /** this-track(기본): 감지 트랙만 리플. all-tracks: 비디오/자막도 함께 리플, 오디오는 위치만 밀림 */
  scope?: SilenceScope
}

/** 선택된 클립의 무음 구간을 감지해 silencePreview 를 채운다. 후보 개수를 반환(0 이면 못 찾음). */
export async function detectSilence(clipId: string, opts: DetectSilenceOptions): Promise<number> {
  const state = useEditor.getState()
  const found = findClip(state.project, clipId)
  if (!found || found.clip.kind !== 'video' || !found.clip.assetId) {
    throw new Error('무음을 감지하려면 오디오가 있는 비디오 클립을 선택하세요')
  }
  const { track, clip } = found
  const asset = state.project.assets.find((a) => a.id === clip.assetId)
  if (!asset?.hasAudio) throw new Error('이 클립에는 오디오가 없습니다')

  // 무음 감지는 원본 오디오 기준 — STT 와 동일 원칙(압축 프록시로 인한 오탐 방지)
  const sourcePath = asset.proxyPath ?? asset.path

  const jobId = genId('silence')
  const off = window.editor.onSilenceProgress((p) => {
    if (p.jobId !== jobId) return
    useEditor.getState().setSilenceProgress({
      active: true,
      percent: p.percent,
      cancel: () => void window.editor.silenceCancel(jobId)
    })
  })

  useEditor.getState().setSilenceProgress({ active: true, percent: 0, cancel: () => void window.editor.silenceCancel(jobId) })

  try {
    const result = await window.editor.silenceDetect({
      jobId,
      sourcePath,
      sourceIn: clip.sourceIn ?? 0,
      sourceOut: clip.sourceOut ?? asset.duration,
      noiseDb: opts.noiseDb,
      minDurationSec: opts.minDurationSec
    })
    if (!result.ok) {
      if (result.error === 'cancelled') return 0
      throw new Error(result.error ?? '무음 감지 실패')
    }

    const intervals = result.intervals ?? []
    const ranges = mergeRanges(
      mapSilenceToTimeline(intervals, { timelineStart: clip.timelineStart, timelineEnd: clip.timelineEnd, speed: clip.speed })
    )
    if (ranges.length === 0) {
      useEditor.getState().setSilencePreview(null)
      return 0
    }

    const candidates: SilenceCandidate[] = ranges.map(([start, end]) => ({ id: genId('sc'), start, end, selected: true }))
    useEditor.getState().setSilencePreview({ trackId: track.id, clipId, scope: opts.scope ?? 'this-track', candidates })
    return candidates.length
  } finally {
    off()
    useEditor.getState().setSilenceProgress(null)
  }
}

/** 현재 미리보기에서 선택된 구간만 잘라내 단일 undo 로 적용하고 미리보기를 비운다. */
export function applySilenceCut(): void {
  const preview = useEditor.getState().silencePreview
  if (!preview) return
  const ranges: Array<[number, number]> = preview.candidates.filter((c) => c.selected).map((c) => [c.start, c.end])
  useEditor.getState().setSilencePreview(null)
  if (ranges.length === 0) return
  const trackId = preview.trackId
  useEditor
    .getState()
    .dispatch('무음 컷', (p) => (preview.scope === 'all-tracks' ? rippleDeleteRangesAllTracks(p, ranges) : rippleDeleteRanges(p, trackId, ranges)))
}

/** 미리보기만 폐기한다(프로젝트는 건드리지 않음). */
export function cancelSilencePreview(): void {
  useEditor.getState().setSilencePreview(null)
}
