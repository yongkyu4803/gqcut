/**
 * 자동 자막 순수 로직 유닛 테스트 (3.2) — 시간 변환/클램프/SRT.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_STT_LANGUAGE, formatSrtTimestamp, placementsToSrt, segmentsToPlacements, STT_LANGUAGES, type SttSegment } from '@shared/subtitles'

describe('STT 기본 언어 (회귀 방지)', () => {
  // Whisper 는 auto 이면 한국어를 영어로 번역해버림 → 한국 콘텐츠 기본은 반드시 korean
  it('기본 언어는 korean, 목록 첫 항목도 korean', () => {
    expect(DEFAULT_STT_LANGUAGE).toBe('korean')
    expect(STT_LANGUAGES[0].value).toBe('korean')
  })
})

describe('segmentsToPlacements — 소스→타임라인 변환 (3.2.3)', () => {
  const segs: SttSegment[] = [
    { text: '안녕하세요', start: 0, end: 1 },
    { text: '자동 자막입니다', start: 1, end: 3 }
  ]

  it('speed=1, 클립이 0에서 시작하면 소스 시간 그대로', () => {
    const p = segmentsToPlacements(segs, { timelineStart: 0, timelineEnd: 10, speed: 1 })
    expect(p).toHaveLength(2)
    expect(p[0]).toMatchObject({ timelineStart: 0, timelineEnd: 1, text: '안녕하세요' })
    expect(p[1]).toMatchObject({ timelineStart: 1, timelineEnd: 3, text: '자동 자막입니다' })
  })

  it('클립 timelineStart 오프셋이 더해진다', () => {
    const p = segmentsToPlacements(segs, { timelineStart: 5, timelineEnd: 15 })
    expect(p[0].timelineStart).toBeCloseTo(5)
    expect(p[1].timelineEnd).toBeCloseTo(8)
  })

  it('배속 반영: 2배속 클립이면 소스 초를 speed 로 나눈다', () => {
    // 2배속 → 소스 3초가 타임라인 1.5초
    const p = segmentsToPlacements(segs, { timelineStart: 0, timelineEnd: 5, speed: 2 })
    expect(p[1].timelineEnd).toBeCloseTo(1.5)
  })

  it('클립 길이를 넘는 세그먼트 end 는 클립 끝으로 클램프', () => {
    const p = segmentsToPlacements([{ text: '길다', start: 0, end: 100 }], { timelineStart: 0, timelineEnd: 4 })
    expect(p[0].timelineEnd).toBeCloseTo(4)
  })

  it('겹치는 세그먼트는 다음 시작을 넘지 않게 잘린다 (불변식 1)', () => {
    const overlap: SttSegment[] = [
      { text: 'A', start: 0, end: 2.5 },
      { text: 'B', start: 2, end: 4 }
    ]
    const p = segmentsToPlacements(overlap, { timelineStart: 0, timelineEnd: 10 })
    expect(p[0].timelineEnd).toBeLessThanOrEqual(p[1].timelineStart + 1e-9)
  })

  it('빈 텍스트/길이 0 은 버린다', () => {
    const p = segmentsToPlacements(
      [
        { text: '   ', start: 0, end: 1 },
        { text: '실제', start: 1, end: 1 }, // 길이 0
        { text: '유효', start: 2, end: 3 }
      ],
      { timelineStart: 0, timelineEnd: 10 }
    )
    expect(p).toHaveLength(1)
    expect(p[0].text).toBe('유효')
  })

  it('end 가 무한/누락이면 클립 끝까지로 처리', () => {
    const p = segmentsToPlacements([{ text: '끝없음', start: 0, end: Infinity }], { timelineStart: 0, timelineEnd: 4 })
    expect(p[0].timelineEnd).toBeCloseTo(4)
  })
})

describe('SRT 직렬화 (3.2.4)', () => {
  it('타임스탬프 포맷 HH:MM:SS,mmm', () => {
    expect(formatSrtTimestamp(0)).toBe('00:00:00,000')
    expect(formatSrtTimestamp(3661.5)).toBe('01:01:01,500')
    expect(formatSrtTimestamp(-1)).toBe('00:00:00,000')
  })

  it('SRT 블록 번호/화살표/텍스트 구조', () => {
    const srt = placementsToSrt([
      { timelineStart: 1, timelineEnd: 2, text: '첫째' },
      { timelineStart: 0, timelineEnd: 1, text: '둘째' }
    ])
    // 시작 시간 순 정렬 후 1부터 번호
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,000\n둘째')
    expect(srt).toContain('2\n00:00:01,000 --> 00:00:02,000\n첫째')
  })
})
