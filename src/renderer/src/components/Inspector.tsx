/**
 * 인스펙터 — 선택 클립 속성 편집: 볼륨/페이드(2.2), 변형/불투명도, 텍스트 스타일·애니메이션(3.1),
 * 색보정 필터(4.1), 클립 간 전환(4.2)
 */
import { useEffect, useState } from 'react'
import type { Clip, Effect, Project, TextAnimation, TextContent, Track, Transition } from '@shared/model/types'
import { FILTER_SPECS, TRANSITION_TYPES } from '@shared/effects-spec'
import { DEFAULT_STT_LANGUAGE, STT_LANGUAGES, STT_MODEL_INFO, type SttModel } from '@shared/subtitles'
import { applyTextPreset, TEXT_PRESETS } from '@shared/textPresets'
import { SFX_BY_ID, SFX_LIBRARY } from '@shared/sfx'
import { formatTimecode } from '@shared/time'
import { playback } from '@renderer/engine/playback'
import { useEditor, type SilenceScope } from '@renderer/state/store'
import { findClip, setClipSpeed, updateClips, updateSettings } from '@renderer/state/commands'
import { displayFontName, GENERIC_FONT_FALLBACK, listSystemFonts } from '@renderer/engine/fonts'
import { exportSubtitlesSrt, generateCaptions } from '@renderer/stt/autoCaption'
import { applySilenceCut, cancelSilencePreview, detectSilence } from '@renderer/silence/autoCut'
import { rangesCoverage } from '@shared/silence'

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="insp-row">
      <span>{label}</span>
      {children}
    </label>
  )
}

const DEFAULT_TRANSFORM = { x: 0, y: 0, scale: 1, rotation: 0 }

/** 인스펙터가 서브패널에 넘기는 setter — 단일/다중 선택 모두 동일하게 동작한다.
 *  set: 모든 선택 클립에 같은 값(스칼라 필드). setEach: 클립별로 계산한 패치(text/effects/transform 처럼 기존 값을 병합해야 하는 필드). */
interface ClipSetters {
  set: (label: string, patch: Partial<Clip>) => void
  setEach: (label: string, fn: (clip: Clip) => Partial<Clip>) => void
}

export function Inspector(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const selectedClipIds = useEditor((s) => s.selectedClipIds)
  const dispatch = useEditor((s) => s.dispatch)

  const selectedClips = selectedClipIds.map((id) => findClip(project, id)?.clip).filter((c): c is Clip => !!c)
  const primary = selectedClips.at(-1) ?? null
  const primaryTrack = primary ? findClip(project, primary.id)?.track ?? null : null
  const multi = selectedClips.length > 1

  const setters: ClipSetters = {
    setEach: (label, fn) => dispatch(label, (p) => updateClips(p, selectedClipIds, fn)),
    set: (label, patch) => dispatch(label, (p) => updateClips(p, selectedClipIds, () => patch))
  }
  const { set, setEach } = setters

  if (!primary) {
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

  const clip = primary
  const t = clip.transform ?? DEFAULT_TRANSFORM
  // 다중 선택 시 종류별 공통 속성만 노출 (혼합 선택 오적용 방지)
  const every = (pred: (c: Clip) => boolean): boolean => selectedClips.every(pred)
  const showVisual = every((c) => c.kind !== 'audio') // 불투명도/변형
  const showFilter = every((c) => c.kind === 'video' || c.kind === 'image')
  const showAudio = every((c) => c.kind === 'video' || c.kind === 'audio')
  const showFade = every((c) => c.kind !== 'text')
  const showText = every((c) => c.kind === 'text')

  const kindName = (k: Clip['kind']): string => (k === 'text' ? '텍스트' : k === 'audio' ? '오디오' : '비디오')
  const heading = multi
    ? `${every((c) => c.kind === clip.kind) ? kindName(clip.kind) : '혼합'} 클립 ${selectedClips.length}개 선택`
    : `${kindName(clip.kind)} 클립`

  return (
    <div className="inspector" data-testid="inspector">
      <h3 data-testid="inspector-heading">{heading}</h3>
      {multi && <p className="hint">여러 클립에 함께 적용됩니다 (⌘Z 로 한 번에 되돌리기)</p>}

      {showVisual && (
        <>
          <Row label="불투명도">
            <input type="range" min={0} max={1} step={0.01} value={clip.opacity ?? 1} onChange={(e) => set('불투명도', { opacity: Number(e.target.value) })} />
          </Row>
          <Row label="크기">
            <input
              type="range"
              min={0.1}
              max={4}
              step={0.01}
              value={t.scale}
              onChange={(e) => setEach('크기', (c) => ({ transform: { ...(c.transform ?? DEFAULT_TRANSFORM), scale: Number(e.target.value) } }))}
            />
          </Row>
          <Row label="회전°">
            <input
              type="number"
              value={Math.round(t.rotation)}
              onChange={(e) => setEach('회전', (c) => ({ transform: { ...(c.transform ?? DEFAULT_TRANSFORM), rotation: Number(e.target.value) } }))}
            />
          </Row>
          <Row label="위치 X">
            <input
              type="number"
              value={Math.round(t.x)}
              onChange={(e) => setEach('위치', (c) => ({ transform: { ...(c.transform ?? DEFAULT_TRANSFORM), x: Number(e.target.value) } }))}
            />
          </Row>
          <Row label="위치 Y">
            <input
              type="number"
              value={Math.round(t.y)}
              onChange={(e) => setEach('위치', (c) => ({ transform: { ...(c.transform ?? DEFAULT_TRANSFORM), y: Number(e.target.value) } }))}
            />
          </Row>
        </>
      )}

      {showFilter && <FilterPanel clip={clip} setters={setters} />}
      {showFilter &&
        (multi ? (
          <BatchTransitionPanel project={project} clips={selectedClips} dispatch={dispatch} />
        ) : (
          primaryTrack && <TransitionPanel clip={clip} track={primaryTrack} onSet={set} />
        ))}

      {!multi && (clip.kind === 'video' || clip.kind === 'audio') && (
        <>
          <h4>속도</h4>
          <Row label="배속">
            <input
              type="number"
              data-testid="clip-speed"
              min={0.25}
              max={4}
              step={0.05}
              value={clip.speed ?? 1}
              onChange={(e) => dispatch('속도 변경', (p) => setClipSpeed(p, clip.id, Number(e.target.value)))}
            />
          </Row>
          <Row label="프리셋">
            {[0.5, 1, 2].map((v) => (
              <button
                key={v}
                className={`mini-btn ${Math.abs((clip.speed ?? 1) - v) < 1e-6 ? 'active' : ''}`}
                onClick={() => dispatch(`속도 ${v}x`, (p) => setClipSpeed(p, clip.id, v))}
              >
                {v}×
              </button>
            ))}
          </Row>
        </>
      )}

      {showAudio && (
        <>
          <h4>오디오</h4>
          <Row label="볼륨">
            <input type="range" min={0} max={1} step={0.01} value={clip.volume ?? 1} onChange={(e) => set('클립 볼륨', { volume: Number(e.target.value) })} />
          </Row>
        </>
      )}

      {showFade && (
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

      {!multi && clip.kind === 'video' && <CaptionPanel clip={clip} />}

      {!multi && clip.kind === 'video' && <SilenceCutPanel clip={clip} />}

      {showText && clip.text && <TextPanel clip={clip} text={clip.text} setters={setters} />}
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
  const [scope, setScope] = useState<SilenceScope>('this-track')
  if (!asset?.hasAudio) return null

  const run = async (): Promise<void> => {
    try {
      const n = await detectSilence(clip.id, { noiseDb, minDurationSec, scope })
      if (n === 0) alert('무음 구간을 찾지 못했습니다')
    } catch (e) {
      alert(`무음 감지 실패: ${e instanceof Error ? e.message : e}`)
    }
  }

  const showPreview = preview?.clipId === clip.id
  const candidates = showPreview ? preview.candidates : []
  const selectedCount = candidates.filter((c) => c.selected).length
  const totalSaved = candidates.filter((c) => c.selected).reduce((sum, c) => sum + (c.end - c.start), 0)
  // 클립 전체가 무음으로 잡히면 감지 오류일 가능성 — 수동 UI 는 차단하지 않고 경고만(사용자가 직접 판단)
  const coverage = rangesCoverage(
    candidates.filter((c) => c.selected).map((c) => [c.start, c.end]),
    clip.timelineStart,
    clip.timelineEnd
  )

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
          <Row label="적용 범위">
            <select data-testid="silence-scope-select" value={scope} onChange={(e) => setScope(e.target.value as SilenceScope)}>
              <option value="this-track">이 트랙만</option>
              <option value="all-tracks">전체 트랙(자막도 당기고, 배경음악은 위치만 밀림)</option>
            </select>
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
            <br />
            적용 범위: {preview.scope === 'all-tracks' ? '전체 트랙' : '이 트랙만'}
          </p>
          {coverage >= 0.95 && (
            <p className="hint" data-testid="silence-coverage-warn" style={{ fontSize: 11, textAlign: 'left', color: '#ffb4b4' }}>
              ⚠️ 선택 구간이 클립의 {Math.round(coverage * 100)}%입니다 — 적용하면 클립이 거의 사라집니다. 감지 오류라면 임계값을 -45dB 등으로 낮춰 다시 감지하세요.
            </p>
          )}
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
function FilterPanel({ clip, setters }: { clip: Clip; setters: ClipSetters }): React.JSX.Element {
  const effects = clip.effects ?? []
  const valueOf = (type: string, def: number): number => {
    const e = effects.find((x) => x.type === type)
    return e && e.enabled ? (e.params.value ?? def) : def
  }
  // 클립별로 자기 effects 에 병합 — 다른 필터 값 보존 (다중 선택 시 primary 값으로 덮어쓰지 않음)
  const upsert = (list: Effect[], type: string, value: number): Effect[] =>
    list.some((e) => e.type === type)
      ? list.map((e) => (e.type === type ? { ...e, enabled: true, params: { ...e.params, value } } : e))
      : [...list, { type, params: { value }, enabled: true }]
  const setValue = (type: string, label: string, value: number): void => {
    setters.setEach(`필터: ${label}`, (c) => ({ effects: upsert(c.effects ?? [], type, value) }))
  }
  const hasAny = effects.some((e) => e.enabled)
  return (
    <>
      <h4>
        필터{' '}
        {hasAny && (
          <button className="mini-btn" title="필터 초기화" onClick={() => setters.set('필터 초기화', { effects: [] })}>
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
/** 전환 효과음 컨트롤 (phase-9) — 셀렉트 + 볼륨 + 미리듣기. 단일/일괄 전환 패널이 공유. */
function SfxControls({
  sound,
  testIdPrefix,
  onChange
}: {
  sound: Transition['sound']
  testIdPrefix: string
  onChange: (sound: Transition['sound']) => void
}): React.JSX.Element {
  const id = sound?.id
  const def = id ? SFX_BY_ID.get(id) : undefined
  const volume = sound?.volume ?? def?.defaultVolume ?? 0.8
  return (
    <>
      <Row label="효과음">
        <select
          data-testid={`${testIdPrefix}-sfx`}
          value={id ?? 'none'}
          onChange={(e) => onChange(e.target.value === 'none' ? undefined : { id: e.target.value, volume: sound?.volume })}
        >
          <option value="none">없음</option>
          {SFX_LIBRARY.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        {id && (
          <button className="mini-btn" title="미리듣기" onClick={() => void playback.previewSfx(id, volume)}>
            ▶
          </button>
        )}
      </Row>
      {id && (
        <Row label="효과음 볼륨">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => onChange({ id, volume: Number(e.target.value) })}
          />
        </Row>
      )}
    </>
  )
}

function TransitionPanel({ clip, track, onSet }: { clip: Clip; track: Track; onSet: (label: string, patch: Partial<Clip>) => void }): React.JSX.Element | null {
  const sorted = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart)
  const idx = sorted.findIndex((c) => c.id === clip.id)
  const next = idx >= 0 ? sorted[idx + 1] : undefined
  const adjacent = next && Math.abs(next.timelineStart - clip.timelineEnd) < 1e-3
  if (!adjacent) return null

  const maxDur = Math.min(clip.timelineEnd - clip.timelineStart, next.timelineEnd - next.timelineStart)
  const t = clip.transitionOut

  const setTransition = (patch: Partial<Transition> | null, label = '전환 설정'): void => {
    if (patch === null) {
      onSet('전환 제거', { transitionOut: undefined })
    } else {
      // 기존 전환을 스프레드해 sound/params 등 다른 필드를 보존한 뒤 패치 적용
      const base: Transition = t ?? { type: 'dissolve', duration: Math.min(1, maxDur) }
      const merged: Transition = { ...base, ...patch }
      merged.duration = Math.min(Math.max(0.1, merged.duration), maxDur)
      onSet(label, { transitionOut: merged })
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
        <>
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
          <SfxControls sound={t.sound} testIdPrefix="transition" onChange={(sound) => setTransition({ sound }, '전환 효과음')} />
        </>
      )}
    </>
  )
}

/** 선택 클립의 다음-인접 정보 — 전환은 다음 클립과 맞닿아 있을 때만 유효(불변식 §6) */
function nextAdjacency(project: Project, clip: Clip): { maxDur: number } | null {
  const found = findClip(project, clip.id)
  if (!found) return null
  const sorted = [...found.track.clips].sort((a, b) => a.timelineStart - b.timelineStart)
  const idx = sorted.findIndex((c) => c.id === clip.id)
  const next = idx >= 0 ? sorted[idx + 1] : undefined
  if (!next || Math.abs(next.timelineStart - clip.timelineEnd) >= 1e-3) return null
  return { maxDur: Math.min(clip.timelineEnd - clip.timelineStart, next.timelineEnd - next.timelineStart) }
}

const clampDur = (d: number, max: number): number => Math.min(Math.max(0.1, d), max)

/** 전환 일괄 적용 (8.4) — 선택 클립 중 다음 컷과 인접한 것에만, duration 은 pair 별 maxDur 로 개별 클램프 */
function BatchTransitionPanel({
  project,
  clips,
  dispatch
}: {
  project: Project
  clips: Clip[]
  dispatch: (label: string, fn: (p: Project) => Project) => void
}): React.JSX.Element {
  const applicableIds = clips.filter((c) => nextAdjacency(project, c)).map((c) => c.id)
  const skipped = clips.length - applicableIds.length
  const primaryT = clips.at(-1)?.transitionOut
  const [type, setType] = useState<string>(primaryT?.type ?? 'none')
  const [dur, setDur] = useState<number>(primaryT?.duration ?? 1)
  const [sound, setSound] = useState<Transition['sound']>(primaryT?.sound)

  const applyType = (nextType: string): void => {
    setType(nextType)
    if (nextType === 'none') {
      setSound(undefined)
      dispatch('전환 일괄 제거', (p) => updateClips(p, applicableIds, () => ({ transitionOut: undefined })))
    } else {
      dispatch('전환 일괄 설정', (p) =>
        updateClips(p, applicableIds, (c) => {
          const info = nextAdjacency(p, c)
          // 기존 transitionOut 을 스프레드해 효과음(sound) 등 다른 필드 보존
          return info ? { transitionOut: { ...(c.transitionOut ?? {}), type: nextType, duration: clampDur(dur, info.maxDur) } } : {}
        })
      )
    }
  }
  const applyDur = (nextDur: number): void => {
    setDur(nextDur)
    if (type === 'none') return
    dispatch('전환 길이 일괄', (p) =>
      updateClips(p, applicableIds, (c) => {
        const info = nextAdjacency(p, c)
        return info ? { transitionOut: { ...(c.transitionOut ?? {}), type, duration: clampDur(nextDur, info.maxDur) } } : {}
      })
    )
  }
  const applySound = (nextSound: Transition['sound']): void => {
    setSound(nextSound)
    dispatch('전환 효과음 일괄', (p) =>
      updateClips(p, applicableIds, (c) => {
        const info = nextAdjacency(p, c)
        if (!info) return {}
        // 효과음은 전환이 있어야 붙는다 — 없으면 현재 일괄 유형/길이로 전환을 생성해 붙인다
        const base = c.transitionOut ?? (type !== 'none' ? { type, duration: clampDur(dur, info.maxDur) } : null)
        if (!base) return {}
        return { transitionOut: { ...base, duration: clampDur(base.duration, info.maxDur), sound: nextSound } }
      })
    )
  }

  return (
    <>
      <h4>다음 클립으로 전환 (일괄)</h4>
      {applicableIds.length === 0 ? (
        <p className="hint">선택한 클립 중 다음 컷과 맞닿은 것이 없어 전환을 적용할 수 없습니다.</p>
      ) : (
        <>
          <Row label="유형">
            <select data-testid="batch-transition-type" value={type} onChange={(e) => applyType(e.target.value)}>
              <option value="none">없음</option>
              {TRANSITION_TYPES.map((tt) => (
                <option key={tt.type} value={tt.type}>
                  {tt.label}
                </option>
              ))}
            </select>
          </Row>
          {type !== 'none' && (
            <>
              <Row label="길이(초)">
                <input type="number" min={0.1} step={0.1} value={dur} onChange={(e) => applyDur(Number(e.target.value))} />
              </Row>
              <SfxControls sound={sound} testIdPrefix="batch-transition" onChange={applySound} />
            </>
          )}
          <p className="hint">
            {applicableIds.length}개 컷에 적용{skipped > 0 ? `, ${skipped}개는 인접 컷이 없어 제외` : ''} (길이는 각 컷 길이에 맞게 자동 조정)
          </p>
        </>
      )}
    </>
  )
}

function TextPanel({ clip, text, setters }: { clip: Clip; text: TextContent; setters: ClipSetters }): React.JSX.Element {
  void clip
  // 클립별로 자기 text 에 변경 필드만 병합 — 다중 선택 시 각 자막의 내용·색 등 나머지 스타일 보존
  const setText = (label: string, patch: Partial<TextContent>): void =>
    setters.setEach(label, (c) => ({ text: { ...(c.text as TextContent), ...patch } }))

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
          <option value="slide">슬라이드 ↑</option>
          <option value="slide-down">슬라이드 ↓</option>
          <option value="slide-left">슬라이드 →</option>
          <option value="slide-right">슬라이드 ←</option>
          <option value="pop">팝</option>
          <option value="zoom">줌</option>
          <option value="typewriter">타이프라이터</option>
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
      <Row label="프리셋">
        <select
          data-testid="text-preset"
          value=""
          onChange={(e) => {
            const preset = TEXT_PRESETS.find((p) => p.id === e.target.value)
            if (preset) setters.setEach(`프리셋: ${preset.label}`, (c) => ({ text: applyTextPreset(c.text as TextContent, preset) }))
          }}
        >
          <option value="" disabled>
            스타일 선택…
          </option>
          {TEXT_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Row>
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
        <input
          type="number"
          data-testid="text-fontsize"
          min={8}
          value={text.fontSize}
          onChange={(e) => setText('폰트 크기', { fontSize: Math.max(8, Number(e.target.value)) })}
        />
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
      <Row label="자간(px)">
        <input type="number" step={0.5} value={text.letterSpacing ?? 0} onChange={(e) => setText('자간', { letterSpacing: Number(e.target.value) })} />
      </Row>
      <Row label="행간(배)">
        <input
          type="number"
          min={0.8}
          max={3}
          step={0.05}
          value={text.lineHeight ?? 1.25}
          onChange={(e) => setText('행간', { lineHeight: Math.max(0.8, Number(e.target.value)) })}
        />
      </Row>
      <Row label="그라디언트">
        <input
          type="checkbox"
          checked={!!text.gradient}
          onChange={(e) => setText('그라디언트', { gradient: e.target.checked ? { from: '#fff173', to: '#ff9a3d' } : undefined })}
        />
        {text.gradient && (
          <>
            <input type="color" value={text.gradient.from} onChange={(e) => setText('그라디언트 시작색', { gradient: { ...text.gradient!, from: e.target.value } })} />
            <input type="color" value={text.gradient.to} onChange={(e) => setText('그라디언트 끝색', { gradient: { ...text.gradient!, to: e.target.value } })} />
          </>
        )}
      </Row>
      <Row label="글로우">
        <input
          type="checkbox"
          checked={!!text.glow}
          onChange={(e) => setText('글로우', { glow: e.target.checked ? { color: '#31d7ff', strength: 20 } : undefined })}
        />
        {text.glow && (
          <>
            <input type="color" value={text.glow.color} onChange={(e) => setText('글로우 색', { glow: { ...text.glow!, color: e.target.value } })} />
            <input
              type="number"
              min={2}
              max={60}
              value={text.glow.strength}
              style={{ width: 52 }}
              onChange={(e) => setText('글로우 강도', { glow: { ...text.glow!, strength: Math.max(2, Number(e.target.value)) } })}
            />
          </>
        )}
      </Row>
      <Row label="형광펜">
        <input
          type="checkbox"
          checked={!!text.highlight}
          onChange={(e) => setText('형광펜', { highlight: e.target.checked ? { color: '#ffe14d', padding: 6 } : undefined })}
        />
        {text.highlight && (
          <input type="color" value={text.highlight.color} onChange={(e) => setText('형광펜 색', { highlight: { ...text.highlight!, color: e.target.value } })} />
        )}
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
          onChange={(e) => setText('배경 박스', { background: e.target.checked ? { color: 'rgba(0,0,0,0.55)', padding: 16, radius: 12 } : undefined })}
        />
        {text.background && (
          <>
            <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>라운드</span>
            <input
              type="number"
              min={0}
              max={60}
              value={text.background.radius ?? 0}
              style={{ width: 52 }}
              onChange={(e) => setText('배경 라운드', { background: { ...text.background!, radius: Math.max(0, Number(e.target.value)) } })}
            />
          </>
        )}
      </Row>
      <h4>애니메이션</h4>
      {animRow('animationIn', '등장')}
      {animRow('animationOut', '퇴장')}
      <Row label="루프">
        <select
          value={text.loop?.type ?? 'none'}
          onChange={(e) => {
            const type = e.target.value
            setText('루프 애니메이션', {
              loop: type === 'none' ? undefined : ({ type, duration: text.loop?.duration ?? 1.2, params: text.loop?.params } as TextAnimation)
            })
          }}
        >
          <option value="none">없음</option>
          <option value="shake">흔들림</option>
          <option value="pulse">펄스</option>
          <option value="float">둥실</option>
        </select>
        {text.loop && (
          <>
            <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>강도</span>
            <input
              type="number"
              min={0.2}
              max={3}
              step={0.1}
              value={text.loop.params?.intensity ?? 1}
              style={{ width: 52 }}
              onChange={(e) =>
                setText('루프 강도', { loop: { ...text.loop!, params: { ...text.loop!.params, intensity: Math.max(0.2, Number(e.target.value)) } } })
              }
            />
          </>
        )}
      </Row>
    </>
  )
}
