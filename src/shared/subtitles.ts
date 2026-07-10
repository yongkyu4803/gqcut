/**
 * 자동 자막(STT, dev-plan 3.2) 순수 로직 — 시간 변환 + SRT 직렬화.
 * 엔진(Whisper)이 돌려주는 소스-상대 세그먼트를 타임라인 시간으로 옮기고,
 * 자막 트랙 배치/내보내기에 쓰는 결정론적 변환만 담는다 (부수효과 없음 → 유닛 테스트).
 */

/** Whisper 세그먼트 — 소스 오디오 기준 초 단위(추출 구간 t=0 = 클립 시작) */
export interface SttSegment {
  text: string
  start: number
  end: number
}

/** 자막 클립 배치 명세 (타임라인 시간) */
export interface SubtitlePlacement {
  timelineStart: number
  timelineEnd: number
  text: string
}

export interface ClipTiming {
  timelineStart: number
  timelineEnd: number
  /** 재생 속도 배율 (기본 1.0) — 소스 초를 타임라인 초로 변환할 때 나눈다 */
  speed?: number
}

const MIN_DUR = 1 / 60 // 최소 자막 길이(초) — 1프레임(60fps) 이상

/**
 * 소스-상대 세그먼트 → 타임라인 자막 배치.
 * - segSec 는 추출 오디오(클립 소스 구간, t=0=클립 시작) 기준 → timelineStart + segSec/speed
 * - 클립 경계로 클램프, 다음 세그먼트 시작을 넘지 않도록 end 조정(트랙 내 겹침 방지 = 불변식 1)
 * - 빈 텍스트/길이 0 세그먼트는 버린다
 */
export function segmentsToPlacements(segments: SttSegment[], clip: ClipTiming): SubtitlePlacement[] {
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1
  const clipLen = clip.timelineEnd - clip.timelineStart
  const toTimeline = (segSec: number): number => clip.timelineStart + Math.max(0, segSec) / speed

  // 유효 세그먼트만 추려 시작 시간 순 정렬
  const valid = segments
    .map((s) => ({ text: s.text.trim(), start: s.start, end: Number.isFinite(s.end) ? s.end : s.start + clipLen * speed }))
    .filter((s) => s.text.length > 0 && s.end > s.start)
    .sort((a, b) => a.start - b.start)

  const out: SubtitlePlacement[] = []
  for (let i = 0; i < valid.length; i++) {
    const seg = valid[i]
    let tStart = toTimeline(seg.start)
    let tEnd = toTimeline(seg.end)
    // 클립 경계 클램프
    tStart = Math.min(Math.max(tStart, clip.timelineStart), clip.timelineEnd - MIN_DUR)
    tEnd = Math.min(tEnd, clip.timelineEnd)
    // 다음 세그먼트와 겹치지 않도록
    const next = valid[i + 1]
    if (next) tEnd = Math.min(tEnd, toTimeline(next.start))
    if (tEnd - tStart < MIN_DUR) continue
    out.push({ timelineStart: tStart, timelineEnd: tEnd, text: seg.text })
  }
  return out
}

/** 초 → SRT 타임스탬프 (HH:MM:SS,mmm) */
export function formatSrtTimestamp(sec: number): string {
  const clamped = Math.max(0, sec)
  const ms = Math.round(clamped * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const millis = ms % 1000
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(millis, 3)}`
}

/** SRT 타임스탬프(HH:MM:SS,mmm / MM:SS.mmm 등) → 초. 파싱 불가면 null */
export function parseSrtTimestamp(raw: string): number | null {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/.exec(raw.trim())
  if (!m) return null
  const h = m[1] ? Number(m[1]) : 0
  const min = Number(m[2])
  const s = Number(m[3])
  const ms = Number(m[4].padEnd(3, '0'))
  return h * 3600 + min * 60 + s + ms / 1000
}

/**
 * SRT 텍스트 → 자막 배치(가져오기, feature-5). 타임스탬프는 타임라인 절대시간으로 간주한다.
 * 블록 순서/번호에 의존하지 않고 "--> 를 가진 줄"을 기준으로 파싱 — 번호 누락·CRLF·다중행 텍스트에 견고.
 * 유효하지 않은(타임스탬프 없음·빈 텍스트·end<=start) 블록은 건너뛴다. 시작시간 순 정렬.
 */
export function parseSrt(content: string): SubtitlePlacement[] {
  const blocks = content.replace(/\r\n/g, '\n').replace(/^﻿/, '').split(/\n\s*\n/)
  const out: SubtitlePlacement[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    const tcIndex = lines.findIndex((l) => l.includes('-->'))
    if (tcIndex === -1) continue
    const [left, right] = lines[tcIndex].split('-->')
    const start = parseSrtTimestamp(left ?? '')
    const end = parseSrtTimestamp(right ?? '')
    if (start === null || end === null || end <= start) continue
    const text = lines
      .slice(tcIndex + 1)
      .join('\n')
      .trim()
    if (!text) continue
    out.push({ timelineStart: start, timelineEnd: end, text })
  }
  return out.sort((a, b) => a.timelineStart - b.timelineStart)
}

/** 자막 배치 목록 → SRT 문자열 (내보내기 3.2.4) */
export function placementsToSrt(items: SubtitlePlacement[]): string {
  return (
    items
      .slice()
      .sort((a, b) => a.timelineStart - b.timelineStart)
      .map((it, i) => `${i + 1}\n${formatSrtTimestamp(it.timelineStart)} --> ${formatSrtTimestamp(it.timelineEnd)}\n${it.text}\n`)
      .join('\n')
  )
}

export type SttModel = 'whisper-tiny' | 'whisper-base' | 'whisper-small'

export const STT_MODEL_INFO: Record<SttModel, { repo: string; label: string; approxMB: number }> = {
  'whisper-tiny': { repo: 'onnx-community/whisper-tiny', label: '빠름 (tiny)', approxMB: 45 },
  'whisper-base': { repo: 'onnx-community/whisper-base', label: '권장 (base)', approxMB: 90 },
  'whisper-small': { repo: 'onnx-community/whisper-small', label: '정확 (small)', approxMB: 260 }
}

/**
 * 언어 목록 — 한국어가 기본(첫 항목).
 * 주의: Whisper 는 언어 미지정('auto')이면 짧은 클립에서 영어로 번역/전사되는 경향이 있어
 * 한국 콘텐츠 기본값은 반드시 'korean' 이어야 한다 (실측 확인).
 */
export const STT_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: 'korean', label: '한국어' },
  { value: 'english', label: '영어' },
  { value: 'japanese', label: '일본어' },
  { value: 'chinese', label: '중국어' },
  { value: 'auto', label: '자동 감지' }
]

export const DEFAULT_STT_LANGUAGE = 'korean'
