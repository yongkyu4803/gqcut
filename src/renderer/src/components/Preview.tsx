/**
 * 프리뷰 캔버스 (0.3.3 → 1.3 WebGL 컴포지터) + 텍스트 드래그 배치 (3.1.4)
 * + 드래그 정렬 가이드(중앙/세이프라인/다른 클립 위치 자석 스냅) — DOM 오버레이, 컴포지터/내보내기엔 관여하지 않음
 */
import { useEffect, useRef, useState } from 'react'
import { useEditor } from '@renderer/state/store'
import { playback } from '@renderer/engine/playback'
import { findClip, updateClip } from '@renderer/state/commands'
import { computeGuideCandidates, snap1D, toCandidates } from '@renderer/engine/guides'
import { rasterizeText } from '@renderer/engine/textRaster'
import type { Project } from '@shared/model/types'

const SNAP_PX = 8 // CSS px 기준 스냅 임계값 (Timeline.tsx 의 SNAP_PX 와 동일한 감각)

interface DragState {
  clipId: string
  startX: number
  startY: number
  baseX: number
  baseY: number
  snapshot: Project
  candidates: { x: number[]; y: number[]; edgeY: number[] }
  /** 상하 안전선(edgeY) 스냅 시 중심좌표(transform.y)에서 뺄 보정량 — 텍스트 블록 높이의 절반, 텍스트가 아니면 0 */
  edgeOffset: number
}

export function Preview(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
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
  const dragState = useRef<DragState | null>(null)
  // 드래그 중 스냅된 축의 가이드선 좌표(캔버스 px, 중앙 기준) — 스냅 안 된 축은 null
  const [guide, setGuide] = useState<{ x: number | null; y: number | null }>({ x: null, y: null })

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!selectedClipId) return
    const found = findClip(project, selectedClipId)
    if (!found || (found.clip.kind !== 'text' && found.clip.kind !== 'video' && found.clip.kind !== 'image')) return
    const t = found.clip.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 }
    const playhead = useEditor.getState().playhead
    // 텍스트 블록 높이의 절반만큼 안전선을 "아래쪽 끝" 기준으로 보정 — 1줄/2줄 자막 모두 같은 위치에 스냅되도록
    const edgeOffset = found.clip.kind === 'text' && found.clip.text ? (rasterizeText(found.clip.text).height * t.scale) / 2 : 0
    dragState.current = {
      clipId: selectedClipId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: t.x,
      baseY: t.y,
      snapshot: project,
      candidates: computeGuideCandidates(project, playhead, height, selectedClipId),
      edgeOffset
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const cssToPx = (canvas: HTMLCanvasElement): number => width / canvas.getBoundingClientRect().width

  /** 드래그 델타에 스냅을 적용한 최종 좌표 + 적중한 가이드 후보(있으면, 표시용 좌표) */
  const resolveDrag = (
    d: DragState,
    e: React.PointerEvent<HTMLCanvasElement>
  ): { nx: number; ny: number; snapX: number | null; snapY: number | null } => {
    const k = cssToPx(e.currentTarget)
    const threshold = SNAP_PX * k
    const yCandidates = [...toCandidates(d.candidates.y), ...d.candidates.edgeY.map((lineY) => ({ target: lineY - d.edgeOffset, display: lineY }))]
    const sx = snap1D(d.baseX + (e.clientX - d.startX) * k, toCandidates(d.candidates.x), threshold)
    const sy = snap1D(d.baseY + (e.clientY - d.startY) * k, yCandidates, threshold)
    return { nx: sx.value, ny: sy.value, snapX: sx.display, snapY: sy.display }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = dragState.current
    if (!d) return
    const { nx, ny, snapX, snapY } = resolveDrag(d, e)
    setGuide({ x: snapX, y: snapY })
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
    setGuide({ x: null, y: null })
    const { nx, ny } = resolveDrag(d, e)
    if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < 2) return
    // 스냅샷으로 되돌린 뒤 단일 커맨드로 확정 (undo 1회에 대응)
    useEditor.setState({ project: d.snapshot })
    useEditor.getState().dispatch('클립 위치 이동', (p) => {
      const cur = findClip(p, d.clipId)?.clip.transform ?? { scale: 1, rotation: 0, x: 0, y: 0 }
      return updateClip(p, d.clipId, { transform: { ...cur, x: nx, y: ny } })
    })
  }

  // 가이드선 오버레이 좌표 (preview-wrap 기준 CSS px) — 스냅 중일 때만 계산
  const guideLine: { v?: React.CSSProperties; h?: React.CSSProperties } = {}
  if ((guide.x !== null || guide.y !== null) && canvasRef.current && wrapRef.current) {
    const c = canvasRef.current.getBoundingClientRect()
    const w = wrapRef.current.getBoundingClientRect()
    const left = c.left - w.left
    const top = c.top - w.top
    const k = width / c.width
    if (guide.x !== null) guideLine.v = { left: left + c.width / 2 + guide.x / k, top, height: c.height }
    if (guide.y !== null) guideLine.h = { top: top + c.height / 2 + guide.y / k, left, width: c.width }
  }

  return (
    <div className="preview-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="preview-canvas"
        data-testid="preview-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      {guideLine.v && <div className="preview-guide-line preview-guide-line--v" style={guideLine.v} />}
      {guideLine.h && <div className="preview-guide-line preview-guide-line--h" style={guideLine.h} />}
    </div>
  )
}
