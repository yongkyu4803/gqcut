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
    }
  }
}
