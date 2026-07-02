/**
 * 인스펙터 — 선택 클립 속성 편집: 볼륨/페이드(2.2), 변형/불투명도, 텍스트 스타일·애니메이션(3.1),
 * 색보정 필터(4.1), 클립 간 전환(4.2)
 */
import type { Clip, Effect, TextAnimation, TextContent, Track, Transition } from '@shared/model/types'
import { FILTER_SPECS, TRANSITION_TYPES } from '@shared/effects-spec'
import { useEditor } from '@renderer/state/store'
import { findClip, updateClip, updateSettings } from '@renderer/state/commands'

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="insp-row">
      <span>{label}</span>
      {children}
    </label>
  )
}

export function Inspector(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const dispatch = useEditor((s) => s.dispatch)

  const found = selectedClipId ? findClip(project, selectedClipId) : null

  const set = (label: string, patch: Partial<Clip>): void => {
    if (!found) return
    dispatch(label, (p) => updateClip(p, found.clip.id, patch))
  }

  if (!found) {
    return (
      <div className="inspector">
        <h3>프로젝트</h3>
        <Row label="마스터 볼륨">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={project.settings.masterVolume}
            onChange={(e) => dispatch('마스터 볼륨', (p) => updateSettings(p, { masterVolume: Number(e.target.value) }))}
          />
        </Row>
        <p className="hint">클립을 선택하면 속성이 표시됩니다</p>
      </div>
    )
  }

  const clip = found.clip
  const t = clip.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 }

  return (
    <div className="inspector" data-testid="inspector">
      <h3>{clip.kind === 'text' ? '텍스트 클립' : clip.kind === 'audio' ? '오디오 클립' : '비디오 클립'}</h3>

      {clip.kind !== 'audio' && (
        <>
          <Row label="불투명도">
            <input type="range" min={0} max={1} step={0.01} value={clip.opacity ?? 1} onChange={(e) => set('불투명도', { opacity: Number(e.target.value) })} />
          </Row>
          <Row label="크기">
            <input type="range" min={0.1} max={4} step={0.01} value={t.scale} onChange={(e) => set('크기', { transform: { ...t, scale: Number(e.target.value) } })} />
          </Row>
          <Row label="회전°">
            <input type="number" value={Math.round(t.rotation)} onChange={(e) => set('회전', { transform: { ...t, rotation: Number(e.target.value) } })} />
          </Row>
          <Row label="위치 X">
            <input type="number" value={Math.round(t.x)} onChange={(e) => set('위치', { transform: { ...t, x: Number(e.target.value) } })} />
          </Row>
          <Row label="위치 Y">
            <input type="number" value={Math.round(t.y)} onChange={(e) => set('위치', { transform: { ...t, y: Number(e.target.value) } })} />
          </Row>
        </>
      )}

      {(clip.kind === 'video' || clip.kind === 'image') && <FilterPanel clip={clip} onSet={set} />}
      {clip.kind !== 'text' && clip.kind !== 'audio' && <TransitionPanel clip={clip} track={found.track} onSet={set} />}

      {(clip.kind === 'video' || clip.kind === 'audio') && (
        <>
          <h4>오디오</h4>
          <Row label="볼륨">
            <input type="range" min={0} max={1} step={0.01} value={clip.volume ?? 1} onChange={(e) => set('클립 볼륨', { volume: Number(e.target.value) })} />
          </Row>
        </>
      )}

      {clip.kind !== 'text' && (
        <>
          <h4>페이드 {clip.kind === 'audio' ? '(소리)' : clip.kind === 'image' ? '(화면)' : '(화면·소리)'}</h4>
          <Row label="페이드 인(초)">
            <input type="number" min={0} step={0.1} value={clip.fadeIn ?? 0} onChange={(e) => set('페이드 인', { fadeIn: Math.max(0, Number(e.target.value)) })} />
          </Row>
          <Row label="페이드 아웃(초)">
            <input type="number" min={0} step={0.1} value={clip.fadeOut ?? 0} onChange={(e) => set('페이드 아웃', { fadeOut: Math.max(0, Number(e.target.value)) })} />
          </Row>
        </>
      )}

      {clip.kind === 'text' && clip.text && <TextPanel clip={clip} text={clip.text} onSet={set} />}
    </div>
  )
}

/** 색보정 필터 (4.1.3) — effects-spec 규격 기반 슬라이더, 실시간 프리뷰 반영 */
function FilterPanel({ clip, onSet }: { clip: Clip; onSet: (label: string, patch: Partial<Clip>) => void }): React.JSX.Element {
  const effects = clip.effects ?? []
  const valueOf = (type: string, def: number): number => {
    const e = effects.find((x) => x.type === type)
    return e && e.enabled ? (e.params.value ?? def) : def
  }
  const setValue = (type: string, label: string, value: number): void => {
    const next: Effect[] = effects.some((e) => e.type === type)
      ? effects.map((e) => (e.type === type ? { ...e, enabled: true, params: { ...e.params, value } } : e))
      : [...effects, { type, params: { value }, enabled: true }]
    onSet(`필터: ${label}`, { effects: next })
  }
  const hasAny = effects.some((e) => e.enabled)
  return (
    <>
      <h4>
        필터{' '}
        {hasAny && (
          <button className="mini-btn" title="필터 초기화" onClick={() => onSet('필터 초기화', { effects: [] })}>
            ↺
          </button>
        )}
      </h4>
      {FILTER_SPECS.map((spec) => {
        const p = spec.params[0]
        return (
          <Row key={spec.type} label={spec.label}>
            <input
              type="range"
              min={p.min}
              max={p.max}
              step={p.step}
              value={valueOf(spec.type, p.default)}
              onChange={(e) => setValue(spec.type, spec.label, Number(e.target.value))}
            />
          </Row>
        )
      })}
    </>
  )
}

/** 클립 간 전환 (4.2.3) — 다음 클립과 맞닿아 있을 때만. duration 은 두 클립 길이로 클램프 (불변식 4/7) */
function TransitionPanel({ clip, track, onSet }: { clip: Clip; track: Track; onSet: (label: string, patch: Partial<Clip>) => void }): React.JSX.Element | null {
  const sorted = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart)
  const idx = sorted.findIndex((c) => c.id === clip.id)
  const next = idx >= 0 ? sorted[idx + 1] : undefined
  const adjacent = next && Math.abs(next.timelineStart - clip.timelineEnd) < 1e-3
  if (!adjacent) return null

  const maxDur = Math.min(clip.timelineEnd - clip.timelineStart, next.timelineEnd - next.timelineStart)
  const t = clip.transitionOut

  const setTransition = (patch: Partial<Transition> | null): void => {
    if (patch === null) {
      onSet('전환 제거', { transitionOut: undefined })
    } else {
      const merged: Transition = { type: t?.type ?? 'dissolve', duration: t?.duration ?? Math.min(1, maxDur), ...patch }
      merged.duration = Math.min(Math.max(0.1, merged.duration), maxDur)
      onSet('전환 설정', { transitionOut: merged })
    }
  }

  return (
    <>
      <h4>다음 클립으로 전환</h4>
      <Row label="유형">
        <select
          data-testid="transition-type"
          value={t?.type ?? 'none'}
          onChange={(e) => (e.target.value === 'none' ? setTransition(null) : setTransition({ type: e.target.value }))}
        >
          <option value="none">없음</option>
          {TRANSITION_TYPES.map((tt) => (
            <option key={tt.type} value={tt.type}>
              {tt.label}
            </option>
          ))}
        </select>
      </Row>
      {t && (
        <Row label="길이(초)">
          <input
            type="number"
            min={0.1}
            max={maxDur}
            step={0.1}
            value={t.duration}
            onChange={(e) => setTransition({ duration: Number(e.target.value) })}
          />
        </Row>
      )}
    </>
  )
}

function TextPanel({ clip, text, onSet }: { clip: Clip; text: TextContent; onSet: (label: string, patch: Partial<Clip>) => void }): React.JSX.Element {
  void clip
  const setText = (label: string, patch: Partial<TextContent>): void => onSet(label, { text: { ...text, ...patch } })

  const animRow = (which: 'animationIn' | 'animationOut', label: string): React.JSX.Element => {
    const anim = text[which]
    return (
      <Row label={label}>
        <select
          value={anim?.type ?? 'none'}
          onChange={(e) => {
            const type = e.target.value
            setText(label, { [which]: type === 'none' ? undefined : ({ type, duration: anim?.duration ?? 0.5 } as TextAnimation) })
          }}
        >
          <option value="none">없음</option>
          <option value="fade">페이드</option>
          <option value="slide">슬라이드</option>
          <option value="pop">팝</option>
        </select>
        {anim && (
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={anim.duration}
            style={{ width: 56 }}
            onChange={(e) => setText(label, { [which]: { ...anim, duration: Math.max(0.1, Number(e.target.value)) } })}
          />
        )}
      </Row>
    )
  }

  return (
    <>
      <h4>텍스트</h4>
      <textarea className="text-input" data-testid="text-value" value={text.value} rows={2} onChange={(e) => setText('텍스트 내용', { value: e.target.value })} />
      <Row label="크기(px)">
        <input type="number" min={8} value={text.fontSize} onChange={(e) => setText('폰트 크기', { fontSize: Math.max(8, Number(e.target.value)) })} />
      </Row>
      <Row label="색">
        <input type="color" value={text.color} onChange={(e) => setText('폰트 색', { color: e.target.value })} />
      </Row>
      <Row label="정렬">
        <select value={text.align} onChange={(e) => setText('정렬', { align: e.target.value as TextContent['align'] })}>
          <option value="left">왼쪽</option>
          <option value="center">가운데</option>
          <option value="right">오른쪽</option>
        </select>
      </Row>
      <Row label="스타일">
        <button className={`mini-btn ${text.bold ? 'active' : ''}`} onClick={() => setText('굵게', { bold: !text.bold })}>
          B
        </button>
        <button className={`mini-btn ${text.italic ? 'active' : ''}`} onClick={() => setText('기울임', { italic: !text.italic })}>
          I
        </button>
      </Row>
      <Row label="외곽선">
        <input
          type="number"
          min={0}
          value={text.stroke?.width ?? 0}
          style={{ width: 56 }}
          onChange={(e) => setText('외곽선', { stroke: { color: text.stroke?.color ?? '#000000', width: Math.max(0, Number(e.target.value)) } })}
        />
        <input type="color" value={text.stroke?.color ?? '#000000'} onChange={(e) => setText('외곽선 색', { stroke: { width: text.stroke?.width ?? 0, color: e.target.value } })} />
      </Row>
      <Row label="그림자">
        <input
          type="checkbox"
          checked={!!text.shadow}
          onChange={(e) => setText('그림자', { shadow: e.target.checked ? { color: 'rgba(0,0,0,0.7)', blur: 8, x: 2, y: 2 } : undefined })}
        />
      </Row>
      <Row label="배경 박스">
        <input
          type="checkbox"
          checked={!!text.background}
          onChange={(e) => setText('배경 박스', { background: e.target.checked ? { color: 'rgba(0,0,0,0.55)', padding: 16 } : undefined })}
        />
      </Row>
      <h4>애니메이션</h4>
      {animRow('animationIn', '등장')}
      {animRow('animationOut', '퇴장')}
    </>
  )
}
