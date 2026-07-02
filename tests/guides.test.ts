/**
 * 프리뷰 드래그 정렬 가이드 유닛 테스트 — 후보 계산 + 최근접 스냅.
 */
import { describe, expect, it } from 'vitest'
import { createProject, createTextClip } from '@shared/model/factory'
import type { Project } from '@shared/model/types'
import { addClip } from '../src/renderer/src/state/commands'
import { computeGuideCandidates, snap1D } from '../src/renderer/src/engine/guides'

function setup(): { p: Project; trackId: string } {
  const p = createProject()
  const trackId = p.tracks.find((t) => t.kind === 'text')!.id
  return { p, trackId }
}

describe('computeGuideCandidates', () => {
  it('기본 후보로 중앙(0)과 상하 세이프라인을 포함한다', () => {
    const { p } = setup()
    const { x, y } = computeGuideCandidates(p, 0, 1080, 'none')
    expect(x).toContain(0)
    expect(y).toContain(0)
    expect(y).toContain(-486) // -(1080/2)*(1-0.1)
    expect(y).toContain(486)
  })

  it('같은 시점에 보이는 다른 클립의 transform 을 후보로 포함한다', () => {
    let { p, trackId } = setup()
    const clip = createTextClip(0, 3, { x: 120, y: -200, scale: 1, rotation: 0 })
    p = addClip(p, trackId, clip)
    const { x, y } = computeGuideCandidates(p, 1, 1080, 'exclude-me')
    expect(x).toContain(120)
    expect(y).toContain(-200)
  })

  it('드래그 중인 클립 자신은 후보에서 제외한다', () => {
    let { p, trackId } = setup()
    const clip = createTextClip(0, 3, { x: 120, y: -200, scale: 1, rotation: 0 })
    p = addClip(p, trackId, clip)
    const { x, y } = computeGuideCandidates(p, 1, 1080, clip.id)
    expect(x).not.toContain(120)
    expect(y).not.toContain(-200)
  })

  it('현재 시점에 보이지 않는(다른 구간) 클립은 후보에서 제외한다', () => {
    let { p, trackId } = setup()
    const clip = createTextClip(10, 3, { x: 120, y: -200, scale: 1, rotation: 0 })
    p = addClip(p, trackId, clip)
    const { x, y } = computeGuideCandidates(p, 1, 1080, 'exclude-me')
    expect(x).not.toContain(120)
    expect(y).not.toContain(-200)
  })
})

describe('snap1D', () => {
  it('threshold 이내 최근접 후보로 스냅한다', () => {
    const r = snap1D(5, [0, 100], 8)
    expect(r.value).toBe(0)
    expect(r.snappedTo).toBe(0)
  })

  it('threshold 밖이면 원값을 유지하고 snappedTo 는 null', () => {
    const r = snap1D(50, [0, 100], 8)
    expect(r.value).toBe(50)
    expect(r.snappedTo).toBeNull()
  })

  it('여러 후보 중 가장 가까운 것을 선택한다', () => {
    const r = snap1D(97, [0, 100, 90], 8)
    expect(r.snappedTo).toBe(100)
  })
})
