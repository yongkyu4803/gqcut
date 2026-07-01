import { useEffect } from 'react'
import { MediaBin } from './components/MediaBin'
import { Preview } from './components/Preview'
import { Inspector } from './components/Inspector'
import { TransportBar } from './components/TransportBar'
import { Timeline } from './components/Timeline'
import { useEditor } from './state/store'
import { findClip, removeClip, addClip, splitClip } from './state/commands'
import { genId } from '@shared/model/factory'
import type { Clip } from '@shared/model/types'
import { playback } from './engine/playback'
import { installTestHooks } from './testHooks'

let clipboard: Clip | null = null

export default function App(): React.JSX.Element {
  const exportProgress = useEditor((s) => s.exportProgress)

  // 전역 단축키 (1.2.6)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return
      const s = useEditor.getState()
      const mod = e.metaKey || e.ctrlKey

      if (e.code === 'Space') {
        e.preventDefault()
        void playback.toggle()
      } else if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        s.undo()
        playback.refresh()
      } else if (mod && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        s.redo()
        playback.refresh()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selectedClipId) {
        e.preventDefault()
        const id = s.selectedClipId
        s.dispatch('클립 삭제', (p) => removeClip(p, id))
        s.select(null)
      } else if (e.key === 's' && !mod && s.selectedClipId) {
        const id = s.selectedClipId
        s.dispatch('클립 분할', (p) => splitClip(p, id, s.playhead, genId('clip')))
      } else if (mod && e.key === 'c' && s.selectedClipId) {
        const found = findClip(s.project, s.selectedClipId)
        if (found) clipboard = found.clip
      } else if (mod && e.key === 'v' && clipboard) {
        e.preventDefault()
        const src = clipboard
        const len = src.timelineEnd - src.timelineStart
        const track = s.project.tracks.find((t) => t.clips.some((c) => c.kind === src.kind)) ?? s.project.tracks.find((t) => (src.kind === 'text' ? t.kind === 'text' : src.kind === 'audio' ? t.kind === 'audio' : t.kind === 'video'))
        if (track) {
          const pasted: Clip = { ...src, id: genId('clip'), timelineStart: s.playhead, timelineEnd: s.playhead + len }
          s.dispatch('붙여넣기', (p) => addClip(p, track.id, pasted))
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const fps = s.project.settings.fps
        const step = (e.shiftKey ? 10 : 1) / fps
        void playback.seek(s.playhead + (e.key === 'ArrowLeft' ? -step : step))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    installTestHooks()
  }, [])

  return (
    <div className="app">
      <div className="main-row">
        <MediaBin />
        <Preview />
        <Inspector />
      </div>
      <TransportBar />
      <Timeline />

      {exportProgress?.active && (
        <div className="export-overlay" data-testid="export-overlay">
          <div className="export-dialog">
            <h3>내보내는 중…</h3>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${exportProgress.percent}%` }} />
            </div>
            <span>{Math.round(exportProgress.percent)}%</span>
            <button className="btn" onClick={() => exportProgress.cancel?.()}>
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
