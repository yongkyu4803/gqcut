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

export const AI_TOOLS: AiToolSpec[] = [
  // ── 조회 ──
  {
    name: 'get_project_state',
    description:
      '현재 프로젝트 상태(트랙·클립 id/시간/라벨, 선택 클립, 플레이헤드)를 조회한다. 클립 id 가 확실치 않거나 편집 후 최신 상태가 필요할 때 먼저 호출한다.',
    shape: {},
    category: 'query'
  },
  {
    name: 'seek',
    description: '플레이헤드(재생 위치)를 지정한 시각(초)으로 옮긴다. 특정 지점을 보여주거나 그 지점 기준으로 작업할 때.',
    shape: { timeSec: z.number().min(0).describe('이동할 시각(초)') },
    category: 'query'
  },
  {
    name: 'select_clip',
    description: '클립을 선택 상태로 만든다. 이후 사용자가 인스펙터에서 볼 대상을 지정할 때.',
    shape: { clipId: z.string().describe('선택할 클립 id') },
    category: 'query'
  },

  // ── 컷 ──
  {
    name: 'split_clip',
    description: '클립을 지정 시각(초)에서 둘로 나눈다. "N초에서 잘라줘/나눠줘". 시각은 클립의 시작~끝 사이여야 한다.',
    shape: { clipId: z.string().describe('나눌 클립 id'), atSec: z.number().min(0).describe('분할 시각(초, 타임라인 절대 좌표)') },
    category: 'cut'
  },
  {
    name: 'trim_clip',
    description: '클립의 시작 또는 끝 경계를 지정 시각으로 트림한다. 소스 범위/이웃/최소 길이로 자동 클램프된다.',
    shape: {
      clipId: z.string().describe('트림할 클립 id'),
      edge: z.enum(['start', 'end']).describe("'start'=시작 경계, 'end'=끝 경계"),
      toSec: z.number().min(0).describe('경계를 옮길 시각(초)')
    },
    category: 'cut'
  },
  {
    name: 'move_clip',
    description: '클립을 타임라인에서 다른 시각(초)으로 옮긴다. 다른 트랙으로 옮기려면 toTrackId 를 지정. 겹침은 자동 회피된다.',
    shape: {
      clipId: z.string().describe('이동할 클립 id'),
      toSec: z.number().min(0).describe('새 시작 시각(초)'),
      toTrackId: z.string().optional().describe('다른 트랙으로 옮길 때 대상 트랙 id (같은 종류만 허용)')
    },
    category: 'cut'
  },
  {
    name: 'merge_clip',
    description: '선택 클립을 인접한(같은 소스에서 맞닿은) 이웃과 하나로 합친다(분할의 역연산).',
    shape: { clipId: z.string().describe('병합할 클립 id') },
    category: 'cut'
  },
  {
    name: 'delete_clip',
    description: '클립을 타임라인에서 삭제한다. 되돌리기 어려운 파괴적 작업이므로 실행 전 사용자 확인을 거친다.',
    shape: { clipId: z.string().describe('삭제할 클립 id') },
    category: 'cut',
    destructive: true
  },

  // ── 텍스트/자막 ──
  {
    name: 'add_text',
    description:
      '텍스트(자막) 클립을 추가한다. "N초에 ~라는 자막 넣어줘". 최상단 텍스트 트랙에 배치되며, 기본 위치는 화면 하단 자막 기준선이다. 제목처럼 다른 위치가 필요하면 position 을 지정한다.',
    shape: {
      value: z.string().min(1).describe('표시할 문구'),
      atSec: z.number().min(0).describe('나타날 시각(초)'),
      durationSec: z.number().min(0.1).optional().describe('표시 길이(초, 기본 3)'),
      position: z.enum(['bottom', 'center', 'top']).optional().describe('세로 위치(기본 bottom=화면 하단 자막선)')
    },
    category: 'text'
  },
  {
    name: 'update_text_style',
    description:
      '텍스트 클립의 스타일을 바꾼다. preset(기본/예능/네온/미니멀/형광펜/뉴스 바) 한 번에, 또는 개별 속성(크기/색/굵기/정렬/등장 애니메이션/루프)으로.',
    shape: {
      clipId: z.string().describe('대상 텍스트 클립 id'),
      preset: z.enum(PRESET_ENUM).optional().describe('스타일 프리셋 id (지정 시 스타일 일괄 교체)'),
      fontSize: z.number().min(8).max(400).optional(),
      color: z.string().optional().describe('CSS 색 (예: #ffcc00)'),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      align: z.enum(['left', 'center', 'right']).optional(),
      animationIn: z.enum(TEXT_ANIM_ENUM).optional().describe('등장 애니메이션'),
      loop: z.enum(LOOP_ANIM_ENUM).optional().describe("지속 루프 애니메이션 ('none'=해제)")
    },
    category: 'text'
  },

  // ── 효과/변형 ──
  {
    name: 'apply_filter',
    description:
      '클립에 색보정 필터를 적용한다. brightness/temperature 는 -1~1(0=중립), contrast/saturation 은 0~2(1=중립).',
    shape: {
      clipId: z.string().describe('대상 클립 id'),
      type: z.enum(FILTER_TYPES).describe('필터 종류'),
      value: z.number().describe('값 (종류별 범위)')
    },
    category: 'effect'
  },
  {
    name: 'add_transition',
    description: '클립 끝에 다음 클립으로의 화면 전환을 건다. 같은 트랙의 바로 뒤 클립과 맞닿아 있어야 한다.',
    shape: {
      clipId: z.string().describe('전환을 걸 앞 클립 id'),
      type: z.enum(TRANSITION_ENUM).describe('전환 종류'),
      durationSec: z.number().min(0.1).max(5).optional().describe('전환 길이(초, 기본 0.5)')
    },
    category: 'effect'
  },
  {
    name: 'set_volume_fade',
    description: '클립의 볼륨(0~1)과 페이드 인/아웃(초)을 설정한다. 페이드는 영상 불투명도와 오디오 게인에 함께 적용된다.',
    shape: {
      clipId: z.string().describe('대상 클립 id'),
      volume: z.number().min(0).max(1).optional(),
      fadeInSec: z.number().min(0).optional(),
      fadeOutSec: z.number().min(0).optional()
    },
    category: 'effect'
  },
  {
    name: 'set_transform',
    description: '클립의 위치(x,y px, 화면 중심 기준)·크기(scale)·회전(도)·불투명도(0~1)를 설정한다.',
    shape: {
      clipId: z.string().describe('대상 클립 id'),
      x: z.number().optional(),
      y: z.number().optional(),
      scale: z.number().min(0.01).optional(),
      rotation: z.number().optional().describe('회전 각도(도)'),
      opacity: z.number().min(0).max(1).optional()
    },
    category: 'effect'
  },

  // ── 고수준 (7.3) ──
  {
    name: 'auto_captions',
    description: '선택/지정한 비디오·오디오 클립의 말소리를 인식해 자막을 자동 생성한다(Whisper, 로컬). 시간이 걸릴 수 있다.',
    shape: {
      clipId: z.string().describe('전사할 비디오/오디오 클립 id'),
      language: z.enum(['korean', 'english', 'auto']).optional().describe('언어(기본 korean)'),
      model: z.enum(['whisper-tiny', 'whisper-base', 'whisper-small']).optional().describe('모델 크기(기본 whisper-base)')
    },
    category: 'highlevel'
  },
  {
    name: 'remove_silence',
    description:
      '무음 구간을 감지해 타임라인에 컷 후보를 표시한다(미리보기 전용 — 이 도구는 아무것도 삭제하지 않는다). "무음 잘라줘". 감지 결과(구간 수·총 초·클립 대비 커버리지)를 사용자에게 보고하고 이번 응답을 마친 뒤, 사용자가 타임라인에서 확인하고 적용을 지시하면 그때 apply_silence_cut 을 호출한다. 감지와 적용을 같은 응답에서 연달아 하지 말 것.',
    shape: {
      clipId: z.string().describe('분석할 비디오/오디오 클립 id'),
      noiseDb: z.number().max(0).optional().describe('무음 임계(dBFS, 기본 -35). 전체가 무음으로 잡히면 -45 등으로 낮춰 재시도'),
      minDurationSec: z.number().min(0.05).optional().describe('무음 최소 길이(초, 기본 0.5)'),
      scope: z.enum(['this-track', 'all-tracks']).optional().describe('적용 범위(기본 this-track). all-tracks 는 사용자가 명시 요청할 때만')
    },
    category: 'highlevel'
  },
  {
    name: 'apply_silence_cut',
    description:
      'remove_silence 로 만든 현재 미리보기의 무음 구간을 실제로 잘라낸다(되돌리기 어려운 파괴적 작업, 확인 게이트). 반드시 remove_silence 로 감지해 사용자가 확인한 다음 응답에서만 호출한다. 미리보기가 없거나 편집으로 무효화됐으면 다시 감지해야 한다.',
    shape: {},
    category: 'highlevel',
    destructive: true
  },
  {
    name: 'add_overlay',
    description:
      '기존 자산(이미지/영상)을 오버레이로 얹는다. assetId 는 프로젝트 상태의 assets 목록에서 고른다. 메인 영상 위 오버레이 트랙(없으면 새로 생성)에 배치된다.',
    shape: {
      assetId: z.string().describe('오버레이로 얹을 자산 id'),
      atSec: z.number().min(0).describe('나타날 시각(초)'),
      durationSec: z.number().min(0.1).optional().describe('표시 길이(초, 기본 자산 전체)')
    },
    category: 'highlevel'
  },
  {
    name: 'export_video',
    description: '타임라인을 mp4 파일로 내보낸다. 오래 걸리고 파일을 생성하므로 반드시 사용자 확인을 거친다.',
    shape: {},
    category: 'highlevel',
    destructive: true
  },
  {
    name: 'capture_preview',
    description:
      '현재(또는 지정 시각) 프리뷰 화면을 캡처해 이미지로 받아 화면 구성을 눈으로 보고 판단한다. 화면 픽셀을 모델에 전송하므로 사용자 옵트인이 필요하다. "이 장면 어때?".',
    shape: { atSec: z.number().min(0).optional().describe('캡처할 시각(초, 기본 현재 플레이헤드)') },
    category: 'highlevel',
    vision: true
  }
]

export const AI_TOOL_BY_NAME: Map<string, AiToolSpec> = new Map(AI_TOOLS.map((t) => [t.name, t]))

/** SDK/executor 공용 도구 이름 목록 (allowedTools 캡 등) */
export const AI_TOOL_NAMES: string[] = AI_TOOLS.map((t) => t.name)
