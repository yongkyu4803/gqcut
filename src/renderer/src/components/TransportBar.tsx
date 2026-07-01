/**
 * 트랜스포트 — 재생/일시정지/정지, 타임코드, 분할, 텍스트 추가, 저장/열기, 내보내기
 */
import { createTextClip, genId } from '@shared/model/factory'
import { formatTimecode } from '@shared/time'
import { useEditor, serializeProject, deserializeProject } from '@renderer/state/store'
import { addClip, projectDuration, splitClip } from '@renderer/state/commands'
import { playback } from '@renderer/engine/playback'
import { exportTimeline } from '@renderer/engine/exporter'

export function TransportBar(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playhead)
  const playing = useEditor((s) => s.playing)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const past = useEditor((s) => s.past)
  const future = useEditor((s) => s.future)
  const dispatch = useEditor((s) => s.dispatch)
  const { undo, redo } = useEditor.getState()

  const split = (): void => {
    if (!selectedClipId) return
    dispatch('클립 분할', (p) => splitClip(p, selectedClipId, playhead, genId('clip')))
  }

  const addText = (): void => {
    const track = project.tracks.find((t) => t.kind === 'text')
    if (!track) return
    const clip = createTextClip(playhead)
    dispatch('텍스트 추가', (p) => addClip(p, track.id, clip))
    useEditor.getState().select(clip.id)
  }

  const save = async (): Promise<void> => {
    await window.editor.saveProjectDialog(serializeProject(project))
  }

  const open = async (): Promise<void> => {
    const result = await window.editor.openProjectDialog()
    if (!result) return
    try {
      useEditor.getState().replaceProject(deserializeProject(result.json))
      playback.preloadAudio(useEditor.getState().project)
      playback.refresh()
    } catch (e) {
      alert(`프로젝트 열기 실패: ${e instanceof Error ? e.message : e}`)
    }
  }

  const doExport = async (): Promise<void> => {
    const out = await window.editor.saveFileDialog(`${project.name}.mp4`)
    if (!out) return
    playback.pause()
    const handle = exportTimeline(project, out, (percent) => {
      useEditor.getState().setExportProgress({ active: true, percent, cancel: handle.cancel })
    })
    useEditor.getState().setExportProgress({ active: true, percent: 0, cancel: handle.cancel })
    const result = await handle.promise
    useEditor.getState().setExportProgress(null)
    if (!result.ok && result.error !== 'cancelled') alert(`내보내기 실패: ${result.error}`)
  }

  return (
    <div className="transport">
      <button className="btn" onClick={() => void open()}>
        열기
      </button>
      <button className="btn" onClick={() => void save()}>
        저장
      </button>
      <span className="sep" />
      <button className="btn" disabled={past.length === 0} onClick={undo} title="⌘Z">
        ↩ 실행취소
      </button>
      <button className="btn" disabled={future.length === 0} onClick={redo} title="⇧⌘Z">
        ↪ 다시실행
      </button>
      <span className="sep" />
      <button className="btn primary" data-testid="play-btn" onClick={() => void playback.toggle()}>
        {playing ? '⏸ 일시정지' : '▶ 재생'}
      </button>
      <span className="timecode" data-testid="timecode">
        {formatTimecode(playhead, project.settings.fps)} / {formatTimecode(projectDuration(project), project.settings.fps)}
      </span>
      <span className="sep" />
      <button className="btn" data-testid="split-btn" disabled={!selectedClipId} onClick={split} title="S">
        ✂ 분할
      </button>
      <button className="btn" data-testid="add-text-btn" onClick={addText}>
        T 텍스트
      </button>
      <span className="flex-spacer" />
      <button className="btn export" data-testid="export-btn" onClick={() => void doExport()}>
        ⬆ 내보내기 (H.264)
      </button>
    </div>
  )
}
