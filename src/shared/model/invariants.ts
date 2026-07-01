/**
 * 불변식 (DATA-MODEL.md §3) — 커맨드 실행 후 개발 모드에서 assert.
 */
import type { Project } from './types'

const EPS = 1e-6

export function checkInvariants(project: Project): string[] {
  const violations: string[] = []
  const assetIds = new Set(project.assets.map((a) => a.id))
  const assetById = new Map(project.assets.map((a) => [a.id, a]))

  for (const track of project.tracks) {
    const sorted = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart)

    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i]
      const where = `track ${track.id} clip ${c.id}`

      // 2. timelineStart < timelineEnd, sourceIn < sourceOut
      if (!(c.timelineStart < c.timelineEnd)) violations.push(`${where}: timelineStart >= timelineEnd`)
      if (c.sourceIn !== undefined && c.sourceOut !== undefined && !(c.sourceIn < c.sourceOut))
        violations.push(`${where}: sourceIn >= sourceOut`)

      // 1. 같은 트랙 내 클립은 겹치지 않는다
      if (i > 0 && sorted[i - 1].timelineEnd > c.timelineStart + EPS)
        violations.push(`${where}: 이전 클립과 시간 겹침`)

      // 3. 소스 구간 길이 = 타임라인 길이 × speed
      if (c.sourceIn !== undefined && c.sourceOut !== undefined && c.kind !== 'image') {
        const speed = c.speed ?? 1
        const srcLen = c.sourceOut - c.sourceIn
        const tlLen = (c.timelineEnd - c.timelineStart) * speed
        if (Math.abs(srcLen - tlLen) > 1e-3) violations.push(`${where}: 소스 길이(${srcLen})와 타임라인 길이×speed(${tlLen}) 불일치`)
      }

      // 4. 전환 duration 은 클립 길이를 넘지 않는다
      const clipLen = c.timelineEnd - c.timelineStart
      for (const t of [c.transitionIn, c.transitionOut]) {
        if (t && t.duration > clipLen + EPS) violations.push(`${where}: 전환 duration 이 클립 길이 초과`)
      }

      // 5. assetId 참조 유효성
      if (c.assetId && !assetIds.has(c.assetId)) violations.push(`${where}: 존재하지 않는 assetId ${c.assetId}`)

      // 6/7. 전환 핸들: transitionOut 은 다음 클립과 맞닿아 있을 때만 의미 있음 + 핸들 확보 여부 확인
      if (c.transitionOut && c.assetId && c.sourceOut !== undefined) {
        const asset = assetById.get(c.assetId)
        const next = sorted[i + 1]
        if (!next || Math.abs(next.timelineStart - c.timelineEnd) > 1e-3)
          violations.push(`${where}: transitionOut 이 있으나 맞닿은 다음 클립이 없음`)
        // 핸들 부족 자체는 위반이 아님(프레임 홀드 fallback) — 자산 범위 초과 데이터만 잡는다
        if (asset && c.sourceOut > asset.duration + 1e-3)
          violations.push(`${where}: sourceOut 이 자산 duration 초과`)
      }
    }
  }
  return violations
}

/** 개발 모드 assert — 위반 시 콘솔 에러 (프로덕션에선 무시 가능) */
export function assertInvariants(project: Project, label: string): void {
  const violations = checkInvariants(project)
  if (violations.length > 0) {
     
    console.error(`[invariants] "${label}" 후 위반 ${violations.length}건:`, violations)
  }
}
