/**
 * 무음 감지 자동 컷 순수 로직 유닛 테스트 — 시간 변환 / 구간 병합 / 리플 리맵.
 */
import { describe, expect, it } from 'vitest'
import { buildRippleRemap, mapSilenceToTimeline, mergeRanges, type SilenceInterval } from '@shared/silence'

describe('mapSilenceToTimeline — 소스→타임라인 변환', () => {
  it('speed=1, 클립이 0에서 시작하면 소스 시간 그대로', () => {
    const ivs: SilenceInterval[] = [{ start: 1, end: 2 }]
    const r = mapSilenceToTimeline(ivs, { timelineStart: 0, timelineEnd: 10 })
    expect(r).toEqual([[1, 2]])
  })

  it('클립 timelineStart 오프셋이 더해진다', () => {
    const r = mapSilenceToTimeline([{ start: 1, end: 2 }], { timelineStart: 5, timelineEnd: 15 })
    expect(r[0][0]).toBeCloseTo(6)
    expect(r[0][1]).toBeCloseTo(7)
  })

  it('배속 반영: 2배속이면 소스 초를 speed 로 나눈다', () => {
    // 2배속 → 소스 4초 구간이 타임라인 2초
    const r = mapSilenceToTimeline([{ start: 2, end: 6 }], { timelineStart: 0, timelineEnd: 10, speed: 2 })
    expect(r[0][0]).toBeCloseTo(1)
    expect(r[0][1]).toBeCloseTo(3)
  })

  it('클립 경계 밖으로 나가는 구간은 클램프된다', () => {
    const r = mapSilenceToTimeline([{ start: -1, end: 100 }], { timelineStart: 0, timelineEnd: 4 })
    expect(r[0]).toEqual([0, 4])
  })

  it('클램프 후 길이가 0에 가까우면 버린다', () => {
    const r = mapSilenceToTimeline([{ start: 100, end: 101 }], { timelineStart: 0, timelineEnd: 4 })
    expect(r).toHaveLength(0)
  })

  it('빈 입력 → 빈 배열', () => {
    expect(mapSilenceToTimeline([], { timelineStart: 0, timelineEnd: 4 })).toEqual([])
  })
})

describe('mergeRanges — 정렬 + 병합', () => {
  it('겹치는 두 구간은 하나로 병합된다', () => {
    expect(mergeRanges([[0, 5], [3, 8]])).toEqual([[0, 8]])
  })

  it('정확히 맞닿은(gap=0) 두 구간도 병합된다', () => {
    expect(mergeRanges([[0, 5], [5, 8]])).toEqual([[0, 8]])
  })

  it('epsilon 이내로 가까운 구간도 병합된다', () => {
    expect(mergeRanges([[0, 5], [5.0005, 8]], 1e-3)).toEqual([[0, 8]])
  })

  it('충분히 떨어진 구간은 병합되지 않고 둘 다 유지된다', () => {
    expect(mergeRanges([[0, 5], [6, 8]])).toEqual([[0, 5], [6, 8]])
  })

  it('정렬 안 된 입력도 결과는 시작 시간 순 정렬된다', () => {
    expect(mergeRanges([[6, 8], [0, 5]])).toEqual([[0, 5], [6, 8]])
  })

  it('빈 배열 → 빈 배열', () => {
    expect(mergeRanges([])).toEqual([])
  })
})

describe('buildRippleRemap — 리플 좌표 매핑', () => {
  it('구간 이전 시점은 그대로 매핑된다', () => {
    const remap = buildRippleRemap([[3, 5]])
    expect(remap(0)).toBeCloseTo(0)
    expect(remap(3)).toBeCloseTo(3)
  })

  it('구간 이후 시점은 구간 길이만큼 당겨진다', () => {
    const remap = buildRippleRemap([[3, 5]])
    expect(remap(10)).toBeCloseTo(8) // 10 - (5-3)
  })

  it('구간 내부 시점은 구간 시작점으로 붕괴한다', () => {
    const remap = buildRippleRemap([[3, 5]])
    expect(remap(4)).toBeCloseTo(3)
  })

  it('구간 경계를 가로지르는 두 값이 정확히 이어붙는다 (핵심 성질)', () => {
    const remap = buildRippleRemap([[3, 5]])
    // 구간 시작 직전 끝나는 클립과 구간 끝에서 시작하는 클립이 리플 후 같은 값으로 맞닿아야 함
    expect(remap(3)).toBeCloseTo(remap(5))
  })

  it('여러 구간의 누적 delta가 정확히 반영된다', () => {
    const remap = buildRippleRemap([[1, 2], [5, 7]]) // 총 3초 제거
    expect(remap(10)).toBeCloseTo(7) // 10 - 1 - 2
  })
})
