/**
 * effects-spec 유닛 테스트 (4.1/4.2) — 파라미터 해석과 전환 시간 의미론.
 */
import { describe, expect, it } from 'vitest'
import { fadeOpacityMul, isNeutral, NEUTRAL_ADJUST, resolveColorAdjust, TRANSITION_TYPES, transitionTypeId, transitionZone } from '@shared/effects-spec'
import { applyColorPreset, COLOR_PRESETS } from '@shared/colorPresets'
import type { Effect } from '@shared/model/types'

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
    expect(a).toEqual({ ...NEUTRAL_ADJUST, brightness: 0.2, contrast: 1.3, saturation: 0.5, temperature: -0.4 })
    expect(isNeutral(a)).toBe(false)
  })

  it('tint 는 r/g/b/amount 를 매핑하고 amount=0 이면 중립으로 취급된다', () => {
    const a = resolveColorAdjust([{ type: 'tint', params: { r: 0.9, g: 0.7, b: 0.5, amount: 0.6 }, enabled: true }])
    expect(a.tintR).toBe(0.9)
    expect(a.tintG).toBe(0.7)
    expect(a.tintB).toBe(0.5)
    expect(a.tintAmount).toBe(0.6)
    expect(isNeutral(a)).toBe(false)

    const neutral = resolveColorAdjust([{ type: 'tint', params: { r: 0.9, g: 0.7, b: 0.5, amount: 0 }, enabled: true }])
    expect(isNeutral(neutral)).toBe(true)
  })
})

describe('applyColorPreset (색보정 프리셋)', () => {
  it('세피아: saturation 을 낮추고 tint 를 얹는다, 기존 필터 값은 교체된다', () => {
    const sepia = COLOR_PRESETS.find((p) => p.id === 'sepia')!
    const existing: Effect[] = [{ type: 'saturation', params: { value: 2 }, enabled: true }]
    const next = applyColorPreset(existing, sepia)
    const adjust = resolveColorAdjust(next)
    expect(adjust.saturation).toBe(0.25)
    expect(adjust.tintAmount).toBe(0.55)
    expect(isNeutral(adjust)).toBe(false)
  })

  it('기본(초기화) 프리셋은 모든 필터를 중립으로 되돌린다', () => {
    const sepia = COLOR_PRESETS.find((p) => p.id === 'sepia')!
    const def = COLOR_PRESETS.find((p) => p.id === 'default')!
    const withSepia = applyColorPreset(undefined, sepia)
    const reset = applyColorPreset(withSepia, def)
    expect(isNeutral(resolveColorAdjust(reset))).toBe(true)
  })

  it('필터 외 다른 effect 종류는 보존된다', () => {
    const noir = COLOR_PRESETS.find((p) => p.id === 'noir')!
    const existing: Effect[] = [{ type: 'blur', params: { value: 1 }, enabled: true }]
    const next = applyColorPreset(existing, noir)
    expect(next.some((e) => e.type === 'blur')).toBe(true)
    expect(resolveColorAdjust(next).saturation).toBe(0)
  })

  it('모든 프리셋 id 가 고유하다', () => {
    const ids = COLOR_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
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
