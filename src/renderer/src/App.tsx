import { useEffect, useRef, useState } from 'react'
import { MediaBin } from './components/MediaBin'
import { Preview } from './components/Preview'
import { RightPanel } from './components/RightPanel'
import { TransportBar } from './components/TransportBar'
import { Timeline } from './components/Timeline'
import { useEditor, serializeProject, deserializeProject } from './state/store'
import { findClip, removeClip, addClip, splitClip, mergeClip } from './state/commands'
import { genId } from '@shared/model/factory'
import type { Clip } from '@shared/model/types'
import { playback } from './engine/playback'
import { installTestHooks } from './testHooks'

let clipboard: Clip | null = null

/** 실제 글자를 입력하는 필드인가 (텍스트 input / textarea / contenteditable). 여기선 단축키를 양보한다. */
function isTextEntry(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName === 'INPUT') {
    const t = (el as HTMLInputElement).type
    return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(t)
  }
  return false
}

export default function App(): React.JSX.Element {
  const exportProgress = useEditor((s) => s.exportProgress)
  const sttProgress = useEditor((s) => s.sttProgress)
  const silenceProgress = useEditor((s) => s.silenceProgress)

  // 상단(미리보기) 영역 높이 조절 — 타임라인은 남는 공간을 전부 차지(flex:1)하므로,
  // 위쪽을 줄이면 타임라인이 그만큼 커진다. 트랙이 많아도 스크롤 대신 최대한 펼쳐진다.
  const [topH, setTopH] = useState<number>(() => {
    const saved = Number(localStorage.getItem('topPaneHeight'))
    return saved >= 160 ? saved : 360
  })
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null)
  useEffect(() => {
    localStorage.setItem('topPaneHeight', String(topH))
  }, [topH])
  const onResizeDown = (e: React.PointerEvent): void => {
    resizeRef.current = { startY: e.clientY, startH: topH }
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }
  const onResizeMove = (e: React.PointerEvent): void => {
    const r = resizeRef.current
    if (!r) return
    // 위로 끌면(clientY 감소) 상단이 줄고 타임라인이 커진다. 타임라인 최소 140px 확보.
    const max = Math.max(200, window.innerHeight - 140)
    setTopH(Math.min(max, Math.max(160, r.startH + (e.clientY - r.startY))))
  }
  const onResizeUp = (): void => {
    resizeRef.current = null
  }

  // 전역 단축키 (1.2.6)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 글자 입력 필드(텍스트 input/textarea)에서만 단축키를 양보한다.
      // 슬라이더(range)·셀렉트·버튼 등은 조작 후에도 단축키가 살아 있도록(아래 자동 blur 와 함께).
      if (isTextEntry(e.target as Element) || (e.target as HTMLElement)?.tagName === 'SELECT') return
      const s = useEditor.getState()
      const mod = e.metaKey || e.ctrlKey

      // 글자 단축키는 e.code(물리 키)로 판정한다 — 한글 IME 가 켜져 있으면 e.key 가 'ㅊ' 등으로 바뀌어
      // e.key === 'c' 비교가 실패하기 때문. e.code 는 자판·IME 와 무관하게 'KeyC' 로 고정.
      if (e.code === 'Space') {
        e.preventDefault()
        void playback.toggle()
      } else if ((mod && e.code === 'KeyZ' && !e.shiftKey) || (e.code === 'KeyR' && !mod)) {
        e.preventDefault()
        s.undo()
        playback.refresh()
      } else if (mod && e.code === 'KeyZ' && e.shiftKey) {
        e.preventDefault()
        s.redo()
        playback.refresh()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selectedClipIds.length > 0) {
        e.preventDefault()
        const ids = s.selectedClipIds
        const label = ids.length > 1 ? `클립 ${ids.length}개 삭제` : '클립 삭제'
        s.dispatch(label, (p) => ids.reduce((acc, id) => removeClip(acc, id), p))
        s.clearSelection()
      } else if (e.key === 'Escape' && s.selectedClipIds.length > 0) {
        s.clearSelection()
      } else if ((e.code === 'KeyS' || e.code === 'KeyC') && !mod && s.selectedClipId) {
        const id = s.selectedClipId
        s.dispatch('클립 분할', (p) => splitClip(p, id, s.playhead, genId('clip')))
      } else if (e.code === 'KeyM' && !mod && s.selectedClipId) {
        const id = s.selectedClipId
        s.dispatch('컷 병합', (p) => mergeClip(p, id))
      } else if (mod && e.code === 'KeyC' && s.selectedClipId) {
        const found = findClip(s.project, s.selectedClipId)
        if (found) clipboard = found.clip
      } else if (mod && e.code === 'KeyV' && clipboard) {
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

  // 슬라이더/버튼/셀렉트 조작 후 포커스가 남아 단축키를 막지 않도록 자동으로 포커스 해제.
  // (글자 입력 필드는 제외 — 타이핑 중 포커스를 뺏으면 안 됨)
  useEffect(() => {
    const release = (): void => {
      const a = document.activeElement
      if (a && a !== document.body && !isTextEntry(a) && a instanceof HTMLElement) a.blur()
    }
    const onPointerUp = (): void => {
      // 셀렉트는 값 선택이 끝난 뒤 해제되도록 다음 틱에 처리
      setTimeout(release, 0)
    }
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('change', onPointerUp, true)
    return () => {
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('change', onPointerUp, true)
    }
  }, [])

  useEffect(() => {
    if (window.editor.isE2E || import.meta.env.DEV) installTestHooks()
  }, [])

  // 전환 효과음(phase-9) 번들 프리로드 — 실패해도 앱 동작에 영향 없음
  useEffect(() => {
    void playback.preloadSfx().catch(() => {})
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
    <div className="app" style={{ '--top-h': `${topH}px` } as React.CSSProperties}>
      <div className="main-row">
        <MediaBin />
        <Preview />
        <RightPanel />
      </div>
      <TransportBar />
      <div
        className="timeline-resizer"
        title="드래그해서 타임라인 높이 조절"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
      />
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
