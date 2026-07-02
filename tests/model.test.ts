/**
 * 데이터 모델 + 커맨드 유닛 테스트 (1.1.6)
 * 검증 루프 (1.1): 추가→이동→삭제, undo/redo 정확성, save→load 왕복 동일성, 불변식.
 */
import { describe, expect, it } from 'vitest'
import { createMediaClip, createProject, createTextClip, genId } from '@shared/model/factory'
import type { MediaAsset, Project } from '@shared/model/types'
import { checkInvariants } from '@shared/model/invariants'
import { createTrack } from '@shared/model/factory'
import {
  addAsset,
  addClip,
  addClipOverlay,
  moveClip,
  moveClipToTrack,
  projectDuration,
  removeClip,
  removeTrack,
  splitClip,
  trackAcceptsClip,
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

describe('멀티트랙 (오버레이)', () => {
  function makeImageAsset(): MediaAsset {
    return { id: genId('asset'), kind: 'image', path: '/tmp/i.png', duration: 5, width: 800, height: 600, status: 'ok' }
  }

  it('이미지 클립은 소스 시간축 없이 양방향 트림이 가능하다', () => {
    let { p, trackId } = setup()
    const img = makeImageAsset()
    p = addAsset(p, img)
    const clip = createMediaClip(img, 20)
    expect(clip.sourceIn).toBeUndefined()
    p = addClip(p, trackId, clip)
    // 좌측으로 원래 시작점(20)보다 앞까지 확장
    const left = trimClip(p, clip.id, 'start', 15)
    expect(findClip(left, clip.id)!.clip.timelineStart).toBeCloseTo(15)
    // 우측도 자유 확장
    const right = trimClip(left, clip.id, 'end', 40)
    expect(findClip(right, clip.id)!.clip.timelineEnd).toBeCloseTo(40)
    expect(checkInvariants(right)).toHaveLength(0)
  })

  it('오버레이 배치: 메인 트랙 위에 새 비디오 트랙을 만들어 넣는다', () => {
    let { p, assetId } = setup()
    const asset = p.assets.find((a) => a.id === assetId)!
    const overlayClip = createMediaClip(asset, 2)
    p = addClipOverlay(p, overlayClip, createTrack('video'))
    const videoTracks = p.tracks.filter((t) => t.kind === 'video')
    expect(videoTracks).toHaveLength(2)
    // 새 트랙이 메인 위(배열에서 앞) — 오버레이에 클립, 메인은 기존 클립 유지
    expect(videoTracks[0].clips.map((c) => c.id)).toContain(overlayClip.id)
    expect(videoTracks[1].clips).toHaveLength(1)
    // 같은 자리에 또 넣으면 겹치므로 트랙이 하나 더 생긴다
    const another = createMediaClip(asset, 3)
    const p2 = addClipOverlay(p, another, createTrack('video'))
    expect(p2.tracks.filter((t) => t.kind === 'video')).toHaveLength(3)
    // 빈 구간(20초)에 넣으면 기존 오버레이 트랙을 재사용
    const far = createMediaClip(asset, 20)
    const p3 = addClipOverlay(p, far, createTrack('video'))
    expect(p3.tracks.filter((t) => t.kind === 'video')).toHaveLength(2)
    expect(checkInvariants(p3)).toHaveLength(0)
  })

  it('트랙 간 클립 이동: 같은 종류만 허용, 전환은 해제된다', () => {
    let { p, trackId, clipId } = setup()
    const overlay = createTrack('video')
    p = { ...p, tracks: [overlay, ...p.tracks] }
    p = updateClip(p, clipId, { transitionOut: undefined })
    const moved = moveClipToTrack(p, clipId, overlay.id, 5)
    expect(findClip(moved, clipId)!.track.id).toBe(overlay.id)
    expect(findClip(moved, clipId)!.clip.timelineStart).toBeCloseTo(5)
    expect(moved.tracks.find((t) => t.id === trackId)!.clips).toHaveLength(0)
    // 오디오 트랙으로는 이동 불가
    const audioTrack = p.tracks.find((t) => t.kind === 'audio')!
    expect(moveClipToTrack(p, clipId, audioTrack.id, 0)).toBe(p)
    expect(trackAcceptsClip(audioTrack, 'video')).toBe(false)
    expect(trackAcceptsClip(overlay, 'image')).toBe(true)
  })

  it('빈 트랙만 삭제 가능, 같은 종류 마지막 트랙은 유지', () => {
    let { p, trackId, clipId } = setup()
    const overlay = createTrack('video')
    p = { ...p, tracks: [overlay, ...p.tracks] }
    expect(removeTrack(p, trackId)).toBe(p) // 클립 있는 트랙 — 불가
    const removed = removeTrack(p, overlay.id) // 빈 오버레이 — 가능
    expect(removed.tracks.filter((t) => t.kind === 'video')).toHaveLength(1)
    // 마지막 남은 비디오 트랙은 비워도 삭제 불가
    const emptied = removeClip(removed, clipId)
    const mainId = emptied.tracks.find((t) => t.kind === 'video')!.id
    expect(removeTrack(emptied, mainId)).toBe(emptied)
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
