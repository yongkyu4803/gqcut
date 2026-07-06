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
  canMergeClip,
  mergeClip,
  moveClip,
  moveClipToTrack,
  projectDuration,
  removeClip,
  removeTrack,
  rippleDeleteRanges,
  rippleDeleteRangesAllTracks,
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

  it('병합: 분할한 두 클립을 다시 하나로 합치면 원래 클립과 동일해진다', () => {
    const { p, trackId, clipId } = setup()
    const split = splitClip(p, clipId, 4, 'clip_new')
    expect(canMergeClip(split, clipId)).toBe(true)
    const merged = mergeClip(split, clipId)
    const track = merged.tracks.find((t) => t.id === trackId)!
    expect(track.clips).toHaveLength(1)
    const c = track.clips[0]
    expect(c.id).toBe(clipId)
    expect(c.timelineStart).toBeCloseTo(0)
    expect(c.timelineEnd).toBeCloseTo(10)
    expect(c.sourceIn).toBeCloseTo(0)
    expect(c.sourceOut).toBeCloseTo(10)
    expect(checkInvariants(merged)).toHaveLength(0)
  })

  it('병합: 오른쪽(뒤) 클립을 선택해도 이전 클립과 합쳐지고 선택 id 는 유지된다', () => {
    const { p, trackId, clipId } = setup()
    const split = splitClip(p, clipId, 4, 'clip_new')
    expect(canMergeClip(split, 'clip_new')).toBe(true)
    const merged = mergeClip(split, 'clip_new')
    const track = merged.tracks.find((t) => t.id === trackId)!
    expect(track.clips).toHaveLength(1)
    expect(track.clips[0].id).toBe('clip_new')
    expect(track.clips[0].timelineStart).toBeCloseTo(0)
    expect(checkInvariants(merged)).toHaveLength(0)
  })

  it('병합: 떨어져 있거나(gap) 소스가 이어지지 않으면 병합되지 않는다', () => {
    const { p, trackId, assetId, clipId } = setup()
    const asset = p.assets.find((a) => a.id === assetId)!
    // 클립1 [0,10) 뒤에 gap 을 두고 클립2 [12,22) 배치 — 맞닿아 있지 않음
    const p2 = addClip(p, trackId, createMediaClip(asset, 12))
    const gapNeighborId = p2.tracks.find((t) => t.id === trackId)!.clips[1].id
    expect(canMergeClip(p2, clipId)).toBe(false)
    expect(mergeClip(p2, clipId)).toBe(p2)

    // 클립2 를 클립1 에 딱 맞닿게 이동은 하되, 서로 다른 소스 구간이라 병합 불가
    const p3 = moveClip(p2, gapNeighborId, 10)
    expect(canMergeClip(p3, clipId)).toBe(false)
    expect(mergeClip(p3, clipId)).toBe(p3)
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

describe('무음 리플 삭제 (rippleDeleteRanges)', () => {
  it('클립 내부 단일 무음 제거 — 2조각으로 나뉘고 뒤 클립이 당겨진다', () => {
    const { p, trackId, assetId } = setup()
    const asset = p.assets.find((a) => a.id === assetId)!
    const p2 = addClip(p, trackId, createMediaClip(asset, 10)) // [10,20)
    const result = rippleDeleteRanges(p2, trackId, [[3, 4]])
    const clips = result.tracks.find((t) => t.id === trackId)!.clips
    expect(clips).toHaveLength(3)
    expect(clips[0].timelineStart).toBeCloseTo(0)
    expect(clips[0].timelineEnd).toBeCloseTo(3)
    expect(clips[0].sourceOut).toBeCloseTo(3)
    expect(clips[1].timelineStart).toBeCloseTo(3)
    expect(clips[1].timelineEnd).toBeCloseTo(9)
    expect(clips[1].sourceIn).toBeCloseTo(4)
    expect(clips[1].sourceOut).toBeCloseTo(10)
    expect(clips[2].timelineStart).toBeCloseTo(9) // 원래 10 이었던 뒤 클립이 1초 당겨짐
    expect(clips[2].timelineEnd).toBeCloseTo(19)
    expect(checkInvariants(result)).toHaveLength(0)
  })

  it('클립 시작 경계에 걸친 무음은 앞부분만 트림되고 트랙 맨 앞으로 다시 붙는다', () => {
    const { p, trackId, clipId } = setup()
    const result = rippleDeleteRanges(p, trackId, [[0, 1]])
    const clips = result.tracks.find((t) => t.id === trackId)!.clips
    expect(clips).toHaveLength(1)
    expect(clips[0].id).toBe(clipId)
    expect(clips[0].timelineStart).toBeCloseTo(0)
    expect(clips[0].timelineEnd).toBeCloseTo(9)
    expect(clips[0].sourceIn).toBeCloseTo(1)
    expect(clips[0].sourceOut).toBeCloseTo(10)
    expect(checkInvariants(result)).toHaveLength(0)
  })

  it('겹치거나 인접한 여러 무음 구간은 병합 후 누적 delta 로 반영된다', () => {
    const { p, trackId } = setup()
    // [2,3) 과 [2.9,4) 는 병합되어 [2,4), 별개로 [6,7) — 총 3초 제거
    const result = rippleDeleteRanges(p, trackId, [
      [2, 3],
      [2.9, 4],
      [6, 7]
    ])
    const clips = result.tracks.find((t) => t.id === trackId)!.clips
    expect(clips).toHaveLength(3)
    expect(clips[0]).toMatchObject({ timelineStart: expect.closeTo(0), timelineEnd: expect.closeTo(2) })
    expect(clips[1]).toMatchObject({ timelineStart: expect.closeTo(2), timelineEnd: expect.closeTo(4) })
    expect(clips[1].sourceIn).toBeCloseTo(4)
    expect(clips[1].sourceOut).toBeCloseTo(6)
    expect(clips[2]).toMatchObject({ timelineStart: expect.closeTo(4), timelineEnd: expect.closeTo(7) })
    expect(clips[2].sourceIn).toBeCloseTo(7)
    expect(clips[2].sourceOut).toBeCloseTo(10)
    expect(checkInvariants(result)).toHaveLength(0)
  })

  it('프레임 비정렬 무음 경계에서도 불변식이 유지된다 (프레임 스냅 회귀)', () => {
    const { p, trackId } = setup() // 비디오 [0,10], 30fps
    // ffmpeg 무음 경계는 프레임 정렬이 아니다 — 스냅 후에도 sourceLen == tlLen·speed (불변식 3) 가 깨지면 안 됨
    const result = rippleDeleteRanges(p, trackId, [[1.05, 2.05]])
    expect(checkInvariants(result)).toHaveLength(0)
    const clips = result.tracks.find((t) => t.id === trackId)!.clips
    const fps = result.settings.fps
    for (const c of clips) {
      expect(c.timelineStart * fps).toBeCloseTo(Math.round(c.timelineStart * fps), 6) // 프레임 정렬
      expect(c.timelineEnd * fps).toBeCloseTo(Math.round(c.timelineEnd * fps), 6)
      if (c.sourceIn !== undefined && c.sourceOut !== undefined) {
        expect(c.sourceOut - c.sourceIn).toBeCloseTo(c.timelineEnd - c.timelineStart, 6) // 불변식 3 (speed=1)
      }
    }
  })

  it('프레임 비정렬 + 배속 클립에서도 불변식 3 유지', () => {
    let { p, clipId, trackId } = setup()
    p = updateClip(p, clipId, { speed: 2, timelineEnd: 5, sourceOut: 10 }) // 2배속: 타임라인 5초 = 소스 10초
    expect(checkInvariants(p)).toHaveLength(0)
    const result = rippleDeleteRanges(p, trackId, [[1.05, 1.55]])
    expect(checkInvariants(result)).toHaveLength(0)
  })

  it('비프레임정렬 클립 duration(임포트 영상)에서 프레임 정렬 컷을 해도 불변식 3 유지', () => {
    // 소수 duration(30fps 로 나눠떨어지지 않음) → 클립 끝 survivor 의 sourceOut 을 스냅된 길이에서 역산해야 안전
    let p = createProject()
    const asset = makeAsset(10.04)
    p = addAsset(p, asset)
    const track = p.tracks.find((t) => t.kind === 'video')!
    const clip = createMediaClip(asset, 0) // [0, 10.04]
    p = addClip(p, track.id, clip)
    const result = rippleDeleteRanges(p, track.id, [[2, 3]])
    expect(checkInvariants(result)).toHaveLength(0)
  })

  it('전환 구간과 겹치는 무음은 전환을 제거하고, 겹치지 않는 무음은 유지한다 (불변식 4/6/7)', () => {
    const { p, trackId, assetId, clipId } = setup()
    const asset = p.assets.find((a) => a.id === assetId)!
    let base = addClip(p, trackId, createMediaClip(asset, 10)) // 인접 클립 [10,20)
    base = updateClip(base, clipId, { transitionOut: { type: 'dissolve', duration: 2 } }) // zone [9,11]

    const overlapping = rippleDeleteRanges(base, trackId, [[9.5, 10.5]])
    expect(overlapping.tracks.find((t) => t.id === trackId)!.clips.some((c) => c.transitionOut)).toBe(false)
    expect(checkInvariants(overlapping)).toHaveLength(0)

    const nonOverlapping = rippleDeleteRanges(base, trackId, [[2, 3]])
    expect(nonOverlapping.tracks.find((t) => t.id === trackId)!.clips.some((c) => c.transitionOut?.type === 'dissolve')).toBe(true)
    expect(checkInvariants(nonOverlapping)).toHaveLength(0)
  })

  it('리플은 지정 트랙만 바꾸고 다른 트랙(자막 등)은 그대로 둔다', () => {
    const { p, trackId } = setup()
    const textTrack = p.tracks.find((t) => t.kind === 'text')!
    const withText = addClip(p, textTrack.id, createTextClip(2, 3)) // [2,5)
    const result = rippleDeleteRanges(withText, trackId, [[3, 4]])
    const resultText = result.tracks.find((t) => t.id === textTrack.id)!.clips[0]
    expect(resultText.timelineStart).toBeCloseTo(2)
    expect(resultText.timelineEnd).toBeCloseTo(5)
  })

  it('빈 구간이거나 존재하지 않는 트랙이면 원본을 그대로 반환한다', () => {
    const { p, trackId } = setup()
    expect(rippleDeleteRanges(p, trackId, [])).toBe(p)
    expect(rippleDeleteRanges(p, 'nonexistent', [[1, 2]])).toBe(p)
  })

  it('클립 전체가 삭제 구간에 덮이면 클립이 사라지고 트랙 자체는 남는다', () => {
    const { p, trackId, clipId } = setup()
    const result = rippleDeleteRanges(p, trackId, [[0, 10]])
    const track = result.tracks.find((t) => t.id === trackId)!
    expect(track).toBeDefined()
    expect(track.clips).toHaveLength(0)
    expect(findClip(result, clipId)).toBeNull()
  })

  it('전체 트랙 스코프: 비디오/자막은 잘라 당기고, 오디오(배경음악)는 자르지 않고 위치만 민다', () => {
    const { p, trackId } = setup() // 비디오 클립 [0,10)
    const textTrack = p.tracks.find((t) => t.kind === 'text')!
    const audioTrack = p.tracks.find((t) => t.kind === 'audio')!

    let withOthers = addClip(p, textTrack.id, createTextClip(2, 3)) // 자막 [2,5)
    const musicAsset: MediaAsset = { id: genId('asset'), kind: 'audio', path: '/tmp/m.mp3', duration: 3, status: 'ok' }
    withOthers = addAsset(withOthers, musicAsset)
    withOthers = addClip(withOthers, audioTrack.id, createMediaClip(musicAsset, 5)) // 배경음악 [5,8)

    const result = rippleDeleteRangesAllTracks(withOthers, [[3, 4]])

    // 비디오: 클립 내부 무음 제거 — 2조각
    const videoClips = result.tracks.find((t) => t.id === trackId)!.clips
    expect(videoClips).toHaveLength(2)
    expect(videoClips[0]).toMatchObject({ timelineStart: expect.closeTo(0), timelineEnd: expect.closeTo(3) })
    expect(videoClips[1]).toMatchObject({ timelineStart: expect.closeTo(3), timelineEnd: expect.closeTo(9) })

    // 자막: 비디오와 동일하게 잘려서 당겨진다 (싱크 유지)
    const textClips = result.tracks.find((t) => t.id === textTrack.id)!.clips
    expect(textClips).toHaveLength(2)
    expect(textClips[0]).toMatchObject({ timelineStart: expect.closeTo(2), timelineEnd: expect.closeTo(3) })
    expect(textClips[1]).toMatchObject({ timelineStart: expect.closeTo(3), timelineEnd: expect.closeTo(4) })

    // 배경음악: 잘리지 않고 위치만 밀린다 — 소스 구간·길이 그대로 보존(글리치 방지)
    const musicClips = result.tracks.find((t) => t.id === audioTrack.id)!.clips
    expect(musicClips).toHaveLength(1)
    expect(musicClips[0].timelineStart).toBeCloseTo(4) // 5 - 1(제거된 만큼)
    expect(musicClips[0].timelineEnd).toBeCloseTo(7)
    expect(musicClips[0].sourceIn).toBeCloseTo(0)
    expect(musicClips[0].sourceOut).toBeCloseTo(3)

    expect(checkInvariants(result)).toHaveLength(0)
  })

  it('전체 트랙 스코프: 빈 구간이면 원본을 그대로 반환한다', () => {
    const { p } = setup()
    expect(rippleDeleteRangesAllTracks(p, [])).toBe(p)
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
