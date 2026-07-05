/**
 * 무음 감지 자동 컷 순수 로직 — 시간 변환 + 구간 병합 + 리플 좌표 매핑.
 * 메인 프로세스(ffmpeg silencedetect)가 돌려주는 소스-상대 무음 구간을 타임라인 좌표로 옮기고,
 * 여러 구간을 잘라낸 뒤 뒤 클립을 당기는 데 쓰는 결정론적 변환만 담는다(부수효과 없음 → 유닛 테스트).
 */
import type { ClipTiming } from './subtitles'

/** ffmpeg silencedetect 가 돌려주는 무음 구간 — 추출 구간 기준 초 단위(t=0=클립의 sourceIn) */
export interface SilenceInterval {
  start: number
  end: number
}

const EPS = 1e-3

/**
 * 소스-상대 무음 구간 → 타임라인 절대 좌표.
 * segmentsToPlacements(subtitles.ts)와 동일한 변환식(timelineStart + segSec/speed), 클립 경계로 클램프.
 */
export function mapSilenceToTimeline(intervals: SilenceInterval[], clip: ClipTiming): Array<[number, number]> {
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1
  const toTimeline = (segSec: number): number => clip.timelineStart + Math.max(0, segSec) / speed

  const out: Array<[number, number]> = []
  for (const iv of intervals) {
    const start = Math.min(Math.max(toTimeline(iv.start), clip.timelineStart), clip.timelineEnd)
    const end = Math.min(Math.max(toTimeline(iv.end), clip.timelineStart), clip.timelineEnd)
    if (end - start > EPS) out.push([start, end])
  }
  return out
}

/** 구간들을 시작 시간 순 정렬 후 겹치거나 인접(gap<=epsilon)한 것을 병합 */
export function mergeRanges(ranges: Array<[number, number]>, epsilonSec = EPS): Array<[number, number]> {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = [[sorted[0][0], sorted[0][1]]]
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]
    const last = out[out.length - 1]
    if (s <= last[1] + epsilonSec) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/**
 * 병합된(정렬·비겹침 전제) 무음 구간들로부터 "원래 시간 t → 리플 후 시간" 매핑 함수를 만든다.
 * 구간 내부의 모든 점은 구간 시작점 기준으로 붕괴한다 — 무음 양끝에 걸친 두 클립이
 * 리플 후 정확히 같은 값으로 맞닿게 되는 핵심 성질(교차-클립 브릿징이 따로 필요 없는 이유).
 */
export function buildRippleRemap(merged: Array<[number, number]>): (t: number) => number {
  return (t: number): number => {
    let removed = 0
    for (const [s, e] of merged) {
      if (t <= s) break
      if (t >= e) removed += e - s
      else {
        removed += t - s
        break
      }
    }
    return t - removed
  }
}
