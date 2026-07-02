/**
 * 내보내기 설정 다이얼로그 (5.2.4) — 해상도/품질 프리셋. 초기 포맷은 H.264+AAC(MP4) 한정.
 */
import { useState } from 'react'
import type { ExportSettings } from '@renderer/engine/exporter'
import { DEFAULT_EXPORT_SETTINGS } from '@renderer/engine/exporter'
import { useEditor } from '@renderer/state/store'

export function ExportDialog({ onConfirm, onClose }: { onConfirm: (s: ExportSettings) => void; onClose: () => void }): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const [settings, setSettings] = useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS)
  const { width, height } = project.settings

  return (
    <div className="export-overlay">
      <div className="export-dialog" data-testid="export-dialog">
        <h3>내보내기 설정</h3>
        <label className="insp-row" style={{ width: '100%' }}>
          <span>해상도</span>
          <select value={settings.resolution} onChange={(e) => setSettings({ ...settings, resolution: e.target.value as ExportSettings['resolution'] })}>
            <option value="source">
              프로젝트 ({width}×{height})
            </option>
            {height > 1080 && <option value="1080p">1080p</option>}
            {height > 720 && <option value="720p">720p</option>}
          </select>
        </label>
        <label className="insp-row" style={{ width: '100%' }}>
          <span>품질</span>
          <select value={settings.quality} onChange={(e) => setSettings({ ...settings, quality: e.target.value as ExportSettings['quality'] })}>
            <option value="high">고품질 (CRF 18)</option>
            <option value="standard">표준 (CRF 21)</option>
            <option value="compact">고압축 (CRF 25)</option>
          </select>
        </label>
        <p className="hint">포맷: MP4 (H.264 + AAC) · {project.settings.fps}fps</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button className="btn export" data-testid="export-confirm" onClick={() => onConfirm(settings)}>
            내보내기
          </button>
        </div>
      </div>
    </div>
  )
}
