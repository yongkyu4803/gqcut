/**
 * 타임라인 UI (1.2) — 눈금/줌, 클립 드래그·트림·분할·스냅, 멀티트랙, 플레이헤드 스크럽.
 * 오디오 클립은 파형(2.1.2) 렌더.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Clip, Track } from '@shared/model/types'
import { useEditor } from '@renderer/state/store'
import { moveClip, projectDuration, trimClip, updateTrack } from '@renderer/state/commands'
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
  trackId: string
  startClientX: number
  origStart: number
  origEnd: number
  /** 드래그 미리보기 값 (초) */
  preview: { start: number; end: number }
}

export function Timeline(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const pxPerSec = useEditor((s) => s.pxPerSec)
  const playhead = useEditor((s) => s.playhead)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const dispatch = useEditor((s) => s.dispatch)
  const select = useEditor((s) => s.select)
  const setZoom = useEditor((s) => s.setZoom)

  const [drag, setDrag] = useState<DragState | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const duration = Math.max(projectDuration(project), 10)
  const contentW = duration * pxPerSec + 400

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
    select(clip.id)
    setDrag({
      mode,
      clipId: clip.id,
      trackId: track.id,
      startClientX: e.clientX,
      origStart: clip.timelineStart,
      origEnd: clip.timelineEnd,
      preview: { start: clip.timelineStart, end: clip.timelineEnd }
    })
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }

  const onDragMove = (e: React.PointerEvent): void => {
    if (!drag) return
    const dt = (e.clientX - drag.startClientX) / pxPerSec
    const len = drag.origEnd - drag.origStart
    if (drag.mode === 'move') {
      const start = Math.max(0, snap(drag.origStart + dt, drag.clipId))
      setDrag({ ...drag, preview: { start, end: start + len } })
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
    if (d.mode === 'move' && Math.abs(d.preview.start - d.origStart) > 1e-6) {
      dispatch('클립 이동', (p) => moveClip(p, d.clipId, d.preview.start))
    } else if (d.mode === 'trim-start' && Math.abs(d.preview.start - d.origStart) > 1e-6) {
      dispatch('클립 트림(시작)', (p) => trimClip(p, d.clipId, 'start', d.preview.start))
    } else if (d.mode === 'trim-end' && Math.abs(d.preview.end - d.origEnd) > 1e-6) {
      dispatch('클립 트림(끝)', (p) => trimClip(p, d.clipId, 'end', d.preview.end))
    }
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
        {project.tracks.map((track) => (
          <div key={track.id} className={`track track-${track.kind}`} style={{ height: TRACK_H[track.kind] }}>
            <div className="track-header" style={{ width: HEADER_W }}>
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
            </div>
            <div
              className="track-lane"
              onPointerDown={(e) => {
                if (e.target === e.currentTarget) {
                  select(null)
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
                    left={HEADER_W + start * pxPerSec}
                    width={Math.max(2, (end - start) * pxPerSec)}
                    selected={clip.id === selectedClipId}
                    onDown={(e, mode) => beginDrag(e, mode, track, clip)}
                    onMove={onDragMove}
                    onUp={onDragEnd}
                  />
                )
              })}
            </div>
          </div>
        ))}

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
  const { clip, left, width, selected } = props
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
        <Waveform assetId={asset.id} clip={clip} width={width} />
      )}
      <div className="trim-handle right" onPointerDown={(e) => props.onDown(e, 'trim-end')} onPointerMove={props.onMove} onPointerUp={props.onUp} />
    </div>
  )
}

/** 파형 렌더 (2.1.2) — 소스 구간 [sourceIn, sourceOut] 에 해당하는 피크만 그린다 */
function Waveform({ assetId, clip, width }: { assetId: string; clip: Clip; width: number }): React.JSX.Element | null {
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
    const h = canvas.height
    canvas.width = w
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(122, 226, 180, 0.85)'
    const totalBuckets = 2000
    const peaks = computePeaks(assetId, buffer, totalBuckets)
    const dur = buffer.duration
    const s0 = (clip.sourceIn ?? 0) / dur
    const s1 = (clip.sourceOut ?? dur) / dur
    for (let x = 0; x < w; x++) {
      const frac = s0 + (s1 - s0) * (x / w)
      const peak = peaks[Math.min(totalBuckets - 1, Math.floor(frac * totalBuckets))] ?? 0
      const bar = Math.max(1, peak * h)
      ctx.fillRect(x, (h - bar) / 2, 1, bar)
    }
  }, [assetId, clip.sourceIn, clip.sourceOut, width, ready])

  return <canvas ref={canvasRef} className="waveform" height={28} />
}
