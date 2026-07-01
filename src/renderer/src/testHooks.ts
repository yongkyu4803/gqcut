/**
 * e2e 테스트 훅 (1.6) — Playwright 가 다이얼로그 없이 임포트/편집/내보내기를 구동한다.
 * E2E 환경(또는 dev)에서만 주입.
 */
import { createMediaClip } from '@shared/model/factory'
import { useEditor, serializeProject } from './state/store'
import { addClip } from './state/commands'
import { importFile } from './media/import'
import { playback } from './engine/playback'
import { exportTimeline } from './engine/exporter'
import { genId } from '@shared/model/factory'
import { splitClip } from './state/commands'

export function installTestHooks(): void {
  window.__test = {
    async importFile(path: string): Promise<string> {
      const asset = await importFile(path)
      const s = useEditor.getState()
      const track = s.project.tracks.find((t) => (asset.kind === 'audio' ? t.kind === 'audio' : t.kind === 'video'))
      if (track) {
        const end = Math.max(0, ...track.clips.map((c) => c.timelineEnd))
        const clip = createMediaClip(asset, end)
        s.dispatch('타임라인에 추가(e2e)', (p) => addClip(p, track.id, clip))
        s.select(clip.id)
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

    async exportTo(path: string): Promise<{ ok: boolean; error?: string; stats?: { frames: number; elapsedMs: number; mbPerSec: number } }> {
      const handle = exportTimeline(useEditor.getState().project, path, () => {})
      const result = await handle.promise
      return { ok: result.ok, error: result.error, stats: result.stats }
    }
  }
}
