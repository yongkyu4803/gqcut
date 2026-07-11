/**
 * AI 편집 도구 정의 (7.2.1) — 순수 커맨드 레이어를 LLM 커스텀 도구로 노출.
 * 단일 정의를 셋이 공유한다:
 *   - main: Agent SDK 의 tool() 로 등록 (인프로세스 MCP)
 *   - renderer: executor 가 입력 검증(zod)에 사용
 *   - tests: 도구 이름/스키마 단언
 *
 * zod raw shape(객체)로 두어 SDK tool(name, desc, shape, handler) 에 그대로 전달한다.
 * description 은 한국어 + "언제 호출하는지"를 명시(모델 트리거 정확도 향상).
 */
import { z } from 'zod'
import { TRANSITION_TYPES } from './effects-spec'
import { TEXT_PRESETS } from './textPresets'
import { SFX_LIBRARY } from './sfx'

export type AiToolCategory = 'query' | 'cut' | 'text' | 'effect' | 'highlevel'

export interface AiToolSpec {
  name: string
  description: string
  /** zod raw shape — SDK tool() 의 inputSchema 인자로 그대로 사용 */
  shape: z.ZodRawShape
  category: AiToolCategory
  /** 되돌리기 어렵거나 외부 전송/파일 생성 — 실행 전 사용자 확인 게이트 필요 (7.3) */
  destructive?: boolean
  /** 결과로 프리뷰 이미지를 모델에 전송 — 프라이버시 옵트인 (7.3.2) */
  vision?: boolean
}

const FILTER_TYPES = ['brightness', 'contrast', 'saturation', 'temperature'] as const
const TRANSITION_ENUM = TRANSITION_TYPES.map((t) => t.type) as [string, ...string[]]
const PRESET_ENUM = TEXT_PRESETS.map((p) => p.id) as [string, ...string[]]
const TEXT_ANIM_ENUM = [
  'fade',
  'slide',
  'slide-down',
  'slide-left',
  'slide-right',
  'pop',
  'zoom',
  'typewriter'
] as [string, ...string[]]
const LOOP_ANIM_ENUM = ['none', 'shake', 'pulse', 'float'] as [string, ...string[]]
const SFX_ENUM = ['none', ...SFX_LIBRARY.map((s) => s.id)] as [string, ...string[]]

export const AI_TOOLS: AiToolSpec[] = [
  // ── query ──
  {
    name: 'get_project_state',
    description: 'Get project state (tracks, clips with id/kind/time/label, selection, playhead). Call first when unsure of clip ids or after edits.',
    shape: {},
    category: 'query'
  },
  {
    name: 'seek',
    description: 'Move the playhead to a time (sec).',
    shape: { timeSec: z.number().min(0).describe('time in seconds') },
    category: 'query'
  },
  {
    name: 'select_clip',
    description: 'Select a single clip by id.',
    shape: { clipId: z.string().describe('clip id') },
    category: 'query'
  },

  // ── cut ──
  {
    name: 'split_clip',
    description: 'Split a clip into two at a timeline time (sec). Time must be inside the clip.',
    shape: { clipId: z.string().describe('clip id'), atSec: z.number().min(0).describe('split time (sec, absolute timeline)') },
    category: 'cut'
  },
  {
    name: 'trim_clip',
    description: "Trim a clip's start or end edge to a time (sec). Auto-clamped to source/neighbor/min length.",
    shape: {
      clipId: z.string().describe('clip id'),
      edge: z.enum(['start', 'end']).describe('which edge'),
      toSec: z.number().min(0).describe('new edge time (sec)')
    },
    category: 'cut'
  },
  {
    name: 'move_clip',
    description: 'Move a clip to a new start time (sec). Set toTrackId to move to another (same-kind) track. Overlaps auto-resolved.',
    shape: {
      clipId: z.string().describe('clip id'),
      toSec: z.number().min(0).describe('new start (sec)'),
      toTrackId: z.string().optional().describe('target track id (same kind only)')
    },
    category: 'cut'
  },
  {
    name: 'merge_clip',
    description: 'Merge a clip with its adjacent same-source neighbor (inverse of split).',
    shape: { clipId: z.string().describe('clip id') },
    category: 'cut'
  },
  {
    name: 'delete_clip',
    description: 'Delete a clip. Destructive — user is asked to confirm.',
    shape: { clipId: z.string().describe('clip id') },
    category: 'cut',
    destructive: true
  },

  // ── text / subtitle ──
  {
    name: 'add_text',
    description: 'Add a text/subtitle clip on the top text track. Default position is the bottom subtitle line; use position for title/center/top.',
    shape: {
      value: z.string().min(1).describe('text to show'),
      atSec: z.number().min(0).describe('start time (sec)'),
      durationSec: z.number().min(0.1).optional().describe('duration (sec, default 3)'),
      position: z.enum(['bottom', 'center', 'top']).optional().describe('vertical position (default bottom)')
    },
    category: 'text'
  },
  {
    name: 'update_text_style',
    description: "Change a text clip's style: a preset, or individual props (size/color/bold/italic/align/in-animation/loop).",
    shape: {
      clipId: z.string().describe('text clip id'),
      preset: z.enum(PRESET_ENUM).optional().describe('style preset id (replaces style)'),
      fontSize: z.number().min(8).max(400).optional(),
      color: z.string().optional().describe('CSS color, e.g. #ffcc00'),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      align: z.enum(['left', 'center', 'right']).optional(),
      animationIn: z.enum(TEXT_ANIM_ENUM).optional().describe('entrance animation'),
      loop: z.enum(LOOP_ANIM_ENUM).optional().describe("loop animation ('none' clears)")
    },
    category: 'text'
  },

  // ── effect / transform ──
  {
    name: 'apply_filter',
    description: 'Apply a color filter. brightness/temperature: -1..1 (0=neutral); contrast/saturation: 0..2 (1=neutral).',
    shape: {
      clipId: z.string().describe('clip id'),
      type: z.enum(FILTER_TYPES).describe('filter type'),
      value: z.number().describe('value (range per type)')
    },
    category: 'effect'
  },
  {
    name: 'add_transition',
    description:
      'Add a transition to the next adjacent clip on the same track (rejected if not adjacent). Duration auto-clamped to both clips. Optional transition sound.',
    shape: {
      clipId: z.string().describe('front clip id'),
      type: z.enum(TRANSITION_ENUM).describe('transition type'),
      durationSec: z.number().min(0.1).max(5).optional().describe('duration (sec, default 0.5)'),
      sound: z.enum(SFX_ENUM).optional().describe("sound ('none' removes; omit keeps existing)"),
      soundVolume: z.number().min(0).max(1).optional().describe('sound volume (0..1)')
    },
    category: 'effect'
  },
  {
    name: 'set_speed',
    description: 'Set clip playback speed (0.25–4x). Source length kept; timeline length changes and later same-track clips shift. Video/audio only.',
    shape: {
      clipId: z.string().describe('video/audio clip id'),
      speed: z.number().min(0.25).max(4).describe('speed (1=normal, 0.5=slow-mo, 2=2x)')
    },
    category: 'effect'
  },
  {
    name: 'import_subtitles',
    description: 'Parse SRT subtitle text and place it on the subtitle track. Use when the user pastes SRT. Timestamps are absolute timeline time.',
    shape: { srt: z.string().min(1).describe('full SRT text') },
    category: 'text'
  },
  {
    name: 'select_clips',
    description: 'Select multiple clips at once (multi-select). Edit each via per-clip tools.',
    shape: { clipIds: z.array(z.string()).min(1).describe('clip ids') },
    category: 'query'
  },
  {
    name: 'set_theme',
    description: "Switch UI theme: 'dark' or 'light' (beige).",
    shape: { theme: z.enum(['dark', 'light']).describe('theme') },
    category: 'query'
  },
  {
    name: 'set_volume_fade',
    description: "Set a clip's volume (0..1) and fade in/out (sec). Fade applies to both video opacity and audio gain.",
    shape: {
      clipId: z.string().describe('clip id'),
      volume: z.number().min(0).max(1).optional(),
      fadeInSec: z.number().min(0).optional(),
      fadeOutSec: z.number().min(0).optional()
    },
    category: 'effect'
  },
  {
    name: 'set_transform',
    description: "Set a clip's position (x,y px from center), scale, rotation (deg), horizontal flip, opacity (0..1).",
    shape: {
      clipId: z.string().describe('clip id'),
      x: z.number().optional(),
      y: z.number().optional(),
      scale: z.number().min(0.01).optional(),
      rotation: z.number().optional().describe('degrees'),
      flipH: z.boolean().optional().describe('mirror horizontally'),
      opacity: z.number().min(0).max(1).optional()
    },
    category: 'effect'
  },

  // ── high-level ──
  {
    name: 'auto_captions',
    description: "Transcribe a video/audio clip's speech into subtitles (Whisper, local). May take time.",
    shape: {
      clipId: z.string().describe('video/audio clip id'),
      language: z.enum(['korean', 'english', 'auto']).optional().describe('language (default korean)'),
      model: z.enum(['whisper-tiny', 'whisper-base', 'whisper-small']).optional().describe('model size (default whisper-base)')
    },
    category: 'highlevel'
  },
  {
    name: 'remove_silence',
    description:
      'Detect silent ranges and show cut candidates as a preview — deletes nothing. Report the result (count, total sec, coverage) and end the turn; call apply_silence_cut only after the user confirms in a LATER turn. Never detect and apply in the same turn.',
    shape: {
      clipId: z.string().describe('video/audio clip id'),
      noiseDb: z.number().max(0).optional().describe('silence threshold dBFS (default -35); lower to -45 if everything is silent'),
      minDurationSec: z.number().min(0.05).optional().describe('min silence length (sec, default 0.5)'),
      scope: z.enum(['this-track', 'all-tracks']).optional().describe('scope (default this-track; all-tracks only if user asks)')
    },
    category: 'highlevel'
  },
  {
    name: 'apply_silence_cut',
    description:
      'Cut the silent ranges from the current remove_silence preview (destructive, confirmed). Only after the user confirmed a prior detection in an earlier turn. Re-detect if the preview is missing/stale.',
    shape: {},
    category: 'highlevel',
    destructive: true
  },
  {
    name: 'add_overlay',
    description: 'Overlay an existing asset (image/video) by assetId (from the project state assets list). Placed on an overlay video track above the main track.',
    shape: {
      assetId: z.string().describe('asset id'),
      atSec: z.number().min(0).describe('start time (sec)'),
      durationSec: z.number().min(0.1).optional().describe('duration (sec, default full asset)')
    },
    category: 'highlevel'
  },
  {
    name: 'export_video',
    description: 'Export the timeline to an mp4 file. Slow and creates a file — user is asked to confirm.',
    shape: {},
    category: 'highlevel',
    destructive: true
  },
  {
    name: 'capture_preview',
    description: 'Capture the current (or given time) preview frame as an image to inspect the composition. Sends pixels to the model — user opt-in.',
    shape: { atSec: z.number().min(0).optional().describe('time (sec, default playhead)') },
    category: 'highlevel',
    vision: true
  }
]

export const AI_TOOL_BY_NAME: Map<string, AiToolSpec> = new Map(AI_TOOLS.map((t) => [t.name, t]))

/** SDK/executor 공용 도구 이름 목록 (allowedTools 캡 등) */
export const AI_TOOL_NAMES: string[] = AI_TOOLS.map((t) => t.name)
