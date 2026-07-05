/**
 * 인스펙터 — 선택 클립 속성 편집: 볼륨/페이드(2.2), 변형/불투명도, 텍스트 스타일·애니메이션(3.1),
 * 색보정 필터(4.1), 클립 간 전환(4.2)
 */
import { useEffect, useState } from 'react'
import type { Clip, Effect, TextAnimation, TextContent, Track, Transition } from '@shared/model/types'
import { FILTER_SPECS, TRANSITION_TYPES } from '@shared/effects-spec'
import { DEFAULT_STT_LANGUAGE, STT_LANGUAGES, STT_MODEL_INFO, type SttModel } from '@shared/subtitles'
import { formatTimecode } from '@shared/time'
import { useEditor } from '@renderer/state/store'
import { findClip, updateClip, updateSettings } from '@renderer/state/commands'
import { displayFontName, GENERIC_FONT_FALLBACK, listSystemFonts } from '@renderer/engine/fonts'
import { exportSubtitlesSrt, generateCaptions } from '@renderer/stt/autoCaption'
import { applySilenceCut, cancelSilencePreview, detectSilence } from '@renderer/silence/autoCut'

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

      {clip.kind === 'video' && <CaptionPanel clip={clip} />}

      {clip.kind === 'video' && <SilenceCutPanel clip={clip} />}

      {clip.kind === 'text' && clip.text && <TextPanel clip={clip} text={clip.text} onSet={set} />}
    </div>
  )
}

/** 자동 자막 (3.2) — 선택 비디오 클립의 음성을 Whisper 로 전사해 자막 트랙에 배치 */
function CaptionPanel({ clip }: { clip: Clip }): React.JSX.Element | null {
  const project = useEditor((s) => s.project)
  const sttActive = useEditor((s) => !!s.sttProgress?.active)
  const asset = clip.assetId ? project.assets.find((a) => a.id === clip.assetId) : undefined
  const [model, setModel] = useState<SttModel>('whisper-base')
  const [language, setLanguage] = useState(DEFAULT_STT_LANGUAGE)
  if (!asset?.hasAudio) return null

  const run = async (): Promise<void> => {
    try {
      const n = await generateCaptions(clip.id, { model, language })
      if (n === 0) alert('인식된 음성이 없습니다')
    } catch (e) {
      alert(`자막 생성 실패: ${e instanceof Error ? e.message : e}`)
    }
  }

  return (
    <>
      <h4>자동 자막</h4>
      <Row label="모델">
        <select value={model} onChange={(e) => setModel(e.target.value as SttModel)}>
          {(Object.keys(STT_MODEL_INFO) as SttModel[]).map((m) => (
            <option key={m} value={m}>
              {STT_MODEL_INFO[m].label} · {STT_MODEL_INFO[m].approxMB}MB
            </option>
          ))}
        </select>
      </Row>
      <Row label="언어">
        <select value={language} onChange={(e) => setLanguage(e.target.value)}>
          {STT_LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </Row>
      <button className="btn small" data-testid="gen-captions-btn" disabled={sttActive} onClick={() => void run()} style={{ width: '100%', marginTop: 4 }}>
        ✦ 자막 생성
      </button>
      <button className="btn small" onClick={() => void exportSubtitlesSrt()} style={{ width: '100%', marginTop: 4 }}>
        SRT 내보내기
      </button>
      <p className="hint" style={{ fontSize: 10, textAlign: 'left' }}>
        첫 실행 시 모델({STT_MODEL_INFO[model].approxMB}MB)을 한 번 내려받습니다. 오프라인 처리.
      </p>
    </>
  )
}

/** 무음 자동 컷 — 선택 비디오 클립의 무음 구간을 감지해 미리보기 후 적용(사용자 확인 필요) */
function SilenceCutPanel({ clip }: { clip: Clip }): React.JSX.Element | null {
  const project = useEditor((s) => s.project)
  const silenceActive = useEditor((s) => !!s.silenceProgress?.active)
  const preview = useEditor((s) => s.silencePreview)
  const toggleCandidate = useEditor((s) => s.toggleSilenceCandidate)
  const asset = clip.assetId ? project.assets.find((a) => a.id === clip.assetId) : undefined
  const [noiseDb, setNoiseDb] = useState(-35)
  const [minDurationSec, setMinDurationSec] = useState(0.5)
  if (!asset?.hasAudio) return null

  const run = async (): Promise<void> => {
    try {
      const n = await detectSilence(clip.id, { noiseDb, minDurationSec })
      if (n === 0) alert('무음 구간을 찾지 못했습니다')
    } catch (e) {
      alert(`무음 감지 실패: ${e instanceof Error ? e.message : e}`)
    }
  }

  const showPreview = preview?.clipId === clip.id
  const candidates = showPreview ? preview.candidates : []
  const selectedCount = candidates.filter((c) => c.selected).length
  const totalSaved = candidates.filter((c) => c.selected).reduce((sum, c) => sum + (c.end - c.start), 0)

  return (
    <>
      <h4>무음 자동 컷</h4>
      {!showPreview && (
        <>
          <Row label="임계값(dB)">
            <input type="number" step={1} value={noiseDb} onChange={(e) => setNoiseDb(Number(e.target.value))} />
          </Row>
          <Row label="최소 길이(초)">
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={minDurationSec}
              onChange={(e) => setMinDurationSec(Math.max(0.1, Number(e.target.value)))}
            />
          </Row>
          <button
            className="btn small"
            data-testid="detect-silence-btn"
            disabled={silenceActive}
            onClick={() => void run()}
            style={{ width: '100%', marginTop: 4 }}
          >
            ✦ 무음 감지
          </button>
        </>
      )}
      {showPreview && (
        <>
          <p className="hint" style={{ fontSize: 11, textAlign: 'left' }}>
            {candidates.length}개 구간 감지됨 · 선택 {selectedCount}개 · 총 {totalSaved.toFixed(1)}초 절약
          </p>
          <div data-testid="silence-candidate-list" style={{ maxHeight: 140, overflowY: 'auto' }}>
            {candidates.map((c) => (
              <label key={c.id} className="insp-row" style={{ fontSize: 11 }}>
                <input type="checkbox" checked={c.selected} onChange={() => toggleCandidate(c.id)} />
                <span>
                  {formatTimecode(c.start, project.settings.fps)} – {formatTimecode(c.end, project.settings.fps)}
                </span>
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <button
              className="btn small"
              data-testid="apply-silence-btn"
              disabled={selectedCount === 0}
              onClick={() => applySilenceCut()}
              style={{ flex: 1 }}
            >
              적용
            </button>
            <button className="btn small" data-testid="cancel-silence-btn" onClick={() => cancelSilencePreview()} style={{ flex: 1 }}>
              취소
            </button>
          </div>
        </>
      )}
    </>
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

  // 시스템 폰트 목록(메인 프로세스 IPC 조회) — 실패 시 범용 웹세이프 폰트로 폴백
  const [fonts, setFonts] = useState<string[]>(GENERIC_FONT_FALLBACK)
  useEffect(() => {
    let alive = true
    void listSystemFonts().then((list) => {
      if (alive && list.length > 0) setFonts(list)
    })
    return () => {
      alive = false
    }
  }, [])

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
      <Row label="폰트">
        <select data-testid="text-font" value={text.fontFamily} onChange={(e) => setText('폰트', { fontFamily: e.target.value })}>
          {!fonts.includes(text.fontFamily) && <option value={text.fontFamily}>{displayFontName(text.fontFamily)}</option>}
          {fonts.map((f) => (
            <option key={f} value={f}>
              {displayFontName(f)}
            </option>
          ))}
        </select>
      </Row>
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
