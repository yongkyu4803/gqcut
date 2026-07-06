/**
 * 자막 스타일 프리셋 — 시각 스타일 필드만 원클릭 교체.
 * value/fontFamily/align/애니메이션은 사용자의 것을 유지한다 (applyTextPreset).
 */
import type { TextContent } from './model/types'

/** 프리셋이 관리(덮어쓰기/초기화)하는 시각 스타일 필드 */
const STYLE_FIELDS = [
  'fontSize',
  'color',
  'bold',
  'italic',
  'letterSpacing',
  'lineHeight',
  'gradient',
  'glow',
  'stroke',
  'shadow',
  'background',
  'highlight'
] as const

export interface TextPreset {
  id: string
  label: string
  style: Partial<TextContent>
}

export const TEXT_PRESETS: TextPreset[] = [
  {
    id: 'default',
    label: '기본',
    style: {
      fontSize: 72,
      color: '#ffffff',
      bold: false,
      stroke: { color: '#000000', width: 4 }
    }
  },
  {
    id: 'variety',
    label: '예능',
    style: {
      fontSize: 84,
      bold: true,
      color: '#ffe14d',
      gradient: { from: '#fff173', to: '#ff9a3d' },
      stroke: { color: '#000000', width: 8 },
      shadow: { color: 'rgba(0,0,0,0.85)', blur: 2, x: 0, y: 6 }
    }
  },
  {
    id: 'neon',
    label: '네온',
    style: {
      fontSize: 76,
      bold: true,
      color: '#eafcff',
      glow: { color: '#31d7ff', strength: 22 },
      stroke: { color: '#0b6acb', width: 2 }
    }
  },
  {
    id: 'minimal',
    label: '미니멀',
    style: {
      fontSize: 60,
      color: '#ffffff',
      background: { color: 'rgba(0,0,0,0.55)', padding: 16, radius: 14 }
    }
  },
  {
    id: 'highlighter',
    label: '형광펜',
    style: {
      fontSize: 68,
      bold: true,
      color: '#151515',
      highlight: { color: '#ffe14d', padding: 6 }
    }
  },
  {
    id: 'news',
    label: '뉴스 바',
    style: {
      fontSize: 56,
      bold: true,
      color: '#ffffff',
      letterSpacing: 1,
      background: { color: '#c8102e', padding: 12, radius: 4 }
    }
  }
]

/** 프리셋 적용 — 스타일 필드는 전부 프리셋 기준으로 리셋하고, 내용/폰트/정렬/애니메이션은 유지 */
export function applyTextPreset(text: TextContent, preset: TextPreset): TextContent {
  const next: TextContent = { ...text }
  for (const f of STYLE_FIELDS) delete (next as unknown as Record<string, unknown>)[f]
  return { ...next, ...preset.style }
}
