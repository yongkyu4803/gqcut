/**
 * 텍스트 래스터 (3.1) — TextContent 를 Canvas2D 로 그려 WebGL 텍스처 소스로 만든다.
 * 프리뷰·내보내기가 동일 래스터를 사용 → 폰트 렌더링 WYSIWYG.
 * 애니메이션(3.1.5)은 래스터가 아니라 합성 시점의 opacity/transform 보정으로 처리한다.
 */
import type { Clip, TextAnimation, TextContent } from '@shared/model/types'

export interface TextRaster {
  canvas: HTMLCanvasElement
  width: number
  height: number
}

const cache = new Map<string, TextRaster>()
const MAX_CACHE = 64

function styleKey(t: TextContent): string {
  return JSON.stringify([t.value, t.fontFamily, t.fontSize, t.color, t.align, t.bold, t.italic, t.stroke, t.shadow, t.background])
}

export function rasterizeText(t: TextContent): TextRaster {
  const key = styleKey(t)
  const hit = cache.get(key)
  if (hit) return hit

  const lines = t.value.split('\n')
  const font = `${t.italic ? 'italic ' : ''}${t.bold ? '700 ' : '400 '}${t.fontSize}px ${t.fontFamily}`
  const lineHeight = Math.ceil(t.fontSize * 1.25)
  const strokeW = t.stroke?.width ?? 0
  const shadowPad = t.shadow ? Math.ceil(t.shadow.blur + Math.max(Math.abs(t.shadow.x), Math.abs(t.shadow.y))) : 0
  const bgPad = t.background?.padding ?? 0
  const pad = Math.ceil(Math.max(strokeW, shadowPad, bgPad)) + 4

  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = font
  const textW = Math.max(1, ...lines.map((l) => Math.ceil(measure.measureText(l).width)))
  const textH = lineHeight * lines.length

  const canvas = document.createElement('canvas')
  canvas.width = textW + pad * 2
  canvas.height = textH + pad * 2
  const ctx = canvas.getContext('2d')!
  ctx.font = font
  ctx.textBaseline = 'middle'

  if (t.background) {
    ctx.fillStyle = t.background.color
    const p = t.background.padding
    ctx.fillRect(pad - p, pad - p, textW + p * 2, textH + p * 2)
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lw = measure.measureText(line).width
    const x = t.align === 'left' ? pad : t.align === 'right' ? pad + textW - lw : pad + (textW - lw) / 2
    const y = pad + lineHeight * i + lineHeight / 2

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
    ctx.fillStyle = t.color
    ctx.fillText(line, x, y)
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
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
}

const IDENTITY: AnimState = { opacityMul: 1, offsetX: 0, offsetY: 0, scaleMul: 1 }

function applyAnim(anim: TextAnimation, progress: number, out: boolean): AnimState {
  // progress: 0(시작)→1(완료). out 애니메이션은 진행될수록 사라진다.
  const p = Math.min(1, Math.max(0, progress))
  const vis = out ? 1 - p : p
  const ease = vis * vis * (3 - 2 * vis) // smoothstep
  switch (anim.type) {
    case 'fade':
      return { ...IDENTITY, opacityMul: ease }
    case 'slide': {
      const dist = anim.params?.distance ?? 80
      return { ...IDENTITY, opacityMul: ease, offsetY: (1 - ease) * dist * (out ? -1 : 1) }
    }
    case 'pop': {
      // 가벼운 오버슛
      const overshoot = out ? 1 : 1 + 0.15 * Math.sin(Math.min(1, ease * 1.2) * Math.PI)
      return { ...IDENTITY, opacityMul: ease, scaleMul: (0.6 + 0.4 * ease) * overshoot }
    }
    default:
      return { ...IDENTITY, opacityMul: ease }
  }
}

/** 클립 내 상대 시간에서의 등장/퇴장 애니메이션 상태 (3.1.5) */
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
      scaleMul: state.scaleMul * outState.scaleMul
    }
  }
  return state
}
