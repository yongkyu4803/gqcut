/**
 * effects-spec 유닛 테스트 (4.1/4.2) — 파라미터 해석과 전환 시간 의미론.
 */
import { describe, expect, it } from 'vitest'
import { fadeOpacityMul, isNeutral, NEUTRAL_ADJUST, resolveColorAdjust, TRANSITION_TYPES, transitionTypeId, transitionZone } from '@shared/effects-spec'

describe('resolveColorAdjust (4.1)', () => {
  it('빈/미지정 effects 는 중립값', () => {
    expect(resolveColorAdjust(undefined)).toEqual(NEUTRAL_ADJUST)
    expect(resolveColorAdjust([])).toEqual(NEUTRAL_ADJUST)
    expect(isNeutral(resolveColorAdjust([]))).toBe(true)
  })

  it('enabled=false 는 무시된다', () => {
    const a = resolveColorAdjust([{ type: 'saturation', params: { value: 2 }, enabled: false }])
    expect(a.saturation).toBe(1)
  })

  it('각 필터 타입이 대응 uniform 에 매핑된다', () => {
    const a = resolveColorAdjust([
      { type: 'brightness', params: { value: 0.2 }, enabled: true },
      { type: 'contrast', params: { value: 1.3 }, enabled: true },
      { type: 'saturation', params: { value: 0.5 }, enabled: true },
      { type: 'temperature', params: { value: -0.4 }, enabled: true }
    ])
    expect(a).toEqual({ brightness: 0.2, contrast: 1.3, saturation: 0.5, temperature: -0.4 })
    expect(isNeutral(a)).toBe(false)
  })
})

describe('fadeOpacityMul (페이드 = 화면·소리 공통 수식)', () => {
  it('페이드 없으면 항상 1', () => {
    expect(fadeOpacityMul(undefined, undefined, 0, 4)).toBe(1)
    expect(fadeOpacityMul(0, 0, 2, 4)).toBe(1)
  })

  it('페이드 인: 0→1 선형', () => {
    expect(fadeOpacityMul(2, undefined, 0, 4)).toBe(0)
    expect(fadeOpacityMul(2, undefined, 1, 4)).toBeCloseTo(0.5)
    expect(fadeOpacityMul(2, undefined, 2, 4)).toBe(1)
  })

  it('페이드 아웃: 1→0 선형', () => {
    expect(fadeOpacityMul(undefined, 2, 3, 4)).toBeCloseTo(0.5)
    expect(fadeOpacityMul(undefined, 2, 4, 4)).toBe(0)
  })

  it('겹치는 인/아웃은 더 어두운 쪽', () => {
    // 4초 클립에 3초 인 + 3초 아웃 → 2초 지점: in=2/3, out=2/3
    expect(fadeOpacityMul(3, 3, 2, 4)).toBeCloseTo(2 / 3)
    // 0.5초 지점: in=1/6 이 지배
    expect(fadeOpacityMul(3, 3, 0.5, 4)).toBeCloseTo(1 / 6)
  })
})

describe('transitionZone (4.2, DATA-MODEL §1.1)', () => {
  it('컷 지점 중심으로 duration 구간', () => {
    expect(transitionZone(2, 1, 0, 4)).toEqual({ start: 1.5, end: 2.5 })
  })

  it('클립 경계로 클램프된다', () => {
    // 앞 클립이 1.8초에 시작 → 구간 시작이 클립 시작으로 클램프
    expect(transitionZone(2, 1, 1.8, 4)).toEqual({ start: 1.8, end: 2.5 })
    // 뒤 클립이 2.3초에 끝
    expect(transitionZone(2, 1, 0, 2.3)).toEqual({ start: 1.5, end: 2.3 })
  })

  it('전환 타입 → 셰이더 id (8종, 셰이더 uType 분기와 1:1)', () => {
    expect(transitionTypeId('dissolve')).toBe(0)
    expect(transitionTypeId('fade')).toBe(0) // 레거시 별칭 → dissolve
    expect(transitionTypeId('wipe')).toBe(1)
    expect(transitionTypeId('slide')).toBe(2)
    expect(transitionTypeId('dip')).toBe(3)
    expect(transitionTypeId('iris')).toBe(4)
    expect(transitionTypeId('zoom')).toBe(5)
    expect(transitionTypeId('radial')).toBe(6)
    expect(transitionTypeId('blinds')).toBe(7)
  })

  it('TRANSITION_TYPES 는 8종이고 모든 type 이 고유 id 로 매핑된다', () => {
    expect(TRANSITION_TYPES).toHaveLength(8)
    const ids = TRANSITION_TYPES.map((t) => transitionTypeId(t.type))
    expect(new Set(ids).size).toBe(8) // 중복 매핑 없음
  })
})
