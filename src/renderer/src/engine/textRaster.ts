/**
 * 텍스트 래스터 (3.1) — TextContent 를 Canvas2D 로 그려 WebGL 텍스처 소스로 만든다.
 * 프리뷰·내보내기가 동일 래스터를 사용 → 폰트 렌더링 WYSIWYG.
 *
 * 애니메이션(3.1.5)은 합성 시점의 opacity/transform 보정으로 처리하고(래스터 불변 = 캐시 유지),
 * 예외로 타이프라이터만 "가시 글자수"가 래스터에 들어간다 — 레이아웃은 항상 전체 텍스트 기준으로
 * 고정해 타이핑 중에도 블록 크기/정렬이 흔들리지 않는다.
 */
import type { Clip, TextAnimation, TextContent } from '@shared/model/types'

export interface TextRaster {
  canvas: HTMLCanvasElement
  width: number
  height: number
}

const cache = new Map<string, TextRaster>()
// 타이프라이터는 글자수별 래스터를 만들므로 여유 있게 (캔버스가 작아 메모리 부담 낮음)
const MAX_CACHE = 256

function styleKey(t: TextContent, visibleChars: number): string {
  return JSON.stringify([
    t.value,
    t.fontFamily,
    t.fontSize,
    t.color,
    t.align,
    t.bold,
    t.italic,
    t.letterSpacing,
    t.lineHeight,
    t.gradient,
    t.glow,
    t.stroke,
    t.shadow,
    t.background,
    t.highlight,
    visibleChars
  ])
}

/** 줄별 가시 글자수 배분 (타이프라이터) — 개행 문자는 소비하지 않는 글자로 취급 */
function visiblePerLine(lines: string[], visibleChars: number): string[] {
  let remain = visibleChars
  return lines.map((line) => {
    const take = Math.max(0, Math.min(line.length, remain))
    remain -= take
    return line.slice(0, take)
  })
}

export function rasterizeText(t: TextContent, visibleChars?: number): TextRaster {
  const total = t.value.length
  const visible = visibleChars === undefined ? total : Math.max(0, Math.min(total, visibleChars))
  const key = styleKey(t, visible)
  const hit = cache.get(key)
  if (hit) return hit

  const lines = t.value.split('\n')
  const shownLines = visible >= total ? lines : visiblePerLine(lines, visible)
  const font = `${t.italic ? 'italic ' : ''}${t.bold ? '700 ' : '400 '}${t.fontSize}px ${t.fontFamily}`
  const lineHeight = Math.ceil(t.fontSize * (t.lineHeight ?? 1.25))
  const letterSpacing = `${t.letterSpacing ?? 0}px`
  const strokeW = t.stroke?.width ?? 0
  const shadowPad = t.shadow ? Math.ceil(t.shadow.blur + Math.max(Math.abs(t.shadow.x), Math.abs(t.shadow.y))) : 0
  const glowPad = t.glow ? Math.ceil(t.glow.strength * 1.5) : 0
  const bgPad = t.background?.padding ?? 0
  const hlPad = t.highlight?.padding ?? 6
  const pad = Math.ceil(Math.max(strokeW, shadowPad, glowPad, bgPad, t.highlight ? hlPad : 0)) + 4

  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = font
  measure.letterSpacing = letterSpacing
  // 레이아웃(블록 크기·정렬 기준)은 항상 전체 텍스트로 측정 — 타이프라이터 중 흔들림 방지
  const textW = Math.max(1, ...lines.map((l) => Math.ceil(measure.measureText(l).width)))
  const textH = lineHeight * lines.length

  const canvas = document.createElement('canvas')
  canvas.width = textW + pad * 2
  canvas.height = textH + pad * 2
  const ctx = canvas.getContext('2d')!
  ctx.font = font
  ctx.letterSpacing = letterSpacing
  ctx.textBaseline = 'middle'

  // 글자색: 그라디언트 지정 시 텍스트 블록 전체 기준의 선형 그라디언트
  const fillStyle: string | CanvasGradient = (() => {
    if (!t.gradient) return t.color
    const g = t.gradient.horizontal
      ? ctx.createLinearGradient(pad, 0, pad + textW, 0)
      : ctx.createLinearGradient(0, pad, 0, pad + textH)
    g.addColorStop(0, t.gradient.from)
    g.addColorStop(1, t.gradient.to)
    return g
  })()

  if (t.background) {
    ctx.fillStyle = t.background.color
    const p = t.background.padding
    const r = Math.max(0, t.background.radius ?? 0)
    ctx.beginPath()
    ctx.roundRect(pad - p, pad - p, textW + p * 2, textH + p * 2, r)
    ctx.fill()
  }

  const fullResetShadow = (): void => {
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
  }

  for (let i = 0; i < lines.length; i++) {
    const fullLine = lines[i]
    const line = shownLines[i]
    if (!line) continue
    const fullW = measure.measureText(fullLine).width
    const shownW = measure.measureText(line).width
    // 정렬 기준은 전체 라인 폭 (부분 표시여도 시작 위치 고정)
    const x = t.align === 'left' ? pad : t.align === 'right' ? pad + textW - fullW : pad + (textW - fullW) / 2
    const y = pad + lineHeight * i + lineHeight / 2

    // 형광펜: 표시된 부분만큼 줄 박스 (타이프라이터를 따라 늘어난다)
    if (t.highlight) {
      ctx.fillStyle = t.highlight.color
      ctx.fillRect(x - hlPad, y - lineHeight / 2 - 2, shownW + hlPad * 2, lineHeight + 4)
    }

    // 네온 글로우: 블러 그림자 사전 패스 ×2 (fill 색으로 발광 코어를 만든 뒤 본 드로우)
    if (t.glow) {
      ctx.shadowColor = t.glow.color
      ctx.shadowBlur = t.glow.strength
      ctx.fillStyle = fillStyle
      ctx.fillText(line, x, y)
      ctx.fillText(line, x, y)
      fullResetShadow()
    }

    if (t.shadow) {
      ctx.shadowColor = t.shadow.color
      ctx.shadowBlur = t.shadow.blur
      ctx.shadowOffsetX = t.shadow.x
      ctx.shadowOffsetY = t.shadow.y
    }
    if (t.stroke && t.stroke.width > 0) {
      ctx.strokeStyle = t.stroke.color
      ctx.lineWidth = t.stroke.width
      ctx.lineJoin = 'round'
      ctx.strokeText(line, x, y)
    }
    ctx.fillStyle = fillStyle
    ctx.fillText(line, x, y)
    fullResetShadow()
  }

  const raster: TextRaster = { canvas, width: canvas.width, height: canvas.height }
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  cache.set(key, raster)
  return raster
}

export interface AnimState {
  opacityMul: number
  offsetX: number
  offsetY: number
  scaleMul: number
  /** 타이프라이터: 표시할 글자 비율 (1 = 전체) */
  visibleRatio: number
}

const IDENTITY: AnimState = { opacityMul: 1, offsetX: 0, offsetY: 0, scaleMul: 1, visibleRatio: 1 }

/** 등장 방향 벡터 — "어느 쪽에서 들어오는가" (등장 시작 오프셋 방향) */
const SLIDE_DIR: Record<string, [number, number]> = {
  slide: [0, 1], // 아래에서
  'slide-down': [0, -1], // 위에서
  'slide-left': [-1, 0], // 왼쪽에서
  'slide-right': [1, 0] // 오른쪽에서
}

function applyAnim(anim: TextAnimation, progress: number, out: boolean): AnimState {
  // progress: 0(시작)→1(완료). out 애니메이션은 진행될수록 사라진다.
  const p = Math.min(1, Math.max(0, progress))
  const vis = out ? 1 - p : p
  const ease = vis * vis * (3 - 2 * vis) // smoothstep
  const type = anim.type
  if (type in SLIDE_DIR) {
    const dist = anim.params?.distance ?? 80
    const [dx, dy] = SLIDE_DIR[type]
    // in: 방향에서 미끄러져 들어옴 / out: 반대 방향으로 빠져나감
    const k = (1 - ease) * dist * (out ? -1 : 1)
    return { ...IDENTITY, opacityMul: ease, offsetX: dx * k, offsetY: dy * k }
  }
  switch (type) {
    case 'fade':
      return { ...IDENTITY, opacityMul: ease }
    case 'pop': {
      const overshoot = out ? 1 : 1 + 0.15 * Math.sin(Math.min(1, ease * 1.2) * Math.PI)
      return { ...IDENTITY, opacityMul: ease, scaleMul: (0.6 + 0.4 * ease) * overshoot }
    }
    case 'zoom':
      // in: 크게서 줄며 정착, out: 커지며 사라짐
      return { ...IDENTITY, opacityMul: ease, scaleMul: 1 + 0.6 * (1 - ease) }
    case 'typewriter':
      // 글자 수로 표현 — 투명도/이동 없음
      return { ...IDENTITY, visibleRatio: vis }
    default:
      return { ...IDENTITY, opacityMul: ease }
  }
}

/** 지속 루프 (shake/pulse/float) — 클립 상대 시간의 결정론적 함수 (프리뷰=내보내기, WYSIWYG) */
function applyLoop(loop: TextAnimation, rel: number, state: AnimState): AnimState {
  const intensity = loop.params?.intensity ?? 1
  const period = loop.duration > 0 ? loop.duration : 1.2
  const phase = (rel / period) * Math.PI * 2
  switch (loop.type) {
    case 'shake': {
      // 고정 주파수 sin 조합 — 난수 없이 지터 (결정론)
      const jx = (Math.sin(rel * 37) + 0.6 * Math.sin(rel * 59 + 1.3)) * 2.2 * intensity
      const jy = (Math.sin(rel * 47 + 0.7) + 0.6 * Math.sin(rel * 71)) * 1.6 * intensity
      return { ...state, offsetX: state.offsetX + jx, offsetY: state.offsetY + jy }
    }
    case 'pulse':
      return { ...state, scaleMul: state.scaleMul * (1 + 0.06 * intensity * Math.sin(phase)) }
    case 'float':
      return { ...state, offsetY: state.offsetY + 7 * intensity * Math.sin(phase) }
    default:
      return state
  }
}

/** 클립 내 상대 시간에서의 텍스트 애니메이션 상태 (3.1.5) — 등장/퇴장 + 루프 결합 */
export function textAnimState(clip: Clip, timelineT: number): AnimState {
  const t = clip.text
  if (!t) return IDENTITY
  const rel = timelineT - clip.timelineStart
  const len = clip.timelineEnd - clip.timelineStart

  let state = IDENTITY
  if (t.animationIn && t.animationIn.duration > 0 && rel < t.animationIn.duration) {
    state = applyAnim(t.animationIn, rel / t.animationIn.duration, false)
  }
  if (t.animationOut && t.animationOut.duration > 0 && rel > len - t.animationOut.duration) {
    const outState = applyAnim(t.animationOut, (rel - (len - t.animationOut.duration)) / t.animationOut.duration, true)
    state = {
      opacityMul: state.opacityMul * outState.opacityMul,
      offsetX: state.offsetX + outState.offsetX,
      offsetY: state.offsetY + outState.offsetY,
      scaleMul: state.scaleMul * outState.scaleMul,
      visibleRatio: Math.min(state.visibleRatio, outState.visibleRatio)
    }
  }
  if (t.loop && t.loop.type !== 'none') state = applyLoop(t.loop, rel, state)
  return state
}
