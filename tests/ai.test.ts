/**
 * AI 편집 어시스턴트 유닛/통합 테스트 (7.2.4) — SDK/네트워크 없이.
 *  - 도구 스키마(aiTools) 검증
 *  - 상태 요약기(aiSummary)
 *  - executor 매핑: 툴콜 → 프로젝트 상태 단언 (모의 툴콜 시퀀스)
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { MediaAsset, Project } from '@shared/model/types'
import { createMediaClip, createProject, createSubtitleClip, subtitleBottomY } from '@shared/model/factory'
import { AI_TOOLS, AI_TOOL_BY_NAME, AI_TOOL_NAMES } from '@shared/aiTools'
import { summarizeProject } from '@shared/aiSummary'
import { rangesCoverage } from '@shared/silence'
import { bottomSafeLineFromCenter } from '@shared/safeArea'
import { useEditor } from '../src/renderer/src/state/store'
import { useAi } from '../src/renderer/src/ai/aiStore'
import { executeTool } from '../src/renderer/src/ai/executor'
import { addClip, findClip } from '../src/renderer/src/state/commands'

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
    // 7.4: 무음 컷은 감지(비파괴)/적용(파괴) 2단계로 분리됨
    expect(AI_TOOL_BY_NAME.get('apply_silence_cut')!.destructive).toBe(true)
    expect(AI_TOOL_BY_NAME.get('remove_silence')!.destructive).toBeFalsy()
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

  it('add_text: 자막 클립이 텍스트 트랙에 추가되고 기본 위치가 화면 하단 기준선이다', async () => {
    const r = await executeTool({ name: 'add_text', input: { value: '오프닝', atSec: 0, durationSec: 2 } })
    expect(r.ok).toBe(true)
    const textTrack = useEditor.getState().project.tracks.find((t) => t.kind === 'text')!
    const added = textTrack.clips.find((c) => c.text?.value === '오프닝')
    expect(added).toBeTruthy()
    // 정중앙(y=0)이 아니라 하단(양수 = 아래) 기준선에 배치
    expect(added!.transform!.y).toBeGreaterThan(0)
    expect(added!.transform!.y).toBe(subtitleBottomY(1080, added!.text!.fontSize))
  })

  it('add_text: position 으로 중앙/상단 배치도 가능', async () => {
    await executeTool({ name: 'add_text', input: { value: '중앙제목', atSec: 0, position: 'center' } })
    await executeTool({ name: 'add_text', input: { value: '상단제목', atSec: 0, position: 'top' } })
    const clips = useEditor.getState().project.tracks.filter((t) => t.kind === 'text').flatMap((t) => t.clips)
    const center = clips.find((c) => c.text?.value === '중앙제목')!
    const top = clips.find((c) => c.text?.value === '상단제목')!
    expect(center.transform!.y).toBe(0)
    expect(top.transform!.y).toBeLessThan(0) // 중앙보다 위
  })

  it('apply_filter: 클립 effects 에 반영된다', async () => {
    const r = await executeTool({ name: 'apply_filter', input: { clipId: 'c1', type: 'brightness', value: 0.4 } })
    expect(r.ok).toBe(true)
    const clip = findClip(useEditor.getState().project, 'c1')!.clip
    expect(clip.effects?.some((e) => e.type === 'brightness' && e.params.value === 0.4)).toBe(true)
  })

  it('set_transform: flipH 를 토글해도 다른 필드는 유지된다', async () => {
    await executeTool({ name: 'set_transform', input: { clipId: 'c1', scale: 1.5, rotation: 10 } })
    const r = await executeTool({ name: 'set_transform', input: { clipId: 'c1', flipH: true } })
    expect(r.ok).toBe(true)
    const clip = findClip(useEditor.getState().project, 'c1')!.clip
    expect(clip.transform?.flipH).toBe(true)
    expect(clip.transform?.scale).toBe(1.5) // 이전 값 보존
    expect(clip.transform?.rotation).toBe(10)
  })

  it('apply_color_preset: 세피아 적용 후 다른 프리셋으로 교체 가능', async () => {
    const r = await executeTool({ name: 'apply_color_preset', input: { clipId: 'c1', preset: 'sepia' } })
    expect(r.ok).toBe(true)
    let clip = findClip(useEditor.getState().project, 'c1')!.clip
    expect(clip.effects?.some((e) => e.type === 'tint')).toBe(true)

    await executeTool({ name: 'apply_color_preset', input: { clipId: 'c1', preset: 'noir' } })
    clip = findClip(useEditor.getState().project, 'c1')!.clip
    expect(clip.effects?.some((e) => e.type === 'tint')).toBe(false) // 세피아의 tint 가 교체됨
    expect(clip.effects?.find((e) => e.type === 'saturation')?.params.value).toBe(0)
  })

  it('apply_color_preset: 존재하지 않는 clipId → 한국어 에러', async () => {
    const r = await executeTool({ name: 'apply_color_preset', input: { clipId: 'nope', preset: 'sepia' } })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('찾을 수 없습니다')
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

describe('자막 하단 기준선 배치', () => {
  it('subtitleBottomY: 중앙보다 아래(양수)이고 화면 안, 큰 글자는 하단선 유지 위해 중심이 더 위', () => {
    const y48 = subtitleBottomY(1080, 48)
    const y96 = subtitleBottomY(1080, 96)
    expect(y48).toBeGreaterThan(0) // 중앙 기준 아래
    expect(y48).toBeLessThan(540) // 화면 밖으로 넘어가지 않음
    expect(y96).toBeLessThan(y48) // 글자가 크면 하단 기준선을 맞추려 중심이 위로
  })

  it('createSubtitleClip(자동 자막): 하단 기준선 y 를 사용한다', () => {
    const c = createSubtitleClip(0, 2, '자막', 1080)
    expect(c.transform!.y).toBe(subtitleBottomY(1080, c.text!.fontSize))
    expect(c.transform!.y).toBeGreaterThan(0)
  })

  it('자막 하단이 프리뷰 하단 가이드선(edgeY)에 정렬된다 (가이드선보다 위에 있던 문제 수정)', () => {
    const H = 1080
    const fs = 48
    const approxHalf = fs * 0.9
    // 텍스트 블록 하단(중앙 기준) === 하단 세이프 가이드선. (옛 0.4H 타깃이면 432 ≠ 486 으로 실패)
    expect(subtitleBottomY(H, fs) + approxHalf).toBeCloseTo(bottomSafeLineFromCenter(H), 0)
    // guides.test 의 edgeY(±486)와 동일 기준선인지
    expect(bottomSafeLineFromCenter(1080)).toBe(486)
  })
})

describe('무음 컷 안전장치 (7.4 — 사고 재발 방지)', () => {
  function setPreview(cands: Array<[number, number]>, detectedByAiRequest?: string): void {
    const track = useEditor.getState().project.tracks.find((t) => t.kind === 'video')!
    useEditor.getState().setSilencePreview({
      trackId: track.id,
      clipId: 'c1',
      scope: 'this-track',
      candidates: cands.map(([start, end], i) => ({ id: `sc${i}`, start, end, selected: true })),
      ...(detectedByAiRequest ? { detectedByAiRequest } : {})
    })
  }

  beforeEach(() => {
    useEditor.getState().replaceProject(projectWithVideo()) // 클립 c1: 0~10s
    useEditor.getState().select('c1')
    useAi.setState({ pendingConfirm: null, confirmQueue: [], currentRequestId: null, running: false, activeAssistantId: null })
  })

  it('rangesCoverage: 전체=1, 부분=0.1, 겹침 병합, 클램프', () => {
    expect(rangesCoverage([[0, 10]], 0, 10)).toBeCloseTo(1)
    expect(rangesCoverage([[2, 3]], 0, 10)).toBeCloseTo(0.1)
    expect(rangesCoverage([[0, 6], [4, 10]], 0, 10)).toBeCloseTo(1) // 겹침은 이중 카운트 안 함
    expect(rangesCoverage([[-5, 15]], 0, 10)).toBeCloseTo(1) // 클립 경계로 클램프
    expect(rangesCoverage([], 0, 10)).toBe(0)
  })

  it('확인 게이트 큐잉: 동시 2건이 순서대로 모두 resolve (덮어쓰기 행 없음)', async () => {
    const p1 = useAi.getState().requestConfirm('A', 'a')
    const p2 = useAi.getState().requestConfirm('B', 'b')
    expect(useAi.getState().pendingConfirm?.title).toBe('A')
    expect(useAi.getState().confirmQueue.length).toBe(1)
    useAi.getState().resolveConfirm(true)
    await expect(p1).resolves.toBe(true)
    expect(useAi.getState().pendingConfirm?.title).toBe('B') // 다음 확인창 활성화
    useAi.getState().resolveConfirm(false)
    await expect(p2).resolves.toBe(false)
    expect(useAi.getState().pendingConfirm).toBeNull()
  })

  it('remove_silence 는 아무것도 삭제하지 않는다(감지 전용) — 하지만 IPC 없이는 감지 자체가 실패해도 상태 불변', async () => {
    // 감지는 main IPC 를 타므로 유닛에선 실패 경로로 떨어지지만, 어떤 경우에도 dispatch 는 없어야 한다
    const before = useEditor.getState().past.length
    const r = await executeTool({ name: 'remove_silence', input: { clipId: 'c1' } })
    expect(r.ok).toBe(false) // window.editor.silenceDetect 없음 → 감지 실패(삭제 아님)
    expect(useEditor.getState().past.length).toBe(before) // 절대 삭제하지 않음
    expect(videoClips().count).toBe(1)
  })

  it('apply_silence_cut: 미리보기 없음 → 에러', async () => {
    useEditor.getState().setSilencePreview(null)
    const r = await executeTool({ name: 'apply_silence_cut', input: {} })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/미리보기가 없|먼저 remove_silence/)
  })

  it('apply_silence_cut: 클립 전체(≥95%) 커버 → 자동 적용 거부, 상태 불변, 미리보기 유지', async () => {
    setPreview([[0, 10]]) // 클립 전체가 무음(감지 오류 시나리오 = 사고 재현)
    const before = useEditor.getState().past.length
    const r = await runAuto({ name: 'apply_silence_cut', input: {} }) // 확인 자동 승인이어도
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/통째로|100%|전체 삭제/)
    expect(useEditor.getState().past.length).toBe(before) // 삭제 안 됨
    expect(videoClips().count).toBe(1)
    expect(useEditor.getState().silencePreview).toBeTruthy() // 미리보기 유지(재감지 유도)
  })

  it('apply_silence_cut: 부분 무음 → 확인 후 적용(리플, 1 undo), 미리보기 비움', async () => {
    setPreview([[2, 3]]) // 10초 중 1초(10%)
    const before = useEditor.getState().past.length
    const r = await runAuto({ name: 'apply_silence_cut', input: {} })
    expect(r.ok).toBe(true)
    expect(useEditor.getState().past.length).toBe(before + 1)
    expect(useEditor.getState().silencePreview).toBeNull()
  })

  it('apply_silence_cut: 같은 응답(run) 안 감지→적용 연쇄 차단', async () => {
    useAi.setState({ currentRequestId: 'R' }) // 실행 중
    setPreview([[2, 3]], 'R') // 이번 run 에서 감지된 미리보기
    const before = useEditor.getState().past.length
    const r = await runAuto({ name: 'apply_silence_cut', input: {} })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/이번 응답|다음 응답|확인/)
    expect(useEditor.getState().past.length).toBe(before) // 적용 안 됨
  })

  it('apply_silence_cut: 다른 응답에서 감지한 미리보기는 적용 가능(교차 턴)', async () => {
    useAi.setState({ currentRequestId: 'R2' }) // 새 응답
    setPreview([[2, 3]], 'R1') // 이전 응답 R1 에서 감지됨
    const before = useEditor.getState().past.length
    const r = await runAuto({ name: 'apply_silence_cut', input: {} })
    expect(r.ok).toBe(true) // R1 !== R2 → 차단 안 됨
    expect(useEditor.getState().past.length).toBe(before + 1)
  })
})

/** 인접한 두 비디오 클립 c1[0,5]/c2[5,10] — 전환·속도 테스트용 */
function projectTwoClips(): Project {
  const p = createProject()
  const asset: MediaAsset = { id: 'a1', kind: 'video', path: '/tmp/clip.mp4', duration: 10, status: 'ok', hasAudio: true }
  const videoTrackId = p.tracks.find((t) => t.kind === 'video')!.id
  const c1 = { ...createMediaClip(asset, 0), id: 'c1', timelineStart: 0, timelineEnd: 5, sourceIn: 0, sourceOut: 5 }
  const c2 = { ...createMediaClip(asset, 5), id: 'c2', timelineStart: 5, timelineEnd: 10, sourceIn: 5, sourceOut: 10 }
  let out: Project = { ...p, assets: [asset] }
  out = addClip(out, videoTrackId, c1)
  out = addClip(out, videoTrackId, c2)
  return out
}

describe('신규 도구: 속도/전환 효과음/SRT/다중선택/테마 (AI 전면 접근)', () => {
  it('스키마: set_speed·import_subtitles·select_clips·set_theme·add_transition(sound)', () => {
    expect(z.object(AI_TOOL_BY_NAME.get('set_speed')!.shape).safeParse({ clipId: 'c1', speed: 0.5 }).success).toBe(true)
    expect(z.object(AI_TOOL_BY_NAME.get('set_speed')!.shape).safeParse({ clipId: 'c1', speed: 9 }).success).toBe(false)
    expect(z.object(AI_TOOL_BY_NAME.get('import_subtitles')!.shape).safeParse({ srt: '1\n...' }).success).toBe(true)
    expect(z.object(AI_TOOL_BY_NAME.get('select_clips')!.shape).safeParse({ clipIds: ['c1', 'c2'] }).success).toBe(true)
    expect(z.object(AI_TOOL_BY_NAME.get('select_clips')!.shape).safeParse({ clipIds: [] }).success).toBe(false)
    expect(z.object(AI_TOOL_BY_NAME.get('set_theme')!.shape).safeParse({ theme: 'light' }).success).toBe(true)
    expect(z.object(AI_TOOL_BY_NAME.get('set_theme')!.shape).safeParse({ theme: 'sepia' }).success).toBe(false)
    const tr = z.object(AI_TOOL_BY_NAME.get('add_transition')!.shape)
    expect(tr.safeParse({ clipId: 'c1', type: 'dissolve', sound: 'whoosh' }).success).toBe(true)
    expect(tr.safeParse({ clipId: 'c1', type: 'dissolve', sound: '없는효과음' }).success).toBe(false)
  })

  beforeEach(() => {
    useEditor.getState().replaceProject(projectTwoClips())
    useAi.getState().clear()
  })

  it('set_speed: 0.5배 → 클립 길이 2배, 뒤 클립 리플', async () => {
    const r = await executeTool({ name: 'set_speed', input: { clipId: 'c1', speed: 0.5 } })
    expect(r.ok).toBe(true)
    const c1 = findClip(useEditor.getState().project, 'c1')!.clip
    expect(c1.speed).toBe(0.5)
    expect(c1.timelineEnd).toBeCloseTo(10, 5) // 5 / 0.5
    expect(findClip(useEditor.getState().project, 'c2')!.clip.timelineStart).toBeCloseTo(10, 5)
  })

  it('add_transition: 효과음 지정 + duration 클립 길이로 클램프', async () => {
    // 짧은 클립(1.5s)으로 만들어 스키마 상한(5s) 이내 값이 클립 길이로 클램프되는지 확인
    const p = createProject()
    const asset: MediaAsset = { id: 'a1', kind: 'video', path: '/tmp/clip.mp4', duration: 10, status: 'ok', hasAudio: true }
    const vt = p.tracks.find((t) => t.kind === 'video')!.id
    let sp: Project = { ...p, assets: [asset] }
    sp = addClip(sp, vt, { ...createMediaClip(asset, 0), id: 'c1', timelineStart: 0, timelineEnd: 1.5, sourceIn: 0, sourceOut: 1.5 })
    sp = addClip(sp, vt, { ...createMediaClip(asset, 0), id: 'c2', timelineStart: 1.5, timelineEnd: 3, sourceIn: 1.5, sourceOut: 3 })
    useEditor.getState().replaceProject(sp)
    const r = await executeTool({ name: 'add_transition', input: { clipId: 'c1', type: 'dissolve', durationSec: 5, sound: 'whoosh' } })
    expect(r.ok).toBe(true)
    const c1 = findClip(useEditor.getState().project, 'c1')!.clip
    expect(c1.transitionOut?.type).toBe('dissolve')
    expect(c1.transitionOut?.duration).toBeCloseTo(1.5, 5) // maxDur=min(1.5,1.5), 5 → 1.5 로 클램프
    expect(c1.transitionOut?.sound?.id).toBe('whoosh')
  })

  it('add_transition: 비인접(마지막) 클립엔 거부', async () => {
    const r = await executeTool({ name: 'add_transition', input: { clipId: 'c2', type: 'dissolve' } })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/맞닿아/)
    expect(findClip(useEditor.getState().project, 'c2')!.clip.transitionOut).toBeUndefined()
  })

  it('add_transition: sound=none 으로 기존 효과음 제거(전환은 유지)', async () => {
    await executeTool({ name: 'add_transition', input: { clipId: 'c1', type: 'wipe', sound: 'pop' } })
    const r = await executeTool({ name: 'add_transition', input: { clipId: 'c1', type: 'wipe', sound: 'none' } })
    expect(r.ok).toBe(true)
    const c1 = findClip(useEditor.getState().project, 'c1')!.clip
    expect(c1.transitionOut?.type).toBe('wipe')
    expect(c1.transitionOut?.sound).toBeUndefined()
  })

  it('import_subtitles: SRT 파싱 → 자막 트랙 배치', async () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n안녕\n\n2\n00:00:03,000 --> 00:00:04,000\n반가워'
    const r = await executeTool({ name: 'import_subtitles', input: { srt } })
    expect(r.ok).toBe(true)
    const textTrack = useEditor.getState().project.tracks.find((t) => t.kind === 'text')!
    expect(textTrack.clips.length).toBe(2)
  })

  it('select_clips: 여러 클립 다중 선택', async () => {
    const r = await executeTool({ name: 'select_clips', input: { clipIds: ['c1', 'c2'] } })
    expect(r.ok).toBe(true)
    expect(new Set(useEditor.getState().selectedClipIds)).toEqual(new Set(['c1', 'c2']))
  })
})

describe('요약기: 전환 효과음 + 다중 선택 표기', () => {
  it('transitionSound 와 selectedClipIds 를 담는다', () => {
    const p = projectTwoClips()
    const withSound: Project = {
      ...p,
      tracks: p.tracks.map((t) =>
        t.kind === 'video'
          ? { ...t, clips: t.clips.map((c) => (c.id === 'c1' ? { ...c, transitionOut: { type: 'dissolve', duration: 1, sound: { id: 'whoosh' } } } : c)) }
          : t
      )
    }
    const s = summarizeProject(withSound, { selectedClipId: 'c2', selectedClipIds: ['c1', 'c2'], playhead: 0 })
    expect(s.selectedClipIds).toEqual(['c1', 'c2'])
    const vt = s.tracks.find((t) => t.kind === 'video')!
    expect(vt.clips.find((c) => c.id === 'c1')!.transitionSound).toBe('whoosh')
    // 둘 다 selected 표기
    expect(vt.clips.filter((c) => c.selected).map((c) => c.id).sort()).toEqual(['c1', 'c2'])
  })
})
