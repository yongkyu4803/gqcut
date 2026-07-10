/**
 * Zustand 스토어 — SSOT(Project) + 커맨드 히스토리(undo/redo) + UI 상태.
 * 모든 편집 조작은 dispatch(label, fn) 로 들어와 히스토리에 쌓인다.
 * (커맨드의 execute/undo 는 불변 스냅샷 참조로 구현 — 구조 공유라 메모리 부담 낮음)
 */
import { create } from 'zustand'
import type { Project } from '@shared/model/types'
import { createProject } from '@shared/model/factory'
import { assertInvariants } from '@shared/model/invariants'

export interface HistoryEntry {
  label: string
  before: Project
  after: Project
}

/** 무음 감지 후보 구간 (미리보기, 히스토리 비대상) — 절대 타임라인 좌표 */
export interface SilenceCandidate {
  id: string
  start: number
  end: number
  selected: boolean
}

/** 적용 범위 — this-track: 감지 트랙만 리플. all-tracks: 비디오/자막도 함께 리플하되 오디오(배경음악)는 위치만 민다 */
export type SilenceScope = 'this-track' | 'all-tracks'

export interface SilencePreview {
  trackId: string
  clipId: string
  scope: SilenceScope
  candidates: SilenceCandidate[]
  /** AI 가 감지한 경우 그 실행(run)의 requestId — 같은 응답 안에서 감지·적용 연쇄를 막는 데 쓴다(7.4). 수동 감지는 undefined. */
  detectedByAiRequest?: string
}

export interface EditorState {
  project: Project
  past: HistoryEntry[]
  future: HistoryEntry[]

  // UI 상태 (히스토리 비대상)
  /** 선택된 클립 id 목록(클릭 순서 유지, 마지막 = primary). 다중 선택의 SSOT. */
  selectedClipIds: string[]
  /** primary(마지막 클릭) 클립 — selectedClipIds.at(-1). 단일 선택 소비처 호환용으로 항상 동기화. */
  selectedClipId: string | null
  playhead: number
  playing: boolean
  pxPerSec: number
  exportProgress: { active: boolean; percent: number; cancel?: () => void } | null
  proxyJobs: Record<string, number> // assetId -> percent
  projectPath: string | null // 현재 프로젝트 파일 경로 (6.1)
  savedRevision: number // 마지막 저장 시점의 히스토리 길이 (더티 판정)
  sttProgress: { active: boolean; phase: string; percent: number; cancel?: () => void } | null // 자동 자막 (3.2)
  silenceProgress: { active: boolean; percent: number; cancel?: () => void } | null // 무음 감지 진행 중
  silencePreview: SilencePreview | null // 무음 감지 결과 미리보기(적용 전) — 히스토리 비대상

  dispatch(label: string, fn: (p: Project) => Project): void
  undo(): void
  redo(): void
  replaceProject(p: Project): void

  /** 단일 선택으로 교체(null = 해제) */
  select(clipId: string | null): void
  /** ⌘/Ctrl+클릭 — 이미 선택돼 있으면 제거, 아니면 primary 로 추가 */
  toggleSelect(clipId: string): void
  /** Shift+클릭 — primary 앵커와 clipId 사이(같은 트랙, timelineStart 순)를 범위 선택 */
  selectRangeTo(clipId: string): void
  /** 전체 선택 해제 */
  clearSelection(): void
  setPlayhead(t: number): void
  setPlaying(playing: boolean): void
  setZoom(pxPerSec: number): void
  setExportProgress(p: EditorState['exportProgress']): void
  setProxyProgress(assetId: string, percent: number | null): void
  setProjectPath(path: string | null): void
  markSaved(): void
  setSttProgress(p: EditorState['sttProgress']): void
  setSilenceProgress(p: EditorState['silenceProgress']): void
  setSilencePreview(p: SilencePreview | null): void
  toggleSilenceCandidate(id: string): void
}

const MAX_HISTORY = 200

function findClipId(project: Project, clipId: string): boolean {
  for (const t of project.tracks) if (t.clips.some((c) => c.id === clipId)) return true
  return false
}

function findClipCtx(project: Project, clipId: string): { trackId: string; track: Project['tracks'][number] } | null {
  for (const t of project.tracks) if (t.clips.some((c) => c.id === clipId)) return { trackId: t.id, track: t }
  return null
}

/** selectedClipIds 정규화: 중복 제거 + 프로젝트에 실제 존재하는 id 만 유지 + primary(마지막) 파생 */
function normalizeSelection(project: Project, ids: string[]): { selectedClipIds: string[]; selectedClipId: string | null } {
  const present = new Set<string>()
  for (const t of project.tracks) for (const c of t.clips) present.add(c.id)
  const seen = new Set<string>()
  const filtered: string[] = []
  for (const id of ids) {
    if (present.has(id) && !seen.has(id)) {
      seen.add(id)
      filtered.push(id)
    }
  }
  return { selectedClipIds: filtered, selectedClipId: filtered.at(-1) ?? null }
}

export const useEditor = create<EditorState>((set, get) => ({
  project: createProject(),
  past: [],
  future: [],

  selectedClipIds: [],
  selectedClipId: null,
  playhead: 0,
  playing: false,
  pxPerSec: 80,
  exportProgress: null,
  proxyJobs: {},
  projectPath: null,
  savedRevision: 0,
  sttProgress: null,
  silenceProgress: null,
  silencePreview: null,

  dispatch(label, fn) {
    const before = get().project
    const after = fn(before)
    if (after === before) return
    if (import.meta.env.DEV) assertInvariants(after, label)
    // 프로젝트가 바뀌면 무음 미리보기 좌표가 낡으므로 무효화 (감지 후 편집 → 엉뚱한 구간 컷 방지)
    set((s) => ({
      project: after,
      past: [...s.past.slice(-MAX_HISTORY + 1), { label, before, after }],
      future: [],
      silencePreview: null,
      // 편집으로 사라진 클립(리플 삭제·병합 등)이 선택에 남지 않도록 프루닝
      ...normalizeSelection(after, s.selectedClipIds)
    }))
  },

  undo() {
    const { past } = get()
    if (past.length === 0) return
    const entry = past[past.length - 1]
    set((s) => ({
      project: entry.before,
      past: s.past.slice(0, -1),
      future: [entry, ...s.future],
      silencePreview: null,
      ...normalizeSelection(entry.before, s.selectedClipIds)
    }))
  },

  redo() {
    const { future } = get()
    if (future.length === 0) return
    const entry = future[0]
    set((s) => ({
      project: entry.after,
      past: [...s.past, entry],
      future: s.future.slice(1),
      silencePreview: null,
      ...normalizeSelection(entry.after, s.selectedClipIds)
    }))
  },

  replaceProject(p) {
    set({ project: p, past: [], future: [], selectedClipIds: [], selectedClipId: null, playhead: 0, savedRevision: 0, silencePreview: null })
  },

  select: (clipId) => set(() => ({ selectedClipIds: clipId ? [clipId] : [], selectedClipId: clipId })),
  toggleSelect: (clipId) =>
    set((s) => {
      if (!findClipId(s.project, clipId)) return {}
      const has = s.selectedClipIds.includes(clipId)
      const ids = has ? s.selectedClipIds.filter((id) => id !== clipId) : [...s.selectedClipIds, clipId]
      return normalizeSelection(s.project, ids)
    }),
  selectRangeTo: (clipId) =>
    set((s) => {
      const target = findClipCtx(s.project, clipId)
      if (!target) return {}
      const anchorId = s.selectedClipId
      const anchor = anchorId ? findClipCtx(s.project, anchorId) : null
      // 앵커가 없거나 다른 트랙이면 단일 선택으로 축소
      if (!anchor || anchor.trackId !== target.trackId) return { selectedClipIds: [clipId], selectedClipId: clipId }
      const sorted = [...anchor.track.clips].sort((a, b) => a.timelineStart - b.timelineStart)
      const i1 = sorted.findIndex((c) => c.id === anchorId)
      const i2 = sorted.findIndex((c) => c.id === clipId)
      const [lo, hi] = i1 <= i2 ? [i1, i2] : [i2, i1]
      const range = sorted.slice(lo, hi + 1).map((c) => c.id)
      // primary(앵커)를 마지막에 두어 이후 범위 선택의 기준을 유지
      const ordered = anchorId && range.includes(anchorId) ? [...range.filter((id) => id !== anchorId), anchorId] : range
      return normalizeSelection(s.project, ordered)
    }),
  clearSelection: () => set({ selectedClipIds: [], selectedClipId: null }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (playing) => set({ playing }),
  setZoom: (pxPerSec) => set({ pxPerSec: Math.min(1000, Math.max(4, pxPerSec)) }),
  setExportProgress: (p) => set({ exportProgress: p }),
  setProxyProgress: (assetId, percent) =>
    set((s) => {
      const jobs = { ...s.proxyJobs }
      if (percent === null) delete jobs[assetId]
      else jobs[assetId] = percent
      return { proxyJobs: jobs }
    }),
  setProjectPath: (path) => set({ projectPath: path }),
  markSaved: () => set((s) => ({ savedRevision: s.past.length })),
  setSttProgress: (p) => set({ sttProgress: p }),
  setSilenceProgress: (p) => set({ silenceProgress: p }),
  setSilencePreview: (p) => set({ silencePreview: p }),
  toggleSilenceCandidate: (id) =>
    set((s) => {
      if (!s.silencePreview) return {}
      return {
        silencePreview: {
          ...s.silencePreview,
          candidates: s.silencePreview.candidates.map((c) => (c.id === id ? { ...c, selected: !c.selected } : c))
        }
      }
    })
}))

/** 프로젝트 직렬화 (1.1.4) */
export function serializeProject(p: Project): string {
  return JSON.stringify(p, null, 2)
}

export function deserializeProject(json: string): Project {
  const p = JSON.parse(json) as Project
  if (typeof p.schemaVersion !== 'number') throw new Error('프로젝트 파일이 아닙니다')
  // schemaVersion 마이그레이션 체인 지점 (현재 v1 단일)
  return p
}
