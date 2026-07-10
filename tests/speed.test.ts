/**
 * 클립 속도 변경 유닛 (feature-4)
 *  - 불변식 3(소스길이 = 타임라인길이 × speed) 유지, 소스 구간 불변
 *  - 뒤 클립 리플(상대 간격·인접성 보존), 이미지/텍스트 no-op, 0.25~4 클램프
 *  - 전환 길이 클램프, checkInvariants 통과
 */
import { describe, expect, it } from 'vitest'
import { createMediaClip, createProject, createTextClip } from '@shared/model/factory'
import type { MediaAsset, Project, Transition } from '@shared/model/types'
import { checkInvariants } from '@shared/model/invariants'
import { addClip, findClip, setClipSpeed } from '../src/renderer/src/state/commands'

function asset(dur = 20): MediaAsset {
  return { id: 'a1', kind: 'video', path: '/tmp/v.mp4', duration: dur, status: 'ok', hasAudio: true }
}

/** 두 비디오 클립: c1[0,4) 소스[0,4), c2[gapStart, gapStart+4) */
function twoClips(gapStart = 4): { p: Project; trackId: string } {
  let p = createProject()
  const a = asset()
  p = { ...p, assets: [a] }
  const track = p.tracks.find((t) => t.kind === 'video')!
  const c1 = { ...createMediaClip(a, 0), id: 'c1', timelineStart: 0, timelineEnd: 4, sourceIn: 0, sourceOut: 4, speed: 1 }
  const c2 = { ...createMediaClip(a, gapStart), id: 'c2', timelineStart: gapStart, timelineEnd: gapStart + 4, sourceIn: 4, sourceOut: 8, speed: 1 }
  p = addClip(addClip(p, track.id, c1), track.id, c2)
  return { p, trackId: track.id }
}

describe('setClipSpeed', () => {
  it('슬로모(0.5x): 타임라인 길이 2배, 소스 불변, 뒤 클립 리플(인접 유지)', () => {
    const { p } = twoClips(4) // c1,c2 인접
    const next = setClipSpeed(p, 'c1', 0.5)
    const c1 = findClip(next, 'c1')!.clip
    expect(c1.speed).toBe(0.5)
    expect(c1.timelineEnd).toBeCloseTo(8, 6) // 4 / 0.5
    expect(c1.sourceIn).toBe(0)
    expect(c1.sourceOut).toBe(4) // 소스 불변
    // c2 는 delta(+4)만큼 밀려 여전히 인접
    const c2 = findClip(next, 'c2')!.clip
    expect(c2.timelineStart).toBeCloseTo(8, 6)
    expect(c2.timelineEnd).toBeCloseTo(12, 6)
    expect(checkInvariants(next)).toHaveLength(0)
  })

  it('패스트(2x): 길이 절반, 뒤 클립 당겨지되 간격 보존', () => {
    const { p } = twoClips(6) // c1[0,4), 간격 2s, c2[6,10)
    const next = setClipSpeed(p, 'c1', 2)
    const c1 = findClip(next, 'c1')!.clip
    expect(c1.timelineEnd).toBeCloseTo(2, 6) // 4 / 2
    const c2 = findClip(next, 'c2')!.clip
    // delta = 2 - 4 = -2 → c2 는 6-2=4 로 이동, 간격 2s 보존(c1 끝 2 → c2 시작 4)
    expect(c2.timelineStart).toBeCloseTo(4, 6)
    expect(c2.timelineEnd).toBeCloseTo(8, 6)
    expect(checkInvariants(next)).toHaveLength(0)
  })

  it('이미지/텍스트(소스 없음)는 no-op', () => {
    let p = createProject()
    const track = p.tracks.find((t) => t.kind === 'text')!
    const txt = { ...createTextClip(0, 3), id: 'tx1' }
    p = addClip(p, track.id, txt)
    expect(setClipSpeed(p, 'tx1', 2)).toBe(p)
  })

  it('0.25~4 로 클램프', () => {
    const { p } = twoClips()
    expect(findClip(setClipSpeed(p, 'c1', 100), 'c1')!.clip.speed).toBe(4)
    expect(findClip(setClipSpeed(p, 'c1', 0.01), 'c1')!.clip.speed).toBe(0.25)
  })

  it('같은 속도면 no-op(동일 참조)', () => {
    const { p } = twoClips()
    expect(setClipSpeed(p, 'c1', 1)).toBe(p)
  })

  it('전환 길이가 새 클립 길이를 넘으면 클램프', () => {
    let p = createProject()
    const a = asset()
    p = { ...p, assets: [a] }
    const track = p.tracks.find((t) => t.kind === 'video')!
    const c1 = {
      ...createMediaClip(a, 0),
      id: 'c1',
      timelineStart: 0,
      timelineEnd: 4,
      sourceIn: 0,
      sourceOut: 4,
      speed: 1,
      transitionOut: { type: 'dissolve', duration: 1.5 } as Transition
    }
    const c2 = { ...createMediaClip(a, 4), id: 'c2', timelineStart: 4, timelineEnd: 8, sourceIn: 4, sourceOut: 8, speed: 1 }
    p = addClip(addClip(p, track.id, c1), track.id, c2)
    // 4x → 길이 1s, 전환 1.5s > 1s 라 1s 로 클램프
    const next = setClipSpeed(p, 'c1', 4)
    const c1n = findClip(next, 'c1')!.clip
    expect(c1n.timelineEnd).toBeCloseTo(1, 6)
    expect(c1n.transitionOut?.duration).toBeCloseTo(1, 6)
    expect(checkInvariants(next)).toHaveLength(0)
  })
})
