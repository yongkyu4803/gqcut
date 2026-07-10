/**
 * 트랜스포트 — 재생/일시정지/정지, 타임코드, 분할, 텍스트 추가, 저장/열기, 내보내기
 */
import { useState } from 'react'
import { createProject, createTextClip, genId } from '@shared/model/factory'
import { formatTimecode } from '@shared/time'
import { useEditor, serializeProject, deserializeProject } from '@renderer/state/store'
import { addClip, canMergeClip, projectDuration, splitClip, mergeClip } from '@renderer/state/commands'
import { importSubtitlesFromSrt } from '@renderer/subtitles/importSrt'
import { playback } from '@renderer/engine/playback'
import { exportTimeline, type ExportSettings } from '@renderer/engine/exporter'
import { applyTheme, getStoredTheme, type Theme } from '@renderer/theme'
import { ExportDialog } from './ExportDialog'

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

  const merge = (): void => {
    if (!selectedClipId) return
    dispatch('컷 병합', (p) => mergeClip(p, selectedClipId))
  }
  const mergeable = selectedClipId ? canMergeClip(project, selectedClipId) : false

  const addText = (): void => {
    const track = project.tracks.find((t) => t.kind === 'text')
    if (!track) return
    // 위치 일관성: 직전 자막 위치를 새 자막의 기본값으로 상속 (매번 중앙에서 시작하지 않음)
    const last = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart).at(-1)
    const clip = createTextClip(playhead, undefined, last?.transform)
    dispatch('텍스트 추가', (p) => addClip(p, track.id, clip))
    useEditor.getState().select(clip.id)
  }

  // 자막 SRT 가져오기 (feature-5)
  const importSubtitles = async (): Promise<void> => {
    const file = await window.editor.openSrtDialog()
    if (!file) return
    const n = importSubtitlesFromSrt(file.content)
    if (n === 0) {
      alert('가져올 자막을 찾지 못했습니다. SRT 형식을 확인하세요.')
      return
    }
    playback.refresh()
  }

  const [showExportDialog, setShowExportDialog] = useState(false)
  const projectPath = useEditor((s) => s.projectPath)

  const [theme, setTheme] = useState<Theme>(getStoredTheme)
  const toggleTheme = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    setTheme(next)
  }

  const save = async (): Promise<void> => {
    const json = serializeProject(project)
    if (projectPath) {
      await window.editor.saveProject(projectPath, json)
    } else {
      const path = await window.editor.saveProjectDialog(json)
      if (path) useEditor.getState().setProjectPath(path)
    }
    await window.editor.clearAutosave()
    useEditor.getState().markSaved()
  }

  /** 새 프로젝트 — 미저장 변경이 있으면 확인 후 빈 프로젝트로 초기화 */
  const newProject = (): void => {
    const s = useEditor.getState()
    const dirty = s.past.length !== s.savedRevision
    if (dirty && !confirm('저장되지 않은 변경이 있습니다.\n버리고 새 프로젝트를 시작할까요?')) return
    playback.pause()
    s.replaceProject(createProject())
    s.setProjectPath(null)
    void window.editor.clearAutosave()
    playback.refresh()
  }

  const open = async (): Promise<void> => {
    const result = await window.editor.openProjectDialog()
    if (!result) return
    try {
      useEditor.getState().replaceProject(deserializeProject(result.json))
      useEditor.getState().setProjectPath(result.path)
      playback.preloadAudio(useEditor.getState().project)
      playback.refresh()
    } catch (e) {
      alert(`프로젝트 열기 실패: ${e instanceof Error ? e.message : e}`)
    }
  }

  const doExport = async (settings: ExportSettings): Promise<void> => {
    setShowExportDialog(false)
    const out = await window.editor.saveFileDialog(`${project.name}.mp4`)
    if (!out) return
    playback.pause()
    const handle = exportTimeline(project, out, settings, (percent) => {
      useEditor.getState().setExportProgress({ active: true, percent, cancel: handle.cancel })
    })
    useEditor.getState().setExportProgress({ active: true, percent: 0, cancel: handle.cancel })
    const result = await handle.promise
    useEditor.getState().setExportProgress(null)
    if (!result.ok && result.error !== 'cancelled') alert(`내보내기 실패: ${result.error}`)
  }

  return (
    <div className="transport">
      <button className="btn" data-testid="new-project-btn" onClick={newProject} title="새 프로젝트">
        ＋ 새로 만들기
      </button>
      <button className="btn" onClick={() => void open()}>
        열기
      </button>
      <button className="btn" onClick={() => void save()}>
        저장
      </button>
      <span className="sep" />
      <button className="btn" disabled={past.length === 0} onClick={undo} title="R / ⌘Z">
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
      <button className="btn" data-testid="split-btn" disabled={!selectedClipId} onClick={split} title="C / S">
        ✂ 분할
      </button>
      <button className="btn" data-testid="merge-btn" disabled={!mergeable} onClick={merge} title="M">
        ⛓ 병합
      </button>
      <button className="btn" data-testid="add-text-btn" onClick={addText}>
        T 텍스트
      </button>
      <button className="btn" data-testid="import-srt-btn" onClick={() => void importSubtitles()} title="SRT 자막 파일 가져오기">
        ⬇ 자막
      </button>
      <span className="flex-spacer" />
      <button
        className="btn"
        data-testid="theme-toggle"
        onClick={toggleTheme}
        title={theme === 'dark' ? '라이트(베이지) 모드로 전환' : '다크 모드로 전환'}
      >
        {theme === 'dark' ? '☀️ 라이트' : '🌙 다크'}
      </button>
      <button className="btn export" data-testid="export-btn" onClick={() => setShowExportDialog(true)}>
        ⬆ 내보내기 (H.264)
      </button>
      {showExportDialog && <ExportDialog onConfirm={(s) => void doExport(s)} onClose={() => setShowExportDialog(false)} />}
    </div>
  )
}
