/**
 * 타임라인 UI (1.2) — 눈금/줌, 클립 드래그·트림·분할·스냅, 멀티트랙, 플레이헤드 스크럽.
 * 오디오 클립은 파형(2.1.2) 렌더.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Clip, Track } from '@shared/model/types'
import { createTrack } from '@shared/model/factory'
import { useEditor } from '@renderer/state/store'
import { addTrack, moveClip, moveClipToNewTrack, moveClipToTrack, reorderTrack, projectDuration, removeTrack, trackAcceptsClip, trimClip, updateTrack } from '@renderer/state/commands'
import { playback } from '@renderer/engine/playback'
import { computePeaks } from '@renderer/engine/audioEngine'
import { formatTimecode } from '@shared/time'

const TRACK_H: Record<Track['kind'], number> = { video: 56, audio: 44, text: 36 }
const HEADER_W = 120
const SNAP_PX = 8

type DragMode = 'move' | 'trim-start' | 'trim-end'
interface DragState {
  mode: DragMode
  clipId: string
  clipKind: Clip['kind']
  trackId: string
  startClientX: number
  origStart: number
  origEnd: number
  /** 드래그 미리보기 값 (초) */
  preview: { start: number; end: number }
  /** 세로 드래그 대상 트랙 (move 모드, 같은 종류만) */
  hoverTrackId: string | null
  /** 빈 공간(트랙 추가 영역)으로 드롭 중 — 새 트랙을 만들어 이동 */
  newTrackDrop: boolean
}

export function Timeline(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const pxPerSec = useEditor((s) => s.pxPerSec)
  const playhead = useEditor((s) => s.playhead)
  const selectedClipIds = useEditor((s) => s.selectedClipIds)
  const dispatch = useEditor((s) => s.dispatch)
  const select = useEditor((s) => s.select)
  const toggleSelect = useEditor((s) => s.toggleSelect)
  const selectRangeTo = useEditor((s) => s.selectRangeTo)
  const clearSelection = useEditor((s) => s.clearSelection)
  const setZoom = useEditor((s) => s.setZoom)
  const silencePreview = useEditor((s) => s.silencePreview)
  const toggleSilenceCandidate = useEditor((s) => s.toggleSilenceCandidate)

  const [drag, setDrag] = useState<DragState | null>(null)
  // 트랙(타임라인) 순서 드래그 — 노션 블록처럼 그립을 잡고 위치 이동. dropIndex 는 삽입 지점(0..length).
  const [trackDrag, setTrackDrag] = useState<{ trackId: string; dropIndex: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 무수식 클릭으로 이미 다중선택된 클립을 눌렀을 때: 드래그 없이 pointerup 되면 단일 선택으로 축소
  const pendingCollapse = useRef<string | null>(null)

  const duration = Math.max(projectDuration(project), 10)
  const contentW = duration * pxPerSec + 400

  /** 첫 클립이 타임라인에 올라오는 순간 자동 줌아웃 — 눈금이 분 단위가 되도록 전체 길이를 한 화면에 맞춘다 */
  const clipCount = useMemo(() => project.tracks.reduce((n, t) => n + t.clips.length, 0), [project])
  const prevClipCount = useRef(0)
  useEffect(() => {
    if (prevClipCount.current === 0 && clipCount > 0) {
      const el = scrollRef.current
      const visibleW = (el?.clientWidth ?? 800) - HEADER_W
      const fitPxPerSec = visibleW / Math.max(projectDuration(project), 1)
      setZoom(fitPxPerSec)
    }
    prevClipCount.current = clipCount
  }, [clipCount, project, setZoom])

  /** 스냅 후보: 플레이헤드 + 모든 클립 경계 (1.2.5) */
  const snapPoints = useMemo(() => {
    const pts = [0, playhead]
    for (const t of project.tracks) for (const c of t.clips) pts.push(c.timelineStart, c.timelineEnd)
    return pts
  }, [project, playhead])

  const snap = (t: number, excludeClip?: string): number => {
    const threshold = SNAP_PX / pxPerSec
    let best = t
    let bestDist = threshold
    const exclude = excludeClip ? new Set([excludeClip]) : null
    for (const track of project.tracks) {
      for (const c of track.clips) {
        if (exclude?.has(c.id)) continue
        for (const p of [c.timelineStart, c.timelineEnd]) {
          const dist = Math.abs(p - t)
          if (dist < bestDist) {
            best = p
            bestDist = dist
          }
        }
      }
    }
    for (const p of [0, playhead]) {
      const dist = Math.abs(p - t)
      if (dist < bestDist) {
        best = p
        bestDist = dist
      }
    }
    void snapPoints
    return best
  }

  const clientXToTime = (clientX: number): number => {
    const el = scrollRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left - HEADER_W + el.scrollLeft) / pxPerSec)
  }

  // ── 클립 드래그/트림 ────────────────────────────────────
  const beginDrag = (e: React.PointerEvent, mode: DragMode, track: Track, clip: Clip): void => {
    e.stopPropagation()
    pendingCollapse.current = null
    // 이동 클릭에 수식키가 있으면 선택 제스처로만 처리하고 드래그는 시작하지 않는다
    if (mode === 'move' && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      if (e.shiftKey) selectRangeTo(clip.id)
      else toggleSelect(clip.id)
      return
    }
    const sel = useEditor.getState().selectedClipIds
    if (sel.length > 1 && sel.includes(clip.id)) {
      // 다중 선택 유지 — 실제 드래그가 없으면 pointerup 에서 단일로 축소
      pendingCollapse.current = clip.id
    } else {
      select(clip.id)
    }
    setDrag({
      mode,
      clipId: clip.id,
      clipKind: clip.kind,
      trackId: track.id,
      startClientX: e.clientX,
      origStart: clip.timelineStart,
      origEnd: clip.timelineEnd,
      preview: { start: clip.timelineStart, end: clip.timelineEnd },
      hoverTrackId: null,
      newTrackDrop: false
    })
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }

  const onDragMove = (e: React.PointerEvent): void => {
    if (!drag) return
    const dt = (e.clientX - drag.startClientX) / pxPerSec
    const len = drag.origEnd - drag.origStart
    if (drag.mode === 'move') {
      const start = Math.max(0, snap(drag.origStart + dt, drag.clipId))
      // 세로 드래그: 포인터 아래 요소를 확인 — 다른 트랙이면 이동, 빈 공간(트랙 추가 영역)이면 새 트랙 생성
      const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      const el = under?.closest('[data-track-id]') as HTMLElement | null
      const hoverId = el?.dataset.trackId ?? null
      const hoverTrack = hoverId ? project.tracks.find((t) => t.id === hoverId) : null
      const valid = hoverTrack && hoverTrack.id !== drag.trackId && trackAcceptsClip(hoverTrack, drag.clipKind)
      // 트랙 위가 아니고 새-트랙 드롭 영역이면 새 트랙으로 내리기
      const newTrackDrop = !valid && Boolean(under?.closest('[data-newtrack-drop]'))
      setDrag({ ...drag, preview: { start, end: start + len }, hoverTrackId: valid ? hoverTrack.id : null, newTrackDrop })
    } else if (drag.mode === 'trim-start') {
      const start = Math.min(snap(drag.origStart + dt, drag.clipId), drag.origEnd - 0.05)
      setDrag({ ...drag, preview: { start, end: drag.origEnd } })
    } else {
      const end = Math.max(snap(drag.origEnd + dt, drag.clipId), drag.origStart + 0.05)
      setDrag({ ...drag, preview: { start: drag.origStart, end } })
    }
  }

  const onDragEnd = (): void => {
    if (!drag) return
    const d = drag
    setDrag(null)
    // 무수식 클릭(드래그 없음)으로 다중 선택 클립을 눌렀던 경우 → 단일 선택으로 축소
    const collapseId = pendingCollapse.current
    pendingCollapse.current = null
    if (collapseId && d.mode === 'move' && !d.hoverTrackId && Math.abs(d.preview.start - d.origStart) <= 1e-6) {
      select(collapseId)
      return
    }
    if (d.mode === 'move' && d.newTrackDrop) {
      const kind: Track['kind'] = d.clipKind === 'audio' ? 'audio' : d.clipKind === 'text' ? 'text' : 'video'
      dispatch('새 트랙으로 이동', (p) => moveClipToNewTrack(p, d.clipId, createTrack(kind), d.preview.start))
    } else if (d.mode === 'move' && d.hoverTrackId) {
      dispatch('클립 트랙 이동', (p) => moveClipToTrack(p, d.clipId, d.hoverTrackId!, d.preview.start))
    } else if (d.mode === 'move' && Math.abs(d.preview.start - d.origStart) > 1e-6) {
      dispatch('클립 이동', (p) => moveClip(p, d.clipId, d.preview.start))
    } else if (d.mode === 'trim-start' && Math.abs(d.preview.start - d.origStart) > 1e-6) {
      dispatch('클립 트림(시작)', (p) => trimClip(p, d.clipId, 'start', d.preview.start))
    } else if (d.mode === 'trim-end' && Math.abs(d.preview.end - d.origEnd) > 1e-6) {
      dispatch('클립 트림(끝)', (p) => trimClip(p, d.clipId, 'end', d.preview.end))
    }
  }

  // ── 트랙 순서 드래그 (그립) ─────────────────────────────
  /** 포인터 Y 로 삽입 지점(0..length) 계산 — 각 트랙 세로 중앙 기준 */
  const computeDropIndex = (clientY: number): number => {
    const els = Array.from(scrollRef.current?.querySelectorAll('[data-track-id]') ?? []) as HTMLElement[]
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect()
      if (clientY < r.top + r.height / 2) return i
    }
    return els.length
  }
  const beginTrackDrag = (e: React.PointerEvent, trackId: string): void => {
    e.stopPropagation()
    e.preventDefault()
    setTrackDrag({ trackId, dropIndex: computeDropIndex(e.clientY) })
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }
  const onTrackDragMove = (e: React.PointerEvent): void => {
    if (!trackDrag) return
    const dropIndex = computeDropIndex(e.clientY)
    if (dropIndex !== trackDrag.dropIndex) setTrackDrag({ ...trackDrag, dropIndex })
  }
  const onTrackDragEnd = (): void => {
    if (!trackDrag) return
    const d = trackDrag
    setTrackDrag(null)
    dispatch('트랙 순서 변경', (p) => reorderTrack(p, d.trackId, d.dropIndex))
  }

  // ── 스크럽 (룰러/빈 영역) ───────────────────────────────
  const scrubbing = useRef(false)
  const onRulerDown = (e: React.PointerEvent): void => {
    scrubbing.current = true
    void playback.seek(clientXToTime(e.clientX))
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }
  const onRulerMove = (e: React.PointerEvent): void => {
    if (scrubbing.current) void playback.seek(clientXToTime(e.clientX))
  }
  const onRulerUp = (): void => {
    scrubbing.current = false
  }

  // ── 줌: ⌘/Ctrl + 휠 ────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      const s = useEditor.getState()
      s.setZoom(s.pxPerSec * (e.deltaY < 0 ? 1.15 : 1 / 1.15))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // 눈금 간격: 최소 80px 가 되는 "보기 좋은" 초 단위
  const tickSec = useMemo(() => {
    const nice = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]
    return nice.find((n) => n * pxPerSec >= 80) ?? 600
  }, [pxPerSec])
  const ticks = useMemo(() => {
    const out: number[] = []
    for (let t = 0; t <= duration + tickSec; t += tickSec) out.push(t)
    return out
  }, [duration, tickSec])

  const playheadX = HEADER_W + playhead * pxPerSec

  return (
    <div className="timeline" ref={scrollRef} data-testid="timeline">
      <div className="timeline-inner" style={{ width: contentW + HEADER_W }}>
        {/* 룰러 */}
        <div className="ruler" onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp}>
          <div className="ruler-header" style={{ width: HEADER_W }} />
          {ticks.map((t) => (
            <div key={t} className="tick" style={{ left: HEADER_W + t * pxPerSec }}>
              <span>{formatTimecode(t, project.settings.fps)}</span>
            </div>
          ))}
        </div>

        {/* 트랙들 */}
        {project.tracks.map((track, trackIdx) => (
          <div
            key={track.id}
            data-track-id={track.id}
            className={
              `track track-${track.kind}` +
              (drag?.hoverTrackId === track.id ? ' drop-target' : '') +
              (trackDrag?.trackId === track.id ? ' track-dragging' : '') +
              (trackDrag && trackDrag.dropIndex === trackIdx ? ' drop-before' : '') +
              (trackDrag && trackDrag.dropIndex === project.tracks.length && trackIdx === project.tracks.length - 1 ? ' drop-after' : '')
            }
            style={{ height: TRACK_H[track.kind] }}
          >
            <div className="track-header" style={{ width: HEADER_W }}>
              <div
                className="track-grip"
                title="드래그해서 트랙 순서 변경"
                onPointerDown={(e) => beginTrackDrag(e, track.id)}
                onPointerMove={onTrackDragMove}
                onPointerUp={onTrackDragEnd}
              >
                ⠿
              </div>
              <span className="track-kind">{track.kind === 'video' ? '비디오' : track.kind === 'audio' ? '오디오' : '텍스트'}</span>
              {track.kind !== 'text' && (
                <>
                  <button
                    className={`mini-btn ${track.muted ? 'active' : ''}`}
                    title="음소거"
                    onClick={() => dispatch('트랙 음소거', (p) => updateTrack(p, track.id, { muted: !track.muted }))}
                  >
                    M
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={track.volume ?? 1}
                    title="트랙 볼륨"
                    className="track-vol"
                    onChange={(e) => dispatch('트랙 볼륨', (p) => updateTrack(p, track.id, { volume: Number(e.target.value) }))}
                  />
                </>
              )}
              {track.clips.length === 0 && project.tracks.filter((t) => t.kind === track.kind).length > 1 && (
                <button className="mini-btn" title="빈 트랙 삭제" onClick={() => dispatch('트랙 삭제', (p) => removeTrack(p, track.id))}>
                  ×
                </button>
              )}
            </div>
            <div
              className="track-lane"
              onPointerDown={(e) => {
                if (e.target === e.currentTarget) {
                  clearSelection()
                  onRulerDown(e)
                }
              }}
              onPointerMove={onRulerMove}
              onPointerUp={onRulerUp}
            >
              {track.clips.map((clip) => {
                const isDragging = drag?.clipId === clip.id
                const start = isDragging ? drag.preview.start : clip.timelineStart
                const end = isDragging ? drag.preview.end : clip.timelineEnd
                return (
                  <ClipBlock
                    key={clip.id}
                    clip={clip}
                    track={track}
                    left={start * pxPerSec} // .track-lane 자체가 헤더(120px) 뒤에서 시작 — 추가 오프셋 없음
                    width={Math.max(2, (end - start) * pxPerSec)}
                    selected={selectedClipIds.includes(clip.id)}
                    onDown={(e, mode) => beginDrag(e, mode, track, clip)}
                    onMove={onDragMove}
                    onUp={onDragEnd}
                  />
                )
              })}
              {silencePreview?.trackId === track.id &&
                silencePreview.candidates.map((c) => (
                  <div
                    key={c.id}
                    className={`silence-marker ${c.selected ? '' : 'deselected'}`}
                    data-testid={`silence-marker-${c.id}`}
                    style={{ left: c.start * pxPerSec, width: Math.max(2, (c.end - c.start) * pxPerSec) }}
                    title="클릭해서 이 구간을 컷 대상에서 제외/포함"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => toggleSilenceCandidate(c.id)}
                  />
                ))}
            </div>
          </div>
        ))}

        {/* 트랙 추가 (멀티트랙): 비디오는 메인 위 오버레이로, 텍스트는 최상단, 오디오는 최하단.
            move 드래그 중에는 여기로 드롭하면 새 트랙을 만들어 클립을 내린다(data-newtrack-drop). */}
        <div
          className={`track-add-row ${drag?.mode === 'move' ? 'drop-newtrack' : ''} ${drag?.newTrackDrop ? 'drop-target' : ''}`}
          data-newtrack-drop
        >
          {drag?.mode === 'move' && <span className="newtrack-hint">여기로 놓으면 새 트랙 생성</span>}
          <button
            className="btn small"
            onClick={() =>
              dispatch('비디오 트랙 추가', (p) => {
                const mainIdx = p.tracks.map((t, i) => (t.kind === 'video' ? i : -1)).filter((i) => i >= 0).pop() ?? p.tracks.length
                return addTrack(p, createTrack('video'), mainIdx)
              })
            }
          >
            + 비디오
          </button>
          <button className="btn small" onClick={() => dispatch('텍스트 트랙 추가', (p) => addTrack(p, createTrack('text'), 0))}>
            + 텍스트
          </button>
          <button className="btn small" onClick={() => dispatch('오디오 트랙 추가', (p) => addTrack(p, createTrack('audio')))}>
            + 오디오
          </button>
        </div>

        {/* 플레이헤드 */}
        <div className="playhead" style={{ left: playheadX }} />
      </div>
      <div className="zoom-controls">
        <button onClick={() => setZoom(pxPerSec / 1.4)}>−</button>
        <button onClick={() => setZoom(pxPerSec * 1.4)}>+</button>
      </div>
    </div>
  )
}

function ClipBlock(props: {
  clip: Clip
  track: Track
  left: number
  width: number
  selected: boolean
  onDown: (e: React.PointerEvent, mode: DragMode) => void
  onMove: (e: React.PointerEvent) => void
  onUp: () => void
}): React.JSX.Element {
  const { clip, track, left, width, selected } = props
  const project = useEditor((s) => s.project)
  const asset = clip.assetId ? project.assets.find((a) => a.id === clip.assetId) : undefined
  const label = clip.kind === 'text' ? (clip.text?.value ?? '텍스트') : (asset?.path.split('/').pop() ?? clip.kind)

  return (
    <div
      className={`clip clip-${clip.kind} ${selected ? 'selected' : ''}`}
      data-testid={`clip-${clip.id}`}
      style={{ left, width }}
      onPointerDown={(e) => props.onDown(e, 'move')}
      onPointerMove={props.onMove}
      onPointerUp={props.onUp}
    >
      <div className="trim-handle left" onPointerDown={(e) => props.onDown(e, 'trim-start')} onPointerMove={props.onMove} onPointerUp={props.onUp} />
      <span className="clip-label">{label}</span>
      {(clip.kind === 'audio' || (clip.kind === 'video' && asset?.hasAudio)) && asset && (
        <Waveform assetId={asset.id} clip={clip} width={width} height={TRACK_H[track.kind] - 8} />
      )}
      <div className="trim-handle right" onPointerDown={(e) => props.onDown(e, 'trim-end')} onPointerMove={props.onMove} onPointerUp={props.onUp} />
    </div>
  )
}

/** 파형 렌더 (2.1.2) — 소스 구간 [sourceIn, sourceOut] 에 해당하는 피크만 그린다.
 *  클립(트랙) 높이를 꽉 채우고, 보이는 구간의 최댓값으로 정규화해 조용한 소리도 구분되게 한다. */
function Waveform({ assetId, clip, width, height }: { assetId: string; clip: Clip; width: number; height: number }): React.JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(0)

  useEffect(() => {
    // 오디오 버퍼가 늦게 로드될 수 있어 폴링
    const buffer = playback.audio?.getBuffer(assetId)
    if (buffer) return
    const t = setInterval(() => {
      if (playback.audio?.getBuffer(assetId)) {
        setReady((r) => r + 1)
        clearInterval(t)
      }
    }, 500)
    return () => clearInterval(t)
  }, [assetId])

  useEffect(() => {
    const canvas = canvasRef.current
    const buffer = playback.audio?.getBuffer(assetId)
    if (!canvas || !buffer) return
    const w = Math.max(4, Math.floor(width))
    const h = Math.max(8, Math.floor(height))
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(122, 226, 180, 0.9)'
    const totalBuckets = 2000
    const peaks = computePeaks(assetId, buffer, totalBuckets)
    const dur = buffer.duration
    const s0 = (clip.sourceIn ?? 0) / dur
    const s1 = (clip.sourceOut ?? dur) / dur
    const bucketAt = (x: number): number =>
      Math.min(totalBuckets - 1, Math.max(0, Math.floor((s0 + (s1 - s0) * (x / w)) * totalBuckets)))

    // 보이는 구간의 최댓값으로 정규화 — 게인은 과증폭(노이즈 플로어 폭발) 방지 위해 상한(12x)
    let localMax = 0
    for (let x = 0; x < w; x++) localMax = Math.max(localMax, peaks[bucketAt(x)] ?? 0)
    const gain = localMax > 1e-4 ? Math.min(12, 0.92 / localMax) : 1

    for (let x = 0; x < w; x++) {
      const peak = peaks[bucketAt(x)] ?? 0
      const bar = Math.max(1, Math.min(h, peak * gain * h))
      ctx.fillRect(x, (h - bar) / 2, 1, bar)
    }
  }, [assetId, clip.sourceIn, clip.sourceOut, width, height, ready])

  return <canvas ref={canvasRef} className="waveform" />
}
