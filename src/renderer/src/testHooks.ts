/**
 * e2e 테스트 훅 (1.6) — Playwright 가 다이얼로그 없이 임포트/편집/내보내기를 구동한다.
 * E2E(또는 dev) 환경에서만 주입.
 */
import { createMediaClip, createTrack, genId } from '@shared/model/factory'
import type { Transition } from '@shared/model/types'
import { useEditor, serializeProject } from './state/store'
import { addClip, addClipOverlay, splitClip, updateClip } from './state/commands'
import { importFile } from './media/import'
import { playback } from './engine/playback'
import { captureReferenceFrame, exportTimeline, DEFAULT_EXPORT_SETTINGS } from './engine/exporter'
import { generateCaptions } from './stt/autoCaption'
import type { SttModel } from '@shared/subtitles'
import { applySilenceCut, cancelSilencePreview, detectSilence } from './silence/autoCut'
import { executeTool } from './ai/executor'
import { useAi } from './ai/aiStore'
import { summarizeProject } from '@shared/aiSummary'
import { importSubtitlesFromSrt } from './subtitles/importSrt'

export function installTestHooks(): void {
  window.__test = {
    async importFile(path: string): Promise<string> {
      const asset = await importFile(path)
      const s = useEditor.getState()
      if (asset.kind === 'image') {
        // 이미지는 오버레이 배치 (MediaBin 과 동일 동작)
        const clip = createMediaClip(asset, s.playhead)
        s.dispatch('오버레이 추가(e2e)', (p) => addClipOverlay(p, clip, createTrack('video')))
        s.select(clip.id)
      } else {
        const track = [...s.project.tracks].reverse().find((t) => (asset.kind === 'audio' ? t.kind === 'audio' : t.kind === 'video'))
        if (track) {
          const end = Math.max(0, ...track.clips.map((c) => c.timelineEnd))
          const clip = createMediaClip(asset, end)
          s.dispatch('타임라인에 추가(e2e)', (p) => addClip(p, track.id, clip))
          s.select(clip.id)
        }
      }
      return asset.id
    },

    splitAtPlayhead(): void {
      const s = useEditor.getState()
      if (!s.selectedClipId) return
      const id = s.selectedClipId
      s.dispatch('클립 분할(e2e)', (p) => splitClip(p, id, s.playhead, genId('clip')))
    },

    seek(t: number): void {
      void playback.seek(t)
    },

    getProjectJson(): string {
      return serializeProject(useEditor.getState().project)
    },

    /** 필터 적용 (4.1) — 첫 비디오 트랙의 모든 클립에 */
    applyFilter(type: string, value: number): void {
      const s = useEditor.getState()
      const track = s.project.tracks.find((t) => t.kind === 'video')
      if (!track) return
      for (const clip of track.clips) {
        s.dispatch('필터(e2e)', (p) => updateClip(p, clip.id, { effects: [{ type, params: { value }, enabled: true }] }))
      }
    },

    /** 전환 적용 (4.2) — 첫 비디오 트랙의 첫 인접 쌍에 */
    applyTransition(type: string, duration: number): void {
      const s = useEditor.getState()
      const track = s.project.tracks.find((t) => t.kind === 'video')
      if (!track || track.clips.length < 2) return
      const sorted = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart)
      const t: Transition = { type, duration }
      s.dispatch('전환(e2e)', (p) => updateClip(p, sorted[0].id, { transitionOut: t }))
    },

    /** 기준 프레임 캡처 (4.2.4/5.2.5) — 내보내기와 동일 경로 렌더의 PNG dataURL */
    captureFrame(t: number): Promise<string> {
      return captureReferenceFrame(useEditor.getState().project, t)
    },

    /** 선택 클립 속성 패치 (페이드/볼륨 등 검증용) */
    setSelectedClip(patch: Record<string, unknown>): void {
      const s = useEditor.getState()
      if (!s.selectedClipId) return
      const id = s.selectedClipId
      s.dispatch('클립 속성(e2e)', (p) => updateClip(p, id, patch))
    },

    /** SRT 자막 가져오기(feature-5) — 파일 다이얼로그 우회, 내용 직접 주입. 배치된 자막 수 반환 */
    importSrt(content: string): number {
      return importSubtitlesFromSrt(content)
    },

    /** 자동 자막 생성(3.2) — 선택된 비디오 클립에서. 생성된 자막 수 반환 */
    generateCaptions(model: string, language: string): Promise<number> {
      const id = useEditor.getState().selectedClipId
      if (!id) return Promise.resolve(0)
      return generateCaptions(id, { model: model as SttModel, language })
    },

    async exportTo(path: string): Promise<{ ok: boolean; error?: string; stats?: { frames: number; elapsedMs: number; mbPerSec: number } }> {
      const handle = exportTimeline(useEditor.getState().project, path, DEFAULT_EXPORT_SETTINGS, () => {})
      const result = await handle.promise
      return { ok: result.ok, error: result.error, stats: result.stats }
    },

    /** 무음 감지 — 선택된 비디오 클립에서. 감지된 후보 구간 수 반환(미리보기 채움, 적용 안 함) */
    detectSilence(noiseDb: number, minDurationSec: number, scope?: 'this-track' | 'all-tracks'): Promise<number> {
      const id = useEditor.getState().selectedClipId
      if (!id) return Promise.resolve(0)
      return detectSilence(id, { noiseDb, minDurationSec, scope })
    },

    /** 무음 감지 후보 구간 선택/해제 토글 */
    toggleSilenceCandidate(id: string): void {
      useEditor.getState().toggleSilenceCandidate(id)
    },

    /** 현재 미리보기의 선택된 구간만 리플 삭제로 적용(단일 undo) */
    applySilenceCut(): void {
      applySilenceCut()
    },

    /** 미리보기 폐기 */
    cancelSilencePreview(): void {
      cancelSilencePreview()
    },

    /** 현재 무음 감지 미리보기 상태(JSON) — e2e 검증용 */
    getSilencePreviewJson(): string {
      return JSON.stringify(useEditor.getState().silencePreview)
    },

    /**
     * AI 도구 시퀀스를 SDK/네트워크 없이 executor 로 직접 실행 (7.2.4 통합 테스트).
     * 확인 게이트는 자동 승인해 파괴적 도구도 진행된다(게이트 UI 는 별도 검증).
     */
    async aiRunTools(calls: Array<{ name: string; input: Record<string, unknown> }>): Promise<Array<{ ok: boolean; message: string }>> {
      const unsub = useAi.subscribe((s) => {
        if (s.pendingConfirm) useAi.getState().resolveConfirm(true)
      })
      try {
        const out: Array<{ ok: boolean; message: string }> = []
        for (const c of calls) {
          const r = await executeTool(c)
          out.push({ ok: r.ok, message: r.message })
        }
        return out
      } finally {
        unsub()
      }
    },

    /**
     * 실제 Agent SDK 로 1턴 실행하고 완료까지 대기 (RUN_AI_E2E gated e2e 7.3.4).
     * 도구 콜백은 마운트된 AiPanel 이 executor 로 처리한다. 확인 게이트는 자동 승인.
     */
    async aiSendAndWait(prompt: string): Promise<void> {
      const unsub = useAi.subscribe((s) => {
        if (s.pendingConfirm) useAi.getState().resolveConfirm(true)
      })
      try {
        const s = useEditor.getState()
        const contextJson = JSON.stringify(summarizeProject(s.project, { selectedClipId: s.selectedClipId, selectedClipIds: s.selectedClipIds, playhead: s.playhead }))
        const requestId = genId('req')
        useAi.getState().pushUser(prompt)
        useAi.getState().beginAssistant(requestId)
        await window.editor.aiSend({ requestId, prompt, contextJson })
      } finally {
        unsub()
      }
    }
  }
}
