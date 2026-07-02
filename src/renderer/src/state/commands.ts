/**
 * 편집 커맨드 — Project 를 받아 새 Project 를 돌려주는 순수 함수들 (불변 업데이트).
 * 히스토리 스택(undo/redo)은 store.ts 의 dispatch 가 관리한다.
 */
import type { Clip, MediaAsset, Project, Track } from '@shared/model/types'
import { snapToFrame } from '@shared/time'

function touch(p: Project): Project {
  return { ...p, updatedAt: new Date().toISOString() }
}

function mapTrack(p: Project, trackId: string, fn: (t: Track) => Track): Project {
  return touch({ ...p, tracks: p.tracks.map((t) => (t.id === trackId ? fn(t) : t)) })
}

function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.timelineStart - b.timelineStart)
}

export function findClip(p: Project, clipId: string): { track: Track; clip: Clip } | null {
  for (const track of p.tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip) return { track, clip }
  }
  return null
}

export function projectDuration(p: Project): number {
  let end = 0
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, c.timelineEnd)
  return end
}

export function addAsset(p: Project, asset: MediaAsset): Project {
  return touch({ ...p, assets: [...p.assets, asset] })
}

export function updateAsset(p: Project, assetId: string, patch: Partial<MediaAsset>): Project {
  return touch({ ...p, assets: p.assets.map((a) => (a.id === assetId ? { ...a, ...patch } : a)) })
}

/** 같은 트랙 내 겹침 방지: [start, start+len) 이 이웃과 겹치면 가장 가까운 빈 자리로 클램프 */
function clampPlacement(track: Track, excludeClipId: string | null, start: number, len: number): number {
  const others = sortClips(track.clips.filter((c) => c.id !== excludeClipId))
  let s = Math.max(0, start)
  for (const o of others) {
    const overlaps = s < o.timelineEnd && s + len > o.timelineStart
    if (overlaps) {
      // 겹친 클립의 앞/뒤 중 가까운 쪽으로 밀어낸다
      const before = o.timelineStart - len
      const after = o.timelineEnd
      s = before >= 0 && Math.abs(before - start) <= Math.abs(after - start) ? before : after
    }
  }
  // 밀어낸 자리가 또 겹치면 맨 끝으로
  const stillOverlap = others.some((o) => s < o.timelineEnd && s + len > o.timelineStart)
  if (stillOverlap) s = others.length ? Math.max(...others.map((o) => o.timelineEnd)) : 0
  return s
}

export function addClip(p: Project, trackId: string, clip: Clip): Project {
  return mapTrack(p, trackId, (t) => {
    const len = clip.timelineEnd - clip.timelineStart
    const start = clampPlacement(t, null, clip.timelineStart, len)
    const placed = { ...clip, timelineStart: start, timelineEnd: start + len }
    return { ...t, clips: sortClips([...t.clips, placed]) }
  })
}

export function removeClip(p: Project, clipId: string): Project {
  return touch({
    ...p,
    tracks: p.tracks.map((t) =>
      t.clips.some((c) => c.id === clipId) ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) } : t
    )
  })
}

/** 클립 이동 (같은 트랙 내). fps 프레임 경계로 스냅. */
export function moveClip(p: Project, clipId: string, newStart: number): Project {
  const found = findClip(p, clipId)
  if (!found) return p
  const { track, clip } = found
  const len = clip.timelineEnd - clip.timelineStart
  const snapped = snapToFrame(Math.max(0, newStart), p.settings.fps)
  const start = clampPlacement(track, clipId, snapped, len)
  return mapTrack(p, track.id, (t) => ({
    ...t,
    clips: sortClips(t.clips.map((c) => (c.id === clipId ? { ...c, timelineStart: start, timelineEnd: start + len } : c)))
  }))
}

/**
 * 트림: edge='start'|'end' 를 newTime 으로. 소스 구간(sourceIn/Out)도 speed 반영해 함께 조정.
 * 소스 범위·이웃 클립·최소 길이(1프레임)로 클램프.
 */
export function trimClip(p: Project, clipId: string, edge: 'start' | 'end', newTime: number): Project {
  const found = findClip(p, clipId)
  if (!found) return p
  const { track, clip } = found
  const fps = p.settings.fps
  const speed = clip.speed ?? 1
  const minLen = 1 / fps
  const others = sortClips(track.clips.filter((c) => c.id !== clipId))
  const prev = others.filter((c) => c.timelineEnd <= clip.timelineStart + 1e-9).pop()
  const next = others.find((c) => c.timelineStart >= clip.timelineEnd - 1e-9)

  let t = snapToFrame(newTime, fps)
  let updated: Clip
  if (edge === 'start') {
    const min = Math.max(prev ? prev.timelineEnd : 0, clip.sourceIn !== undefined ? clip.timelineStart - clip.sourceIn / speed : 0)
    const max = clip.timelineEnd - minLen
    t = Math.min(Math.max(t, min), max)
    const delta = t - clip.timelineStart
    updated = {
      ...clip,
      timelineStart: t,
      ...(clip.sourceIn !== undefined ? { sourceIn: clip.sourceIn + delta * speed } : {})
    }
  } else {
    const asset = clip.assetId ? p.assets.find((a) => a.id === clip.assetId) : undefined
    const srcMax =
      clip.sourceOut !== undefined && asset && clip.kind !== 'image'
        ? clip.timelineEnd + (asset.duration - clip.sourceOut) / speed
        : Infinity
    const min = clip.timelineStart + minLen
    const max = Math.min(next ? next.timelineStart : Infinity, srcMax)
    t = Math.min(Math.max(t, min), max)
    const delta = t - clip.timelineEnd
    updated = {
      ...clip,
      timelineEnd: t,
      ...(clip.sourceOut !== undefined ? { sourceOut: clip.sourceOut + delta * speed } : {})
    }
  }
  return mapTrack(p, track.id, (tr) => ({
    ...tr,
    clips: sortClips(tr.clips.map((c) => (c.id === clipId ? updated : c)))
  }))
}

/** 플레이헤드 분할: 클립을 t 에서 두 개로. 소스도 비례 분할. */
export function splitClip(p: Project, clipId: string, atTime: number, newId: string): Project {
  const found = findClip(p, clipId)
  if (!found) return p
  const { track, clip } = found
  const fps = p.settings.fps
  const t = snapToFrame(atTime, fps)
  if (t <= clip.timelineStart + 1 / fps / 2 || t >= clip.timelineEnd - 1 / fps / 2) return p

  const speed = clip.speed ?? 1
  const srcSplit = clip.sourceIn !== undefined ? clip.sourceIn + (t - clip.timelineStart) * speed : undefined
  const left: Clip = {
    ...clip,
    timelineEnd: t,
    ...(srcSplit !== undefined ? { sourceOut: srcSplit } : {}),
    transitionOut: undefined
  }
  const right: Clip = {
    ...clip,
    id: newId,
    timelineStart: t,
    ...(srcSplit !== undefined ? { sourceIn: srcSplit } : {}),
    transitionIn: undefined
  }
  return mapTrack(p, track.id, (tr) => ({
    ...tr,
    clips: sortClips(tr.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c])))
  }))
}

export function updateClip(p: Project, clipId: string, patch: Partial<Clip>): Project {
  const found = findClip(p, clipId)
  if (!found) return p
  return mapTrack(p, found.track.id, (tr) => ({
    ...tr,
    clips: tr.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c))
  }))
}

export function updateTrack(p: Project, trackId: string, patch: Partial<Track>): Project {
  return mapTrack(p, trackId, (t) => ({ ...t, ...patch }))
}

export function addTrack(p: Project, track: Track, index?: number): Project {
  const tracks = [...p.tracks]
  tracks.splice(index ?? tracks.length, 0, track)
  return touch({ ...p, tracks })
}

/** 빈 트랙 삭제 — 같은 종류의 마지막 트랙은 유지 (UI 가정 보호) */
export function removeTrack(p: Project, trackId: string): Project {
  const track = p.tracks.find((t) => t.id === trackId)
  if (!track || track.clips.length > 0) return p
  if (p.tracks.filter((t) => t.kind === track.kind).length <= 1) return p
  return touch({ ...p, tracks: p.tracks.filter((t) => t.id !== trackId) })
}

/** 트랙이 이 클립 종류를 받을 수 있는가 (비디오 트랙은 이미지도 수용) */
export function trackAcceptsClip(track: Track, clipKind: Clip['kind']): boolean {
  if (track.kind === 'video') return clipKind === 'video' || clipKind === 'image'
  return track.kind === clipKind
}

/** 클립을 다른 트랙으로 이동 (타임라인 세로 드래그) */
export function moveClipToTrack(p: Project, clipId: string, targetTrackId: string, newStart: number): Project {
  const found = findClip(p, clipId)
  const target = p.tracks.find((t) => t.id === targetTrackId)
  if (!found || !target) return p
  if (found.track.id === targetTrackId) return moveClip(p, clipId, newStart)
  if (!trackAcceptsClip(target, found.clip.kind)) return p

  const len = found.clip.timelineEnd - found.clip.timelineStart
  const snapped = snapToFrame(Math.max(0, newStart), p.settings.fps)
  const start = clampPlacement(target, null, snapped, len)
  const moved: Clip = {
    ...found.clip,
    timelineStart: start,
    timelineEnd: start + len,
    // 전환은 원래 트랙의 인접 관계에 종속 — 이동 시 해제 (불변식 6)
    transitionIn: undefined,
    transitionOut: undefined
  }
  return touch({
    ...p,
    tracks: p.tracks.map((t) =>
      t.id === found.track.id
        ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) }
        : t.id === targetTrackId
          ? { ...t, clips: sortClips([...t.clips, moved]) }
          : t
    )
  })
}

/**
 * 오버레이 배치 (CapCut 스타일 멀티트랙): 메인(최하단) 비디오 트랙 위의 오버레이 트랙 중
 * 해당 구간이 빈 곳을 찾아 넣고, 없으면 메인 바로 위에 새 비디오 트랙을 만들어 배치한다.
 */
export function addClipOverlay(p: Project, clip: Clip, newTrack: Track): Project {
  const videoIdx = p.tracks.map((t, i) => ({ t, i })).filter((x) => x.t.kind === 'video')
  const mainIdx = videoIdx.length > 0 ? videoIdx[videoIdx.length - 1].i : p.tracks.length

  // 메인에 가까운 오버레이부터 빈 자리 탐색 (tracks[0]=최상위 레이어)
  const overlays = videoIdx.slice(0, -1).reverse()
  for (const { t } of overlays) {
    const collides = t.clips.some((c) => clip.timelineStart < c.timelineEnd && clip.timelineEnd > c.timelineStart)
    if (!collides) return addClip(p, t.id, clip)
  }
  // 빈 오버레이가 없으면 메인 바로 위에 새 트랙을 만들어 배치
  const withTrack = addTrack(p, newTrack, mainIdx)
  return addClip(withTrack, newTrack.id, clip)
}

export function updateSettings(p: Project, patch: Partial<Project['settings']>): Project {
  return touch({ ...p, settings: { ...p.settings, ...patch } })
}
