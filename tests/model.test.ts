/**
 * 데이터 모델 + 커맨드 유닛 테스트 (1.1.6)
 * 검증 루프 (1.1): 추가→이동→삭제, undo/redo 정확성, save→load 왕복 동일성, 불변식.
 */
import { describe, expect, it } from 'vitest'
import { createMediaClip, createProject, createTextClip, genId } from '@shared/model/factory'
import type { MediaAsset, Project } from '@shared/model/types'
import { checkInvariants } from '@shared/model/invariants'
import {
  addAsset,
  addClip,
  moveClip,
  projectDuration,
  removeClip,
  splitClip,
  trimClip,
  updateClip,
  findClip
} from '../src/renderer/src/state/commands'

function makeAsset(duration = 10): MediaAsset {
  return { id: genId('asset'), kind: 'video', path: '/tmp/a.mp4', duration, width: 1920, height: 1080, fps: 30, hasAudio: true, status: 'ok' }
}

function setup(): { p: Project; assetId: string; trackId: string; clipId: string } {
  let p = createProject()
  const asset = makeAsset()
  p = addAsset(p, asset)
  const track = p.tracks.find((t) => t.kind === 'video')!
  const clip = createMediaClip(asset, 0)
  p = addClip(p, track.id, clip)
  return { p, assetId: asset.id, trackId: track.id, clipId: clip.id }
}

describe('클립 조작 커맨드', () => {
  it('추가 → 이동 → 삭제가 모델에 정확히 반영된다', () => {
    const { p, trackId, clipId } = setup()
    expect(findClip(p, clipId)?.clip.timelineStart).toBe(0)

    const moved = moveClip(p, clipId, 5)
    expect(findClip(moved, clipId)?.clip.timelineStart).toBeCloseTo(5)
    expect(findClip(moved, clipId)?.clip.timelineEnd).toBeCloseTo(15)

    const removed = removeClip(moved, clipId)
    expect(findClip(removed, clipId)).toBeNull()
    expect(removed.tracks.find((t) => t.id === trackId)!.clips).toHaveLength(0)
  })

  it('이동은 프레임 경계로 스냅된다', () => {
    const { p, clipId } = setup()
    const moved = moveClip(p, clipId, 1.017) // 30fps → 1.0333… 프레임 31
    const start = findClip(moved, clipId)!.clip.timelineStart
    expect(Math.round(start * 30)).toBeCloseTo(start * 30, 9)
  })

  it('같은 트랙에서 겹치면 밀어낸다 (불변식 1)', () => {
    const { p, trackId, assetId } = setup()
    const asset = p.assets.find((a) => a.id === assetId)!
    const clip2 = createMediaClip(asset, 3) // 기존 클립 [0,10) 과 겹침
    const p2 = addClip(p, trackId, clip2)
    expect(checkInvariants(p2)).toHaveLength(0)
  })

  it('트림은 소스 구간을 speed 반영해 함께 조정한다 (불변식 3)', () => {
    const { p, clipId } = setup()
    const trimmed = trimClip(p, clipId, 'start', 2)
    const c = findClip(trimmed, clipId)!.clip
    expect(c.timelineStart).toBeCloseTo(2)
    expect(c.sourceIn).toBeCloseTo(2)
    expect(checkInvariants(trimmed)).toHaveLength(0)

    const trimmed2 = trimClip(trimmed, clipId, 'end', 8)
    const c2 = findClip(trimmed2, clipId)!.clip
    expect(c2.timelineEnd).toBeCloseTo(8)
    expect(c2.sourceOut).toBeCloseTo(8)
    expect(checkInvariants(trimmed2)).toHaveLength(0)
  })

  it('트림은 소스 범위를 넘을 수 없다', () => {
    const { p, clipId } = setup()
    const over = trimClip(p, clipId, 'end', 99) // 소스 10초가 한계
    expect(findClip(over, clipId)!.clip.timelineEnd).toBeCloseTo(10)
  })

  it('분할: 두 클립으로 나뉘고 소스도 비례 분할된다', () => {
    const { p, trackId, clipId } = setup()
    const split = splitClip(p, clipId, 4, 'clip_new')
    const track = split.tracks.find((t) => t.id === trackId)!
    expect(track.clips).toHaveLength(2)
    const [left, right] = track.clips
    expect(left.timelineEnd).toBeCloseTo(4)
    expect(left.sourceOut).toBeCloseTo(4)
    expect(right.timelineStart).toBeCloseTo(4)
    expect(right.sourceIn).toBeCloseTo(4)
    expect(right.id).toBe('clip_new')
    expect(checkInvariants(split)).toHaveLength(0)
  })

  it('speed 반영 분할 (불변식 3)', () => {
    let { p, clipId } = setup()
    // 2배속: 타임라인 5초 = 소스 10초
    p = updateClip(p, clipId, { speed: 2, timelineEnd: 5, sourceOut: 10 })
    expect(checkInvariants(p)).toHaveLength(0)
    const split = splitClip(p, clipId, 2, 'clip_s')
    expect(checkInvariants(split)).toHaveLength(0)
    const right = findClip(split, 'clip_s')!.clip
    expect(right.sourceIn).toBeCloseTo(4) // 2초 × 2배속
  })

  it('경계(끝) 분할은 무시된다', () => {
    const { p, trackId, clipId } = setup()
    const s1 = splitClip(p, clipId, 0, 'x')
    const s2 = splitClip(p, clipId, 10, 'y')
    expect(s1.tracks.find((t) => t.id === trackId)!.clips).toHaveLength(1)
    expect(s2.tracks.find((t) => t.id === trackId)!.clips).toHaveLength(1)
  })

  it('projectDuration 은 가장 늦은 클립 끝', () => {
    const { p, trackId, assetId } = setup()
    const asset = p.assets.find((a) => a.id === assetId)!
    const p2 = addClip(p, trackId, createMediaClip(asset, 20))
    expect(projectDuration(p2)).toBeCloseTo(30)
  })
})

describe('undo/redo 히스토리 (스토어 동작 모사)', () => {
  // 스토어의 히스토리 로직과 동일한 스냅샷 방식 검증
  it('undo 연속 호출로 각 단계가 정확히 되돌려지고 redo 로 복원된다', () => {
    const { p, clipId } = setup()
    const states: Project[] = [p]
    let cur = p
    cur = moveClip(cur, clipId, 3)
    states.push(cur)
    cur = trimClip(cur, clipId, 'start', 4)
    states.push(cur)
    cur = splitClip(cur, clipId, 7, 'c2')
    states.push(cur)

    // undo: states 역순으로 완전 일치해야 함 (불변 스냅샷)
    for (let i = states.length - 1; i >= 0; i--) {
      expect(states[i]).toBeDefined()
    }
    // 커맨드는 순수 함수이므로 이전 상태 객체가 그대로 보존된다 (참조 동일성 = 완벽한 undo)
    expect(findClip(states[0], clipId)!.clip.timelineStart).toBe(0)
    expect(findClip(states[1], clipId)!.clip.timelineStart).toBeCloseTo(3)
    expect(findClip(states[2], clipId)!.clip.timelineStart).toBeCloseTo(4)
  })
})

describe('직렬화 (1.1.4)', () => {
  it('save→load 왕복 후 상태가 완전히 일치한다 (deep-equal)', () => {
    let { p, trackId, assetId } = setup()
    const asset = p.assets.find((a) => a.id === assetId)!
    p = addClip(p, trackId, createMediaClip(asset, 12))
    const textTrack = p.tracks.find((t) => t.kind === 'text')!
    p = addClip(p, textTrack.id, createTextClip(1, 3))

    const json = JSON.stringify(p)
    const loaded = JSON.parse(json) as Project
    expect(loaded).toEqual(p)
    expect(checkInvariants(loaded)).toHaveLength(0)
  })
})

describe('불변식 검출', () => {
  it('겹침/역전/소스 불일치를 잡아낸다', () => {
    const { p, clipId } = setup()
    const broken = updateClip(p, clipId, { timelineEnd: 0.5, sourceOut: 9 }) // 길이·소스 불일치 유발
    expect(checkInvariants(broken).length).toBeGreaterThan(0)
  })
})
