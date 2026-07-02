/**
 * 프리뷰 드래그 정렬 가이드 (텍스트/비주얼 클립 위치 일관성) — 순수 함수, DOM 비의존.
 * Timeline.tsx 의 snap() 과 동일한 최근접-후보 패턴을 일반화한다.
 *
 * edgeY(상/하 안전선)는 텍스트 블록의 "아래쪽 끝" 기준으로 스냅해야 1줄/2줄 자막의
 * 세로 위치가 일관된다(줄 수가 다르면 블록 높이가 달라 중심점 기준 스냅은 아래쪽 끝이 서로 어긋남).
 * 그래서 target(스냅 비교값)과 display(가이드선을 그릴 위치)를 분리한다 — 호출자(Preview.tsx)가
 * 텍스트 블록 높이의 절반(edgeOffset)만큼 target 을 이동해 넘기고, display 는 항상 실제 안전선 위치.
 */
import type { Project } from '@shared/model/types'

const SAFE_MARGIN_RATIO = 0.1 // 상하 10% 세이프 마진(널리 쓰이는 title-safe 근사치)

export interface SnapCandidate {
  target: number // 드래그 좌표와 비교할 값
  display: number // 스냅 적중 시 가이드선을 그릴 위치
}

/** target === display 인 단순 후보로 변환 (중앙/다른 클립 위치처럼 에지 보정이 필요 없는 경우) */
export function toCandidates(values: number[]): SnapCandidate[] {
  return values.map((v) => ({ target: v, display: v }))
}

/**
 * t 시점에 프리뷰에 보이는 다른 클립들의 위치(중앙 기준) + 상하 안전선(edgeY)을 스냅 후보로 제공.
 * edgeY 는 항상 "화면 기준 고정 라인"이며, 호출자가 드래그 중인 클립의 종류에 따라
 * target 을 얼마나 보정할지(텍스트 블록 높이의 절반 등) 결정한다.
 */
export function computeGuideCandidates(
  project: Project,
  t: number,
  canvasH: number,
  excludeClipId: string
): { x: number[]; y: number[]; edgeY: number[] } {
  const x = [0]
  const y = [0]
  const edgeY = [-(canvasH / 2) * (1 - SAFE_MARGIN_RATIO), (canvasH / 2) * (1 - SAFE_MARGIN_RATIO)]
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
  return { x, y, edgeY }
}

/** 후보 중 threshold 이내 최근접으로 스냅. 적중 없으면 원값 그대로(display 는 null) */
export function snap1D(value: number, candidates: SnapCandidate[], threshold: number): { value: number; display: number | null } {
  let best = value
  let bestDist = threshold
  let display: number | null = null
  for (const c of candidates) {
    const d = Math.abs(c.target - value)
    if (d < bestDist) {
      best = c.target
      bestDist = d
      display = c.display
    }
  }
  return { value: best, display }
}
