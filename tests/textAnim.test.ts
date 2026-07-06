/**
 * 자막 애니메이션/프리셋 순수 로직 유닛 테스트 (3.1.5 확장).
 * textAnimState 는 클립 상대 시간의 결정론적 함수 — 프리뷰=내보내기(WYSIWYG) 전제.
 */
import { describe, expect, it } from 'vitest'
import type { Clip, TextContent } from '@shared/model/types'
import { createTextClip } from '@shared/model/factory'
import { applyTextPreset, TEXT_PRESETS } from '@shared/textPresets'
import { textAnimState } from '../src/renderer/src/engine/textRaster'

function clipWith(text: Partial<TextContent>): Clip {
  const c = createTextClip(0, 4)
  c.text = { ...c.text!, ...text }
  return c
}

describe('등장/퇴장 애니메이션', () => {
  it('typewriter 등장: 진행률만큼 글자가 보인다 (visibleRatio)', () => {
    const c = clipWith({ animationIn: { type: 'typewriter', duration: 2 } })
    expect(textAnimState(c, 0).visibleRatio).toBeCloseTo(0)
    expect(textAnimState(c, 1).visibleRatio).toBeCloseTo(0.5)
    expect(textAnimState(c, 2.5).visibleRatio).toBe(1) // 완료 후 전체
    expect(textAnimState(c, 1).opacityMul).toBe(1) // 투명도 변화 없음
  })

  it('typewriter 퇴장: 끝에서 글자가 줄어든다', () => {
    const c = clipWith({ animationOut: { type: 'typewriter', duration: 2 } })
    expect(textAnimState(c, 3).visibleRatio).toBeCloseTo(0.5) // rel=3, len=4, out 진행 50%
    expect(textAnimState(c, 4).visibleRatio).toBeCloseTo(0)
  })

  it('방향 슬라이드: 등장 시작 오프셋이 방향별로 다르고 완료 시 0', () => {
    const mk = (type: string) => clipWith({ animationIn: { type: type as never, duration: 1 } })
    // 시작(진행 0): 슬라이드 방향에서 들어옴
    expect(textAnimState(mk('slide'), 0).offsetY).toBeGreaterThan(0) // 아래에서
    expect(textAnimState(mk('slide-down'), 0).offsetY).toBeLessThan(0) // 위에서
    expect(textAnimState(mk('slide-left'), 0).offsetX).toBeLessThan(0) // 왼쪽에서
    expect(textAnimState(mk('slide-right'), 0).offsetX).toBeGreaterThan(0) // 오른쪽에서
    // 완료: 제자리
    for (const t of ['slide', 'slide-down', 'slide-left', 'slide-right']) {
      const s = textAnimState(mk(t), 1.5)
      expect(s.offsetX).toBeCloseTo(0)
      expect(s.offsetY).toBeCloseTo(0)
      expect(s.opacityMul).toBe(1)
    }
  })

  it('zoom 등장: 크게 시작해 1로 정착', () => {
    const c = clipWith({ animationIn: { type: 'zoom', duration: 1 } })
    expect(textAnimState(c, 0).scaleMul).toBeCloseTo(1.6)
    expect(textAnimState(c, 1.5).scaleMul).toBeCloseTo(1)
  })
})

describe('루프 애니메이션 (결정론 = WYSIWYG)', () => {
  it('같은 시각이면 항상 같은 상태 (shake 포함 난수 없음)', () => {
    const c = clipWith({ loop: { type: 'shake', duration: 1 } })
    const a = textAnimState(c, 1.234)
    const b = textAnimState(c, 1.234)
    expect(a).toEqual(b)
    // 다른 시각이면 지터로 달라진다
    expect(textAnimState(c, 1.3).offsetX).not.toBeCloseTo(a.offsetX, 6)
  })

  it('pulse 는 주기 함수: t 와 t+period 가 같은 스케일', () => {
    const c = clipWith({ loop: { type: 'pulse', duration: 0.8 } })
    expect(textAnimState(c, 0.3).scaleMul).toBeCloseTo(textAnimState(c, 0.3 + 0.8).scaleMul, 6)
    expect(textAnimState(c, 0.2).scaleMul).not.toBeCloseTo(textAnimState(c, 0.4).scaleMul, 6)
  })

  it('float 는 y 만 움직인다', () => {
    const c = clipWith({ loop: { type: 'float', duration: 1, params: { intensity: 2 } } })
    const s = textAnimState(c, 0.25) // sin 최대 지점
    expect(Math.abs(s.offsetY)).toBeGreaterThan(5)
    expect(s.offsetX).toBe(0)
    expect(s.scaleMul).toBe(1)
  })

  it('루프는 등장 애니메이션과 결합된다', () => {
    // period 2 → rel 0.5 에서 sin(π/2)=1 (영점 회피)
    const c = clipWith({ animationIn: { type: 'fade', duration: 1 }, loop: { type: 'pulse', duration: 2 } })
    const s = textAnimState(c, 0.5)
    expect(s.opacityMul).toBeLessThan(1) // fade 진행 중
    expect(s.scaleMul).not.toBe(1) // pulse 동작 중
  })
})

describe('스타일 프리셋 (applyTextPreset)', () => {
  it('프리셋 6종이 정의되어 있다', () => {
    expect(TEXT_PRESETS.length).toBeGreaterThanOrEqual(6)
    expect(new Set(TEXT_PRESETS.map((p) => p.id)).size).toBe(TEXT_PRESETS.length)
  })

  it('내용/폰트/정렬/애니메이션은 유지하고 스타일만 교체한다', () => {
    const base: TextContent = {
      value: '안녕',
      fontFamily: 'MyFont',
      fontSize: 30,
      color: '#123456',
      align: 'left',
      glow: { color: '#fff', strength: 10 },
      animationIn: { type: 'typewriter', duration: 1 },
      loop: { type: 'shake', duration: 1 }
    }
    const neon = TEXT_PRESETS.find((p) => p.id === 'neon')!
    const out = applyTextPreset(base, neon)
    expect(out.value).toBe('안녕')
    expect(out.fontFamily).toBe('MyFont')
    expect(out.align).toBe('left')
    expect(out.animationIn?.type).toBe('typewriter')
    expect(out.loop?.type).toBe('shake')
    expect(out.color).toBe(neon.style.color)
    expect(out.glow).toEqual(neon.style.glow)

    // 이전 프리셋의 흔적(하이라이트 등)이 남지 않아야 한다
    const hl = TEXT_PRESETS.find((p) => p.id === 'highlighter')!
    const out2 = applyTextPreset(out, hl)
    expect(out2.glow).toBeUndefined()
    expect(out2.highlight).toEqual(hl.style.highlight)
  })
})
