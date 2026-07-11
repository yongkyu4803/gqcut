/**
 * 색보정 필터 프리셋 — 세피아/흑백 등 원클릭 톤. textPresets.ts 와 동일한 패턴:
 * 프리셋이 관리하는 필터 종류(brightness/contrast/saturation/temperature/tint)만 교체하고,
 * 그 외 클립 속성은 건드리지 않는다.
 */
import type { Effect } from './model/types'

/** 프리셋이 관리(교체)하는 필터 effect 종류 */
const FILTER_EFFECT_TYPES = ['brightness', 'contrast', 'saturation', 'temperature', 'tint'] as const

export interface ColorPresetValues {
  brightness?: number
  contrast?: number
  saturation?: number
  temperature?: number
  tint?: { r: number; g: number; b: number; amount: number }
}

export interface ColorPreset {
  id: string
  label: string
  values: ColorPresetValues
}

export const COLOR_PRESETS: ColorPreset[] = [
  { id: 'default', label: '기본(초기화)', values: {} },
  {
    id: 'sepia',
    label: '세피아',
    values: { saturation: 0.25, contrast: 1.05, temperature: 0.1, tint: { r: 0.94, g: 0.78, b: 0.55, amount: 0.55 } }
  },
  { id: 'noir', label: '흑백(느와르)', values: { saturation: 0, contrast: 1.15 } },
  {
    id: 'vintage',
    label: '빈티지',
    values: { saturation: 0.6, contrast: 0.92, brightness: 0.03, temperature: 0.15, tint: { r: 1, g: 0.92, b: 0.78, amount: 0.2 } }
  },
  { id: 'cool', label: '쿨톤', values: { temperature: -0.35, saturation: 1.05 } },
  { id: 'warm', label: '웜톤', values: { temperature: 0.35, saturation: 1.05 } },
  { id: 'dramatic', label: '드라마틱', values: { contrast: 1.4, saturation: 1.15, brightness: -0.02 } }
]

export const COLOR_PRESET_IDS = COLOR_PRESETS.map((p) => p.id) as [string, ...string[]]

/** 프리셋 적용 — 필터 종류(brightness/contrast/saturation/temperature/tint)는 전부 프리셋 기준으로 교체, 그 외 effect(있다면)는 유지 */
export function applyColorPreset(effects: Effect[] | undefined, preset: ColorPreset): Effect[] {
  const kept = (effects ?? []).filter((e) => !FILTER_EFFECT_TYPES.includes(e.type as (typeof FILTER_EFFECT_TYPES)[number]))
  const added: Effect[] = []
  const { brightness, contrast, saturation, temperature, tint } = preset.values
  if (brightness !== undefined) added.push({ type: 'brightness', params: { value: brightness }, enabled: true })
  if (contrast !== undefined) added.push({ type: 'contrast', params: { value: contrast }, enabled: true })
  if (saturation !== undefined) added.push({ type: 'saturation', params: { value: saturation }, enabled: true })
  if (temperature !== undefined) added.push({ type: 'temperature', params: { value: temperature }, enabled: true })
  if (tint !== undefined) added.push({ type: 'tint', params: { ...tint }, enabled: true })
  return [...kept, ...added]
}
