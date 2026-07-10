/**
 * 프로젝트 상태 요약기 (7.2.2) — LLM 에 보낼 토큰 절약형 스냅샷.
 * 순수 함수(Project + UI 상태 → 평이한 객체). main/renderer/테스트가 공유한다.
 *
 * 원칙: 모델이 편집 도구를 정확히 호출하는 데 필요한 최소 정보만.
 *  - 자산/트랙/클립의 id·종류·시간·라벨·핵심 속성
 *  - 시간은 초(소수 2자리)로 반올림 — 프레임 스냅/불변식은 커맨드가 흡수하므로 대략값이면 충분
 *  - 원본 경로 전체 대신 파일명만(프라이버시 + 토큰 절약)
 */
import type { Clip, Project, Track } from './model/types'

export interface UiState {
  selectedClipId: string | null
  /** 다중 선택 목록 (없으면 selectedClipId 로 대체) */
  selectedClipIds?: string[]
  playhead: number
}

export interface ClipSummary {
  id: string
  kind: Clip['kind']
  label: string
  start: number
  end: number
  speed?: number
  volume?: number
  fadeIn?: number
  fadeOut?: number
  effects?: string[]
  transitionOut?: string
  /** 전환 효과음 id (있을 때만) */
  transitionSound?: string
  selected?: boolean
}

export interface TrackSummary {
  id: string
  kind: Track['kind']
  muted?: boolean
  hidden?: boolean
  clips: ClipSummary[]
}

export interface ProjectSummary {
  name: string
  resolution: string
  fps: number
  durationSec: number
  playheadSec: number
  selectedClipId: string | null
  /** 다중 선택된 클립 id 목록 */
  selectedClipIds: string[]
  assets: Array<{ id: string; kind: string; name: string; durationSec: number }>
  tracks: TrackSummary[]
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function baseName(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

function clipLabel(clip: Clip, assetNames: Map<string, string>): string {
  if (clip.kind === 'text') {
    const v = (clip.text?.value ?? '').replace(/\s+/g, ' ').trim()
    return v.length > 24 ? `${v.slice(0, 24)}…` : v || '(빈 텍스트)'
  }
  return clip.assetId ? (assetNames.get(clip.assetId) ?? clip.kind) : clip.kind
}

export function summarizeProject(project: Project, ui: UiState): ProjectSummary {
  const assetNames = new Map(project.assets.map((a) => [a.id, baseName(a.path)]))
  let duration = 0
  for (const t of project.tracks) for (const c of t.clips) duration = Math.max(duration, c.timelineEnd)

  const selectedIds = ui.selectedClipIds ?? (ui.selectedClipId ? [ui.selectedClipId] : [])
  const selectedSet = new Set(selectedIds)

  return {
    name: project.name,
    resolution: `${project.settings.width}x${project.settings.height}`,
    fps: project.settings.fps,
    durationSec: round2(duration),
    playheadSec: round2(ui.playhead),
    selectedClipId: ui.selectedClipId,
    selectedClipIds: selectedIds,
    assets: project.assets.map((a) => ({
      id: a.id,
      kind: a.kind,
      name: baseName(a.path),
      durationSec: round2(a.duration)
    })),
    tracks: project.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      ...(t.muted ? { muted: true } : {}),
      ...(t.hidden ? { hidden: true } : {}),
      clips: [...t.clips]
        .sort((a, b) => a.timelineStart - b.timelineStart)
        .map((c): ClipSummary => ({
          id: c.id,
          kind: c.kind,
          label: clipLabel(c, assetNames),
          start: round2(c.timelineStart),
          end: round2(c.timelineEnd),
          ...(c.speed !== undefined && c.speed !== 1 ? { speed: c.speed } : {}),
          ...(c.volume !== undefined && c.volume !== 1 ? { volume: round2(c.volume) } : {}),
          ...(c.fadeIn ? { fadeIn: round2(c.fadeIn) } : {}),
          ...(c.fadeOut ? { fadeOut: round2(c.fadeOut) } : {}),
          ...(c.effects && c.effects.length ? { effects: c.effects.filter((e) => e.enabled).map((e) => e.type) } : {}),
          ...(c.transitionOut ? { transitionOut: c.transitionOut.type } : {}),
          ...(c.transitionOut?.sound ? { transitionSound: c.transitionOut.sound.id } : {}),
          ...(selectedSet.has(c.id) ? { selected: true } : {})
        }))
    }))
  }
}
