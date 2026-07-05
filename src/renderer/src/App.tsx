import { useEffect } from 'react'
import { MediaBin } from './components/MediaBin'
import { Preview } from './components/Preview'
import { Inspector } from './components/Inspector'
import { TransportBar } from './components/TransportBar'
import { Timeline } from './components/Timeline'
import { useEditor, serializeProject, deserializeProject } from './state/store'
import { findClip, removeClip, addClip, splitClip, mergeClip } from './state/commands'
import { genId } from '@shared/model/factory'
import type { Clip } from '@shared/model/types'
import { playback } from './engine/playback'
import { installTestHooks } from './testHooks'

let clipboard: Clip | null = null

export default function App(): React.JSX.Element {
  const exportProgress = useEditor((s) => s.exportProgress)
  const sttProgress = useEditor((s) => s.sttProgress)
  const silenceProgress = useEditor((s) => s.silenceProgress)

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
      } else if ((mod && e.key === 'z' && !e.shiftKey) || (e.key === 'r' && !mod)) {
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
      } else if ((e.key === 's' || e.key === 'c') && !mod && s.selectedClipId) {
        const id = s.selectedClipId
        s.dispatch('클립 분할', (p) => splitClip(p, id, s.playhead, genId('clip')))
      } else if (e.key === 'm' && !mod && s.selectedClipId) {
        const id = s.selectedClipId
        s.dispatch('컷 병합', (p) => mergeClip(p, id))
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
    if (window.editor.isE2E || import.meta.env.DEV) installTestHooks()
  }, [])

  // 자동저장 (6.1.2): 30초마다 미저장 변경이 있으면 자동저장. 시작 시 복구 제안.
  useEffect(() => {
    let lastAutosavedRevision = -1
    const interval = setInterval(() => {
      const s = useEditor.getState()
      if (s.exportProgress?.active) return
      const revision = s.past.length
      if (revision !== s.savedRevision && revision !== lastAutosavedRevision) {
        lastAutosavedRevision = revision
        void window.editor.autosave(serializeProject(s.project), s.projectPath)
      }
    }, 30_000)

    // 크래시 복구 (E2E 에선 비활성 — 다이얼로그가 테스트를 막음)
    if (!window.editor.isE2E) {
      void window.editor.checkAutosave().then((auto) => {
        if (!auto) return
        const restore = confirm(`저장되지 않은 작업이 있습니다 (${new Date(auto.savedAt).toLocaleString()}).\n복구할까요?`)
        if (restore) {
          try {
            useEditor.getState().replaceProject(deserializeProject(auto.json))
            useEditor.getState().setProjectPath(auto.originalPath)
            playback.preloadAudio(useEditor.getState().project)
            playback.refresh()
          } catch (e) {
            alert(`복구 실패: ${e instanceof Error ? e.message : e}`)
          }
        } else {
          void window.editor.clearAutosave()
        }
      })
    }
    return () => clearInterval(interval)
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

      {sttProgress?.active && (
        <div className="export-overlay" data-testid="stt-overlay">
          <div className="export-dialog">
            <h3>자동 자막</h3>
            <span>{sttProgress.phase}</span>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${sttProgress.percent}%` }} />
            </div>
            <button className="btn" onClick={() => sttProgress.cancel?.()}>
              취소
            </button>
          </div>
        </div>
      )}

      {silenceProgress?.active && (
        <div className="export-overlay" data-testid="silence-overlay">
          <div className="export-dialog">
            <h3>무음 감지 중…</h3>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${silenceProgress.percent}%` }} />
            </div>
            <button className="btn" onClick={() => silenceProgress.cancel?.()}>
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
