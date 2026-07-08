/**
 * AI 편집 어시스턴트 유닛/통합 테스트 (7.2.4) — SDK/네트워크 없이.
 *  - 도구 스키마(aiTools) 검증
 *  - 상태 요약기(aiSummary)
 *  - executor 매핑: 툴콜 → 프로젝트 상태 단언 (모의 툴콜 시퀀스)
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { MediaAsset, Project } from '@shared/model/types'
import { createMediaClip, createProject } from '@shared/model/factory'
import { AI_TOOLS, AI_TOOL_BY_NAME, AI_TOOL_NAMES } from '@shared/aiTools'
import { summarizeProject } from '@shared/aiSummary'
import { useEditor } from '../src/renderer/src/state/store'
import { useAi } from '../src/renderer/src/ai/aiStore'
import { executeTool } from '../src/renderer/src/ai/executor'
import { findClip } from '../src/renderer/src/state/commands'

function projectWithVideo(): Project {
  const p = createProject()
  const asset: MediaAsset = { id: 'a1', kind: 'video', path: '/tmp/clip.mp4', duration: 10, status: 'ok', hasAudio: true }
  const clip = createMediaClip(asset, 0) // 0~10s
  clip.id = 'c1'
  const videoTrackId = p.tracks.find((t) => t.kind === 'video')!.id
  return { ...p, assets: [asset], tracks: p.tracks.map((t) => (t.id === videoTrackId ? { ...t, clips: [clip] } : t)) }
}

function videoClips(): { count: number } {
  const track = useEditor.getState().project.tracks.find((t) => t.kind === 'video')!
  return { count: track.clips.length }
}

/** 확인 게이트 자동 승인(파괴적 도구용) */
async function runAuto(call: { name: string; input: Record<string, unknown> }): Promise<{ ok: boolean; message: string }> {
  const unsub = useAi.subscribe((s) => {
    if (s.pendingConfirm) useAi.getState().resolveConfirm(true)
  })
  try {
    const r = await executeTool(call)
    return { ok: r.ok, message: r.message }
  } finally {
    unsub()
  }
}

describe('도구 스키마 (aiTools)', () => {
  it('도구 이름이 고유하다', () => {
    expect(new Set(AI_TOOL_NAMES).size).toBe(AI_TOOL_NAMES.length)
    expect(AI_TOOLS.length).toBeGreaterThanOrEqual(15)
  })

  it('get_project_state 는 인자가 없다', () => {
    const spec = AI_TOOL_BY_NAME.get('get_project_state')!
    expect(z.object(spec.shape).safeParse({}).success).toBe(true)
  })

  it('split_clip 은 clipId·atSec 를 요구한다', () => {
    const shape = z.object(AI_TOOL_BY_NAME.get('split_clip')!.shape)
    expect(shape.safeParse({ clipId: 'c1', atSec: 2 }).success).toBe(true)
    expect(shape.safeParse({ clipId: 'c1' }).success).toBe(false)
    expect(shape.safeParse({ clipId: 'c1', atSec: -1 }).success).toBe(false)
  })

  it('add_transition 은 정의된 전환 종류만 받는다', () => {
    const shape = z.object(AI_TOOL_BY_NAME.get('add_transition')!.shape)
    expect(shape.safeParse({ clipId: 'c1', type: 'dissolve' }).success).toBe(true)
    expect(shape.safeParse({ clipId: 'c1', type: '없는전환' }).success).toBe(false)
  })

  it('파괴적/비전 플래그가 지정돼 있다', () => {
    expect(AI_TOOL_BY_NAME.get('delete_clip')!.destructive).toBe(true)
    expect(AI_TOOL_BY_NAME.get('export_video')!.destructive).toBe(true)
    expect(AI_TOOL_BY_NAME.get('capture_preview')!.vision).toBe(true)
  })
})

describe('상태 요약기 (aiSummary)', () => {
  it('트랙/클립/시간/선택/플레이헤드를 담고 경로는 파일명만', () => {
    const p = projectWithVideo()
    const s = summarizeProject(p, { selectedClipId: 'c1', playhead: 1.5 })
    expect(s.resolution).toBe('1920x1080')
    expect(s.durationSec).toBe(10)
    expect(s.playheadSec).toBe(1.5)
    expect(s.selectedClipId).toBe('c1')
    expect(s.assets[0].name).toBe('clip.mp4') // 전체 경로 아님
    const vt = s.tracks.find((t) => t.kind === 'video')!
    expect(vt.clips[0]).toMatchObject({ id: 'c1', kind: 'video', start: 0, end: 10, selected: true })
  })
})

describe('executor 매핑 (툴콜 → 프로젝트 상태)', () => {
  beforeEach(() => {
    useEditor.getState().replaceProject(projectWithVideo())
    useEditor.getState().select('c1')
    useAi.getState().clear()
  })

  it('split_clip: 2초에서 자르면 클립이 2개가 된다', async () => {
    expect(videoClips().count).toBe(1)
    const r = await executeTool({ name: 'split_clip', input: { clipId: 'c1', atSec: 2 } })
    expect(r.ok).toBe(true)
    expect(videoClips().count).toBe(2)
  })

  it('존재하지 않는 clipId → 한국어 에러 반환(크래시 없음)', async () => {
    const r = await executeTool({ name: 'split_clip', input: { clipId: 'nope', atSec: 2 } })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('찾을 수 없습니다')
    expect(videoClips().count).toBe(1)
  })

  it('split_clip: 범위 밖 시각 → 에러, 상태 불변', async () => {
    const r = await executeTool({ name: 'split_clip', input: { clipId: 'c1', atSec: 99 } })
    expect(r.ok).toBe(false)
    expect(videoClips().count).toBe(1)
  })

  it('add_text: 자막 클립이 텍스트 트랙에 추가된다', async () => {
    const r = await executeTool({ name: 'add_text', input: { value: '오프닝', atSec: 0, durationSec: 2 } })
    expect(r.ok).toBe(true)
    const textTrack = useEditor.getState().project.tracks.find((t) => t.kind === 'text')!
    const added = textTrack.clips.find((c) => c.text?.value === '오프닝')
    expect(added).toBeTruthy()
  })

  it('apply_filter: 클립 effects 에 반영된다', async () => {
    const r = await executeTool({ name: 'apply_filter', input: { clipId: 'c1', type: 'brightness', value: 0.4 } })
    expect(r.ok).toBe(true)
    const clip = findClip(useEditor.getState().project, 'c1')!.clip
    expect(clip.effects?.some((e) => e.type === 'brightness' && e.params.value === 0.4)).toBe(true)
  })

  it('update_text_style: 프리셋 적용', async () => {
    await executeTool({ name: 'add_text', input: { value: 'A', atSec: 0 } })
    const textTrack = useEditor.getState().project.tracks.find((t) => t.kind === 'text')!
    const id = textTrack.clips[0].id
    const r = await executeTool({ name: 'update_text_style', input: { clipId: id, preset: 'neon' } })
    expect(r.ok).toBe(true)
    const clip = findClip(useEditor.getState().project, id)!.clip
    expect(clip.text?.glow).toBeTruthy() // neon 프리셋은 glow 포함
  })

  it('delete_clip: 확인 게이트 승인 시 삭제된다 (1콜=1 undo)', async () => {
    const before = useEditor.getState().past.length
    const r = await runAuto({ name: 'delete_clip', input: { clipId: 'c1' } })
    expect(r.ok).toBe(true)
    expect(videoClips().count).toBe(0)
    expect(useEditor.getState().past.length).toBe(before + 1) // 정확히 한 번 dispatch
    useEditor.getState().undo()
    expect(videoClips().count).toBe(1) // 되돌리기로 복구
  })

  it('입력 검증 실패 → 한국어 에러', async () => {
    const r = await executeTool({ name: 'apply_filter', input: { clipId: 'c1', type: '없는필터', value: 1 } })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('검증 실패')
  })
})
