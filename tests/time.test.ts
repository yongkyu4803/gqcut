import { describe, expect, it } from 'vitest'
import { frameCount, frameToTime, snapToFrame, timeToFrame, formatTimecode } from '@shared/time'

describe('시간·프레임 환산 (DATA-MODEL §4)', () => {
  it('프레임 왕복 변환이 정확하다', () => {
    for (const fps of [24, 30, 60]) {
      for (let f = 0; f < 300; f++) {
        expect(timeToFrame(frameToTime(f, fps), fps)).toBe(f)
      }
    }
  })

  it('스냅은 프레임 경계로 고정한다', () => {
    expect(snapToFrame(1.001, 30)).toBeCloseTo(1.0, 9)
    expect(snapToFrame(0.0167, 30)).toBeCloseTo(1 / 30, 9)
  })

  it('frameCount = fps × duration (5.1 검증)', () => {
    expect(frameCount(10, 30)).toBe(300)
    expect(frameCount(5 * 60, 30)).toBe(9000)
    expect(frameCount(0, 30)).toBe(0)
  })

  it('타임코드 포맷', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00.00')
    expect(formatTimecode(61.5, 30)).toBe('00:01:01.15')
  })
})
