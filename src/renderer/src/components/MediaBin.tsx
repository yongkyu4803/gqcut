/**
 * 미디어 빈 — 임포트(다이얼로그 + 드래그앤드롭 0.3.1), 자산 목록, 타임라인 배치, 프록시 진행률(0.4.3)
 */
import { useCallback, useEffect, useState } from 'react'
import type { MediaAsset } from '@shared/model/types'
import { createMediaClip, createTrack } from '@shared/model/factory'
import { useEditor } from '@renderer/state/store'
import { addClip, addClipOverlay } from '@renderer/state/commands'
import { importFile, importViaDialog, relinkAsset } from '@renderer/media/import'
import { makeThumbnail } from '@renderer/engine/thumbnail'

export function MediaBin(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const proxyJobs = useEditor((s) => s.proxyJobs)
  const dispatch = useEditor((s) => s.dispatch)

  /** 오버레이 배치 (이미지 기본 / 비디오 PIP): 플레이헤드 위치, 빈 오버레이 트랙 or 새 트랙 */
  const addAsOverlay = useCallback(
    (asset: MediaAsset): void => {
      const playhead = useEditor.getState().playhead
      const clip = createMediaClip(asset, playhead)
      const newTrack = createTrack('video')
      dispatch('오버레이로 추가', (p) => addClipOverlay(p, clip, newTrack))
      useEditor.getState().select(clip.id)
    },
    [dispatch]
  )

  /** 메인 트랙 끝에 이어붙이기 (비디오/오디오). 이미지는 오버레이가 기본. */
  const addToTimeline = useCallback(
    (asset: MediaAsset): void => {
      if (asset.kind === 'image') {
        addAsOverlay(asset)
        return
      }
      const targetKind = asset.kind === 'audio' ? 'audio' : 'video'
      // 메인 = 해당 종류의 최하단 트랙
      const track = [...project.tracks].reverse().find((t) => t.kind === targetKind)
      if (!track) return
      const end = Math.max(0, ...track.clips.map((c) => c.timelineEnd))
      dispatch('타임라인에 추가', (p) => addClip(p, track.id, createMediaClip(asset, end)))
    },
    [project, dispatch, addAsOverlay]
  )

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    for (const f of Array.from(e.dataTransfer.files)) {
      const path = window.electronFilePath?.(f) ?? (f as unknown as { path?: string }).path
      if (path) {
        try {
          await importFile(path)
        } catch (err) {
          alert(`임포트 실패: ${err instanceof Error ? err.message : err}`)
        }
      }
    }
  }

  return (
    <div className="media-bin" onDrop={onDrop} onDragOver={(e) => e.preventDefault()} data-testid="media-bin">
      <button className="btn primary" onClick={() => void importViaDialog()} data-testid="import-btn">
        + 미디어 임포트
      </button>
      <div className="asset-list">
        {project.assets.map((asset) => (
          <div key={asset.id} className="asset-card" data-testid={`asset-${asset.id}`}>
            {(asset.kind === 'video' || asset.kind === 'image') && <Thumb asset={asset} />}
            <div className="asset-name" title={asset.path}>
              {asset.path.split('/').pop()}
            </div>
            <div className="asset-meta">
              {asset.kind} · {asset.duration.toFixed(1)}s
              {asset.width ? ` · ${asset.width}×${asset.height}` : ''}
              {asset.vfr ? ' · VFR' : ''}
              {asset.proxyPath ? ' · 프록시' : ''}
            </div>
            {asset.status === 'missing' ? (
              <button className="btn small missing" onClick={() => void relinkAsset(asset.id)}>
                ⚠ 파일 누락 — 재연결
              </button>
            ) : proxyJobs[asset.id] !== undefined ? (
              <div className="proxy-progress">
                <div className="bar" style={{ width: `${proxyJobs[asset.id]}%` }} />
                <span>프록시 생성 중 {Math.round(proxyJobs[asset.id])}%</span>
              </div>
            ) : (
              <div className="asset-actions">
                <button className="btn small" onClick={() => addToTimeline(asset)} data-testid={`add-asset-${asset.id}`}>
                  {asset.kind === 'image' ? '오버레이로 추가' : '타임라인에 추가'}
                </button>
                {asset.kind === 'video' && (
                  <button className="btn small" title="플레이헤드 위치에 오버레이(PIP) 트랙으로" onClick={() => addAsOverlay(asset)}>
                    PIP
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {project.assets.length === 0 && <p className="hint">파일을 드래그하거나 임포트 버튼을 누르세요</p>}
      </div>
    </div>
  )
}

/** 자산 썸네일 (0.3.4) — 프록시 생성 완료 후 디코딩 가능해지면 자동 갱신 */
function Thumb({ asset }: { asset: MediaAsset }): React.JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null)
  const decodable = asset.proxyPath ?? asset.path
  useEffect(() => {
    let alive = true
    void makeThumbnail(decodable, asset.kind === 'image' ? 'image' : 'video', 0).then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [decodable, asset.kind])
  return url ? <img className="asset-thumb" src={url} alt="" /> : null
}
