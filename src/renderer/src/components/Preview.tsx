/**
 * 프리뷰 캔버스 (0.3.3 → 1.3 WebGL 컴포지터) + 텍스트 드래그 배치 (3.1.4)
 */
import { useEffect, useRef } from 'react'
import { useEditor } from '@renderer/state/store'
import { playback } from '@renderer/engine/playback'
import { findClip, updateClip } from '@renderer/state/commands'
import type { Project } from '@shared/model/types'

export function Preview(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const project = useEditor((s) => s.project)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const { width, height } = project.settings

  useEffect(() => {
    if (canvasRef.current) playback.attachCanvas(canvasRef.current, width, height)
  }, [width, height])

  // 편집 조작 후 정지 화면 갱신
  useEffect(() => {
    playback.refresh()
  }, [project])

  // 텍스트/비주얼 클립 드래그로 위치 조절
  const dragState = useRef<{ clipId: string; startX: number; startY: number; baseX: number; baseY: number; snapshot: Project } | null>(null)

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!selectedClipId) return
    const found = findClip(project, selectedClipId)
    if (!found || (found.clip.kind !== 'text' && found.clip.kind !== 'video' && found.clip.kind !== 'image')) return
    const t = found.clip.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 }
    dragState.current = {
      clipId: selectedClipId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: t.x,
      baseY: t.y,
      snapshot: project
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const cssToPx = (canvas: HTMLCanvasElement): number => width / canvas.getBoundingClientRect().width

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = dragState.current
    if (!d) return
    const k = cssToPx(e.currentTarget)
    const nx = d.baseX + (e.clientX - d.startX) * k
    const ny = d.baseY + (e.clientY - d.startY) * k
    // 드래그 중엔 히스토리 없이 미리보기
    useEditor.setState((s) => ({
      project: updateClip(s.project, d.clipId, {
        transform: { ...(findClip(s.project, d.clipId)?.clip.transform ?? { scale: 1, rotation: 0, x: 0, y: 0 }), x: nx, y: ny }
      })
    }))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = dragState.current
    if (!d) return
    dragState.current = null
    const k = cssToPx(e.currentTarget)
    const nx = d.baseX + (e.clientX - d.startX) * k
    const ny = d.baseY + (e.clientY - d.startY) * k
    if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < 2) return
    // 스냅샷으로 되돌린 뒤 단일 커맨드로 확정 (undo 1회에 대응)
    useEditor.setState({ project: d.snapshot })
    useEditor.getState().dispatch('클립 위치 이동', (p) => {
      const cur = findClip(p, d.clipId)?.clip.transform ?? { scale: 1, rotation: 0, x: 0, y: 0 }
      return updateClip(p, d.clipId, { transform: { ...cur, x: nx, y: ny } })
    })
  }

  return (
    <div className="preview-wrap">
      <canvas
        ref={canvasRef}
        className="preview-canvas"
        data-testid="preview-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </div>
  )
}
