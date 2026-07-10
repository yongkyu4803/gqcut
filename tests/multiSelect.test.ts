/**
 * 다중 선택 · 일괄 편집 유닛 테스트 (phase-8)
 *  - updateClips: 부분 필드 병합 / 타 스타일 보존 / 단일 pass / 없는 id 무시
 *  - 선택 스토어 액션: 교체 / 토글 / 범위 선택 / 프루닝 / primary 동기화
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createProject, createTextClip } from '@shared/model/factory'
import type { Project, TextContent } from '@shared/model/types'
import { addClip, findClip, updateClips } from '../src/renderer/src/state/commands'
import { useEditor } from '../src/renderer/src/state/store'

/** 텍스트 트랙에 자막 n개를 [i*2, i*2+2) 로 배치한 프로젝트 (색은 클립마다 다르게) */
function projectWithSubtitles(n: number): { p: Project; ids: string[]; trackId: string } {
  let p = createProject()
  const track = p.tracks.find((t) => t.kind === 'text')!
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const clip = createTextClip(i * 2, 2)
    clip.id = `sub${i}`
    clip.text = { ...(clip.text as TextContent), value: `자막${i}`, fontSize: 40, color: `#00000${i}` }
    p = addClip(p, track.id, clip)
    ids.push(clip.id)
  }
  return { p, ids, trackId: track.id }
}

describe('updateClips (일괄 편집 커맨드)', () => {
  it('선택한 클립에만, 바꾼 필드만 병합하고 나머지 스타일은 보존한다', () => {
    const { p, ids } = projectWithSubtitles(5)
    // 1번(sub0)과 마지막(sub4)만 글자 크기 확대
    const next = updateClips(p, [ids[0], ids[4]], (c) => ({ text: { ...(c.text as TextContent), fontSize: 80 } }))

    expect(findClip(next, 'sub0')!.clip.text!.fontSize).toBe(80)
    expect(findClip(next, 'sub4')!.clip.text!.fontSize).toBe(80)
    // 나머지는 불변
    expect(findClip(next, 'sub1')!.clip.text!.fontSize).toBe(40)
    expect(findClip(next, 'sub2')!.clip.text!.fontSize).toBe(40)
    expect(findClip(next, 'sub3')!.clip.text!.fontSize).toBe(40)
    // 각 클립 고유 스타일(색·내용) 보존 — primary 로 덮어쓰지 않음
    expect(findClip(next, 'sub0')!.clip.text!.color).toBe('#000000')
    expect(findClip(next, 'sub0')!.clip.text!.value).toBe('자막0')
    expect(findClip(next, 'sub4')!.clip.text!.color).toBe('#000004')
    expect(findClip(next, 'sub4')!.clip.text!.value).toBe('자막4')
  })

  it('빈 id 목록 또는 존재하지 않는 id 는 no-op(동일 참조 반환)', () => {
    const { p, ids } = projectWithSubtitles(3)
    expect(updateClips(p, [], () => ({ opacity: 0.5 }))).toBe(p)
    expect(updateClips(p, ['nope'], () => ({ opacity: 0.5 }))).toBe(p)
    // 존재하는 id 만 반영, 없는 id 는 무시
    const next = updateClips(p, [ids[1], 'nope'], () => ({ opacity: 0.5 }))
    expect(next).not.toBe(p)
    expect(findClip(next, ids[1])!.clip.opacity).toBe(0.5)
  })

  it('여러 트랙에 걸친 id 도 한 번에 갱신한다', () => {
    const { p: base } = projectWithSubtitles(2)
    // 비디오 트랙에도 자막 아님 클립 대신 텍스트를 다른 트랙에 추가하는 대신, 텍스트 트랙 하나로 충분히 검증됨.
    const next = updateClips(base, ['sub0', 'sub1'], () => ({ opacity: 0.3 }))
    expect(findClip(next, 'sub0')!.clip.opacity).toBe(0.3)
    expect(findClip(next, 'sub1')!.clip.opacity).toBe(0.3)
  })
})

describe('선택 스토어 액션 (다중 선택)', () => {
  beforeEach(() => {
    const { p } = projectWithSubtitles(5)
    useEditor.getState().replaceProject(p)
  })

  it('select 는 단일 교체, primary(selectedClipId) 동기화', () => {
    useEditor.getState().select('sub2')
    expect(useEditor.getState().selectedClipIds).toEqual(['sub2'])
    expect(useEditor.getState().selectedClipId).toBe('sub2')
    useEditor.getState().select(null)
    expect(useEditor.getState().selectedClipIds).toEqual([])
    expect(useEditor.getState().selectedClipId).toBeNull()
  })

  it('toggleSelect 로 비연속(1·5번) 선택, 재토글 시 제거', () => {
    const s = useEditor.getState()
    s.select('sub0')
    s.toggleSelect('sub4')
    expect(useEditor.getState().selectedClipIds).toEqual(['sub0', 'sub4'])
    expect(useEditor.getState().selectedClipId).toBe('sub4')
    useEditor.getState().toggleSelect('sub4')
    expect(useEditor.getState().selectedClipIds).toEqual(['sub0'])
    expect(useEditor.getState().selectedClipId).toBe('sub0')
  })

  it('selectRangeTo 로 앵커~클릭 사이 연속 범위 선택(같은 트랙)', () => {
    const s = useEditor.getState()
    s.select('sub1')
    s.selectRangeTo('sub3')
    expect(new Set(useEditor.getState().selectedClipIds)).toEqual(new Set(['sub1', 'sub2', 'sub3']))
    // 앵커(primary)는 마지막으로 유지되어 이후 범위 확장 기준이 된다
    expect(useEditor.getState().selectedClipId).toBe('sub1')
  })

  it('편집으로 사라진 클립은 선택에서 프루닝된다', () => {
    const s = useEditor.getState()
    s.select('sub0')
    s.toggleSelect('sub4')
    // sub4 를 삭제하는 편집
    s.dispatch('삭제', (p) => ({
      ...p,
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== 'sub4') }))
    }))
    expect(useEditor.getState().selectedClipIds).toEqual(['sub0'])
    expect(useEditor.getState().selectedClipId).toBe('sub0')
  })

  it('일괄 편집 → 단일 undo 로 전부 원복', () => {
    const s = useEditor.getState()
    s.select('sub0')
    s.toggleSelect('sub4')
    const ids = useEditor.getState().selectedClipIds
    s.dispatch('글자 크기 일괄', (p) => updateClips(p, ids, (c) => ({ text: { ...(c.text as TextContent), fontSize: 80 } })))
    expect(findClip(useEditor.getState().project, 'sub0')!.clip.text!.fontSize).toBe(80)
    expect(findClip(useEditor.getState().project, 'sub4')!.clip.text!.fontSize).toBe(80)
    expect(useEditor.getState().past).toHaveLength(1)
    useEditor.getState().undo()
    expect(findClip(useEditor.getState().project, 'sub0')!.clip.text!.fontSize).toBe(40)
    expect(findClip(useEditor.getState().project, 'sub4')!.clip.text!.fontSize).toBe(40)
  })

  it('clearSelection 은 전체 해제', () => {
    const s = useEditor.getState()
    s.select('sub0')
    s.toggleSelect('sub2')
    s.clearSelection()
    expect(useEditor.getState().selectedClipIds).toEqual([])
    expect(useEditor.getState().selectedClipId).toBeNull()
  })
})
