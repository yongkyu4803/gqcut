/**
 * effects-spec (4.1.1) — 이펙트 파라미터 규격 + 렌더 수식의 단일 소스 (WYSIWYG 핵심).
 *
 * 규칙 (globalVerificationGates): 프리뷰와 내보내기가 다르게 동작할 수 있는
 * 셰이더/수식/전환 타이밍은 여기에만 정의한다 — 복제 금지.
 * 색 연산은 sRGB 공간에서 수행한다 (프리뷰·내보내기 동일 — ARCHITECTURE §6.3).
 */
import type { Effect, Transition } from '../model/types'

// ── 필터 파라미터 규격 ──────────────────────────────────
export interface EffectParamSpec {
  key: string
  label: string
  min: number
  max: number
  default: number
  step: number
}

export interface EffectSpec {
  type: string
  label: string
  params: EffectParamSpec[]
}

export const FILTER_SPECS: EffectSpec[] = [
  { type: 'brightness', label: '밝기', params: [{ key: 'value', label: '값', min: -1, max: 1, default: 0, step: 0.01 }] },
  { type: 'contrast', label: '대비', params: [{ key: 'value', label: '값', min: 0, max: 2, default: 1, step: 0.01 }] },
  { type: 'saturation', label: '채도', params: [{ key: 'value', label: '값', min: 0, max: 2, default: 1, step: 0.01 }] },
  { type: 'temperature', label: '색온도', params: [{ key: 'value', label: '값', min: -1, max: 1, default: 0, step: 0.01 }] }
]

/** 클립의 effects 배열 → 셰이더 uniform 값 (미지정/비활성은 중립값) */
export interface ColorAdjust {
  brightness: number
  contrast: number
  saturation: number
  temperature: number
}

export const NEUTRAL_ADJUST: ColorAdjust = { brightness: 0, contrast: 1, saturation: 1, temperature: 0 }

export function resolveColorAdjust(effects: Effect[] | undefined): ColorAdjust {
  const out = { ...NEUTRAL_ADJUST }
  if (!effects) return out
  for (const e of effects) {
    if (!e.enabled) continue
    const v = e.params.value
    if (v === undefined) continue
    if (e.type === 'brightness') out.brightness = v
    else if (e.type === 'contrast') out.contrast = v
    else if (e.type === 'saturation') out.saturation = v
    else if (e.type === 'temperature') out.temperature = v
  }
  return out
}

export function isNeutral(a: ColorAdjust): boolean {
  return a.brightness === 0 && a.contrast === 1 && a.saturation === 1 && a.temperature === 0
}

/**
 * 색보정 GLSL (4.1.2) — 프리뷰·내보내기가 같은 문자열을 컴파일한다.
 * 입력 rgb 는 straight(un-premultiplied) sRGB.
 */
export const COLOR_ADJUST_GLSL = `
vec3 applyColorAdjust(vec3 rgb, float uBrightness, float uContrast, float uSaturation, float uTemperature) {
  rgb += uBrightness;
  rgb = (rgb - 0.5) * uContrast + 0.5;
  float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(luma), rgb, uSaturation);
  rgb += vec3(uTemperature, 0.0, -uTemperature) * 0.2;
  return clamp(rgb, 0.0, 1.0);
}
`

// ── 전환 (4.2) ──────────────────────────────────────────
export const TRANSITION_TYPES = [
  { type: 'dissolve', label: '디졸브' },
  { type: 'wipe', label: '와이프' },
  { type: 'slide', label: '슬라이드' }
] as const

/** 전환 셰이더의 type uniform 값 매핑 */
export function transitionTypeId(type: Transition['type']): number {
  switch (type) {
    case 'wipe':
      return 1
    case 'slide':
      return 2
    default:
      return 0 // dissolve (fade 포함)
  }
}

/**
 * 전환 GLSL (4.2.2) — A(나가는 클립)/B(들어오는 클립) 텍스처를 progress(0→1)로 보간.
 * 입력 텍스처는 premultiplied alpha (FBO 렌더 결과).
 */
export const TRANSITION_GLSL = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uProgress;
uniform int uType;

void main() {
  float p = clamp(uProgress, 0.0, 1.0);
  if (uType == 1) {
    // wipe: 왼쪽→오른쪽 경계 이동 (부드러운 8% 에지)
    float edge = smoothstep(p - 0.04, p + 0.04, vUV.x);
    gl_FragColor = mix(texture2D(uTexB, vUV), texture2D(uTexA, vUV), edge);
  } else if (uType == 2) {
    // slide: B 가 오른쪽에서 밀고 들어오고 A 는 왼쪽으로 밀려남
    vec2 uvA = vUV + vec2(p, 0.0);
    vec2 uvB = vUV - vec2(1.0 - p, 0.0);
    bool inB = uvB.x >= 0.0;
    vec4 a = (uvA.x <= 1.0) ? texture2D(uTexA, uvA) : vec4(0.0);
    vec4 b = inB ? texture2D(uTexB, uvB) : vec4(0.0);
    gl_FragColor = inB ? b : a;
  } else {
    // dissolve
    gl_FragColor = mix(texture2D(uTexA, vUV), texture2D(uTexB, vUV), p);
  }
}
`

/**
 * 전환의 시간 의미론 (DATA-MODEL §1.1): 컷 지점을 중심으로 duration 구간.
 * 반환: [start, end] — 클립 길이로 클램프.
 */
export function transitionZone(
  cutTime: number,
  duration: number,
  aStart: number,
  bEnd: number
): { start: number; end: number } {
  const half = duration / 2
  const start = Math.max(aStart, cutTime - half)
  const end = Math.min(bEnd, cutTime + half)
  return { start, end }
}
