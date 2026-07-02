/**
 * 프리뷰 드래그 정렬 가이드 (텍스트/비주얼 클립 위치 일관성) — 순수 함수, DOM 비의존.
 * Timeline.tsx 의 snap() 과 동일한 최근접-후보 패턴을 일반화한다.
 */
import type { Project } from '@shared/model/types'

const SAFE_MARGIN_RATIO = 0.1 // 상하 10% 세이프 마진(널리 쓰이는 title-safe 근사치)

/** t 시점에 프리뷰에 보이는 다른 클립들의 위치 + 중앙/세이프라인을 스냅 후보로 제공 */
export function computeGuideCandidates(
  project: Project,
  t: number,
  canvasH: number,
  excludeClipId: string
): { x: number[]; y: number[] } {
  const x = [0]
  const y = [0, -(canvasH / 2) * (1 - SAFE_MARGIN_RATIO), (canvasH / 2) * (1 - SAFE_MARGIN_RATIO)]
  for (const track of project.tracks) {
    for (const c of track.clips) {
      if (c.id === excludeClipId) continue
      if (!(c.timelineStart <= t && t < c.timelineEnd)) continue
      const tr = c.transform
      if (!tr) continue
      x.push(tr.x)
      y.push(tr.y)
    }
  }
  return { x, y }
}

/** 후보 중 threshold 이내 최근접으로 스냅. 적중 없으면 원값 그대로 */
export function snap1D(value: number, candidates: number[], threshold: number): { value: number; snappedTo: number | null } {
  let best = value
  let bestDist = threshold
  let snappedTo: number | null = null
  for (const c of candidates) {
    const d = Math.abs(c - value)
    if (d < bestDist) {
      best = c
      bestDist = d
      snappedTo = c
    }
  }
  return { value: best, snappedTo }
}
