/**
 * 편집 커맨드 — Project 를 받아 새 Project 를 돌려주는 순수 함수들 (불변 업데이트).
 * 히스토리 스택(undo/redo)은 store.ts 의 dispatch 가 관리한다.
 */
import type { Clip, MediaAsset, Project, Track } from '@shared/model/types'
import { snapToFrame } from '@shared/time'
import { genId } from '@shared/model/factory'
import { buildRippleRemap, mergeRanges } from '@shared/silence'
import { transitionZone } from '@shared/effects-spec'

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

const MERGE_EPS = 1e-3

/** a 가 b 바로 앞에 맞닿아 있고(같은 트랙 전제), 하나로 합쳐도 불변식이 깨지지 않는가 (분할의 역연산) */
function clipsMergeable(a: Clip, b: Clip): boolean {
  if (Math.abs(a.timelineEnd - b.timelineStart) > MERGE_EPS) return false
  if (a.kind !== b.kind) return false
  if (a.assetId !== b.assetId) return false // text 는 둘 다 undefined 라 통과
  if (a.kind === 'text' || a.kind === 'image') return true
  if ((a.speed ?? 1) !== (b.speed ?? 1)) return false
  if (a.sourceOut === undefined || b.sourceIn === undefined) return false
  return Math.abs(a.sourceOut - b.sourceIn) <= MERGE_EPS
}

/** 선택 클립이 앞/뒤 이웃과 병합 가능한가 (버튼/단축키 활성화 판정용) */
export function canMergeClip(p: Project, clipId: string): boolean {
  const found = findClip(p, clipId)
  if (!found) return false
  const sorted = sortClips(found.track.clips)
  const idx = sorted.findIndex((c) => c.id === clipId)
  const next = sorted[idx + 1]
  const prev = idx > 0 ? sorted[idx - 1] : undefined
  return Boolean((next && clipsMergeable(found.clip, next)) || (prev && clipsMergeable(prev, found.clip)))
}

/**
 * 컷 병합 — 선택 클립을 인접한(다음 우선, 없으면 이전) 이웃과 하나로 합친다.
 * 같은 트랙·같은 소스에서 맞닿아 있어야 하며(분할의 역연산), 아니면 그대로 반환한다.
 * 병합 결과는 항상 clipId 를 유지해 선택이 끊기지 않는다.
 */
export function mergeClip(p: Project, clipId: string): Project {
  const found = findClip(p, clipId)
  if (!found) return p
  const { track, clip } = found
  const sorted = sortClips(track.clips)
  const idx = sorted.findIndex((c) => c.id === clipId)
  const next = sorted[idx + 1]
  const prev = idx > 0 ? sorted[idx - 1] : undefined

  let merged: Clip
  let removeId: string
  if (next && clipsMergeable(clip, next)) {
    merged = { ...clip, timelineEnd: next.timelineEnd, sourceOut: next.sourceOut, transitionOut: next.transitionOut }
    removeId = next.id
  } else if (prev && clipsMergeable(prev, clip)) {
    merged = { ...clip, timelineStart: prev.timelineStart, sourceIn: prev.sourceIn, transitionIn: prev.transitionIn }
    removeId = prev.id
  } else {
    return p
  }

  return mapTrack(p, track.id, (t) => ({
    ...t,
    clips: sortClips(t.clips.filter((c) => c.id !== removeId).map((c) => (c.id === clipId ? merged : c)))
  }))
}

/**
 * 컷 구간을 프레임 그리드로 스냅 + 재병합.
 * 제거량을 프레임 배수로 만들어, 리플 후 클립 경계가 프레임 정렬되고 남은 survivor 의
 * (타임라인 길이)·speed 와 (소스 길이)가 정확히 일치(불변식 3)하도록 하는 전제.
 */
function snapRangesToFrame(merged: Array<[number, number]>, fps: number): Array<[number, number]> {
  const snapped = merged
    .map(([s, e]): [number, number] => [snapToFrame(s, fps), snapToFrame(e, fps)])
    .filter(([s, e]) => e - s > 1e-9)
  return mergeRanges(snapped)
}

/** 트랙 클립 배열을 병합된 삭제 구간 기준으로 재구성한다 — 전환 해제 + survivor 분할 + remap 적용 (순수 배열 변환) */
function rippleSpliceClips(clips: Clip[], merged: Array<[number, number]>, remap: (t: number) => number, fps: number): Clip[] {
  const sorted = sortClips(clips)

  // 1) 삭제 구간과 겹치는 기존 전환은 먼저 해제 (전환 존이 손상된 채로 남지 않도록)
  const clearOut = new Set<number>()
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (!a.transitionOut || Math.abs(b.timelineStart - a.timelineEnd) > 1e-3) continue
    const zone = transitionZone(a.timelineEnd, a.transitionOut.duration, a.timelineStart, b.timelineEnd)
    if (merged.some(([s, e]) => s < zone.end && e > zone.start)) clearOut.add(i)
  }
  const cleared = sorted.map((c, i) => {
    const patch: Partial<Clip> = {}
    if (clearOut.has(i)) patch.transitionOut = undefined
    if (i > 0 && clearOut.has(i - 1)) patch.transitionIn = undefined
    return Object.keys(patch).length ? { ...c, ...patch } : c
  })

  // 2) 클립마다 삭제 구간과의 교집합을 빼고 남은 survivor 구간들로 재구성
  const minLen = 1 / fps
  const rebuilt: Clip[] = []
  for (const clip of cleared) {
    const cuts = merged
      .map((r): [number, number] => [Math.max(r[0], clip.timelineStart), Math.min(r[1], clip.timelineEnd)])
      .filter(([s, e]) => e - s > 1e-6)

    const survivors: Array<[number, number]> = []
    if (cuts.length === 0) {
      survivors.push([clip.timelineStart, clip.timelineEnd])
    } else {
      let cursor = clip.timelineStart
      for (const [cs, ce] of cuts) {
        if (cs - cursor > 1e-6) survivors.push([cursor, cs])
        cursor = Math.max(cursor, ce)
      }
      if (clip.timelineEnd - cursor > 1e-6) survivors.push([cursor, clip.timelineEnd])
    }

    const kept = survivors.filter(([s, e]) => e - s >= minLen - 1e-6)
    if (kept.length === 0) continue // 클립 전체가 삭제 구간에 덮임

    const speed = clip.speed ?? 1
    const hasSource = clip.sourceIn !== undefined && clip.kind !== 'image'
    let emitted = 0
    kept.forEach(([segStart, segEnd], i) => {
      const tlStart = snapToFrame(remap(segStart), fps)
      const tlEnd = snapToFrame(remap(segEnd), fps)
      // 스냅 후 1프레임 미만이면 버린다 — 0길이 클립(불변식 2 위반) 방지
      if (tlEnd - tlStart < minLen - 1e-6) return
      const isFirst = i === 0 && Math.abs(segStart - clip.timelineStart) < 1e-6
      const isLast = i === kept.length - 1 && Math.abs(segEnd - clip.timelineEnd) < 1e-6
      // sourceIn 은 survivor 시작의 실제 소스 위치, sourceOut 은 스냅된 타임라인 길이에서 역산 →
      // sourceOut-sourceIn == (tlEnd-tlStart)·speed 가 항상 성립(불변식 3). 프레임 비정렬 무음 경계에서도 안전.
      const sourceIn = hasSource ? clip.sourceIn! + (segStart - clip.timelineStart) * speed : undefined
      rebuilt.push({
        ...clip,
        id: emitted === 0 ? clip.id : genId('clip'),
        timelineStart: tlStart,
        timelineEnd: tlEnd,
        ...(hasSource ? { sourceIn, sourceOut: sourceIn! + (tlEnd - tlStart) * speed } : {}),
        transitionIn: isFirst ? clip.transitionIn : undefined,
        transitionOut: isLast ? clip.transitionOut : undefined
      })
      emitted++
    })
  }
  return rebuilt
}

/** 트랙 클립들을 자르지 않고 위치만 민다 — 연속 재생 콘텐츠(배경음악 등)가 끊기지 않도록 클립 길이를 보존한다. */
function shiftClips(clips: Clip[], remap: (t: number) => number): Clip[] {
  return clips.map((c) => {
    const shift = c.timelineStart - remap(c.timelineStart)
    if (shift <= 1e-9) return c
    return { ...c, timelineStart: c.timelineStart - shift, timelineEnd: c.timelineEnd - shift }
  })
}

/**
 * 무음 리플 삭제 — 지정 트랙에서 여러 구간(절대 타임라인 좌표)을 한 번에 잘라내고
 * 뒤 클립들을 당겨 갭을 없앤다. 다른 트랙에는 영향을 주지 않는다(단일 트랙 전제).
 * ranges 와 겹치는 기존 전환은 먼저 해제한 뒤, 각 클립을 남은(survivor) 구간들로 재구성한다.
 */
export function rippleDeleteRanges(p: Project, trackId: string, ranges: Array<[number, number]>): Project {
  const track = p.tracks.find((t) => t.id === trackId)
  if (!track) return p
  const merged = snapRangesToFrame(mergeRanges(ranges), p.settings.fps)
  if (merged.length === 0) return p
  const remap = buildRippleRemap(merged)
  const rebuilt = rippleSpliceClips(track.clips, merged, remap, p.settings.fps)
  return mapTrack(p, trackId, (t) => ({ ...t, clips: sortClips(rebuilt) }))
}

/**
 * 무음 리플 삭제(전체 트랙 스코프) — 비디오/텍스트 트랙은 감지 트랙과 동일하게 잘라 당기고,
 * 오디오 트랙(배경음악 등 연속 재생 콘텐츠)은 잘라내지 않고 위치만 밀어 글리치를 피한다.
 */
export function rippleDeleteRangesAllTracks(p: Project, ranges: Array<[number, number]>): Project {
  const fps = p.settings.fps
  const merged = snapRangesToFrame(mergeRanges(ranges), fps)
  if (merged.length === 0) return p
  const remap = buildRippleRemap(merged)

  const newTracks = p.tracks.map((t) =>
    t.kind === 'audio'
      ? { ...t, clips: shiftClips(t.clips, remap) }
      : { ...t, clips: sortClips(rippleSpliceClips(t.clips, merged, remap, fps)) }
  )
  return touch({ ...p, tracks: newTracks })
}

export function updateClip(p: Project, clipId: string, patch: Partial<Clip>): Project {
  const found = findClip(p, clipId)
  if (!found) return p
  return mapTrack(p, found.track.id, (tr) => ({
    ...tr,
    clips: tr.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c))
  }))
}

/**
 * 여러 클립을 한 번에 갱신 (일괄 편집, phase-8). 1 dispatch = 1 undo.
 * patch 는 클립별 함수로 계산해 "바꿀 필드만" 병합한다 — 각 클립의 기존 스타일(색/폰트 등)은 보존된다.
 * (primary 클립의 text 객체 전체로 덮어쓰지 말 것. 반드시 clip 별 {...clip.text, ...변경} 형태로 반환.)
 * 존재하지 않는 id 는 무시. 실제로 바뀐 클립이 없으면 원본을 그대로 반환(no-op → 히스토리 미기록).
 */
export function updateClips(p: Project, clipIds: string[], patch: (clip: Clip) => Partial<Clip>): Project {
  const ids = new Set(clipIds)
  if (ids.size === 0) return p
  let changed = false
  const tracks = p.tracks.map((tr) => {
    if (!tr.clips.some((c) => ids.has(c.id))) return tr
    changed = true
    return { ...tr, clips: tr.clips.map((c) => (ids.has(c.id) ? { ...c, ...patch(c) } : c)) }
  })
  if (!changed) return p
  return touch({ ...p, tracks })
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

/**
 * 자막 일괄 배치 (3.2.3) — placements 를 담을 텍스트 트랙에 한 번에 넣는다(단일 undo).
 * 시간대가 비는 기존 텍스트 트랙이 있으면 재사용, 없으면 최상단에 새 트랙 생성.
 * (트랙 생성이 이 커맨드 안에서 일어나 undo 1회로 트랙+클립이 함께 롤백)
 */
export function addSubtitleClips(p: Project, clips: Clip[], newTrack: Track): Project {
  if (clips.length === 0) return p
  const sorted = sortClips(clips)
  const overlaps = (track: Track): boolean =>
    sorted.some((c) => track.clips.some((e) => c.timelineStart < e.timelineEnd && c.timelineEnd > e.timelineStart))

  const reusable = p.tracks.find((t) => t.kind === 'text' && !overlaps(t))
  if (reusable) {
    return mapTrack(p, reusable.id, (t) => ({ ...t, clips: sortClips([...t.clips, ...sorted]) }))
  }
  return touch({ ...p, tracks: [{ ...newTrack, clips: sorted }, ...p.tracks] })
}

export function updateSettings(p: Project, patch: Partial<Project['settings']>): Project {
  return touch({ ...p, settings: { ...p.settings, ...patch } })
}
