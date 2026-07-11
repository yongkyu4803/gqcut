/**
 * 데이터 모델 — 단일 진실 공급원(SSOT).
 * docs/DATA-MODEL.md 의 규격을 그대로 구현한다.
 * 프리뷰/내보내기/저장이 모두 이 모델을 참조한다.
 */

export const SCHEMA_VERSION = 1

export type MediaKind = 'video' | 'audio' | 'image'
export type TrackKind = 'video' | 'audio' | 'text'
export type ClipKind = 'video' | 'audio' | 'image' | 'text'

export interface Project {
  schemaVersion: number
  id: string
  name: string
  settings: ProjectSettings
  assets: MediaAsset[]
  tracks: Track[] // 위→아래 = 합성 시 위 레이어가 앞
  createdAt: string
  updatedAt: string
}

export interface ProjectSettings {
  width: number
  height: number
  fps: number
  sampleRate: number
  backgroundColor: string
  masterVolume: number // 0~1
}

export interface MediaAsset {
  id: string
  kind: MediaKind
  path: string
  duration: number // 초
  width?: number
  height?: number
  fps?: number
  vfr?: boolean // 가변 프레임레이트 여부 (프로브에서 감지)
  codec?: string
  hasAudio?: boolean
  hdr?: boolean // HDR(PQ/HLG) 소스 여부 — 프록시 생성 시 SDR 톤매핑 적용됨 (프로브에서 감지)
  proxyPath?: string // 호환 프록시(H.264 CFR, 원본 해상도) — 프리뷰·내보내기 공용 (0.4)
  perfProxyPath?: string // 성능 프록시(저해상도) — 프리뷰 전용, 내보내기는 원본 (6.2)
  audioWavPath?: string // 추출된 오디오 wav (재생/파형/믹스다운용)
  status: 'ok' | 'missing'
}

export interface Track {
  id: string
  kind: TrackKind
  clips: Clip[] // timelineStart 기준 정렬
  volume?: number // 트랙 게인 0~1 (기본 1.0)
  muted?: boolean
  hidden?: boolean
  locked?: boolean
}

export interface Clip {
  id: string
  assetId?: string // text 클립은 없음
  kind: ClipKind

  timelineStart: number // 초 (프로젝트 시간축)
  timelineEnd: number

  sourceIn?: number // 초 (소스 시간축) — video/audio
  sourceOut?: number
  speed?: number // 기본 1.0

  transform?: Transform
  opacity?: number // 0~1

  effects?: Effect[]
  transitionIn?: Transition // 파생 정보 — 원본은 앞 클립의 transitionOut (§1.1)
  transitionOut?: Transition

  volume?: number // 0~1
  fadeIn?: number // 초 — 시각(불투명도)과 오디오(게인)에 함께 적용 (effects-spec fadeOpacityMul)
  fadeOut?: number

  text?: TextContent
}

export interface Transform {
  x: number // 캔버스 중심 기준 오프셋 (px)
  y: number
  scale: number
  rotation: number // degree
  flipH?: boolean // 좌우 반전 (기본 false)
}

export interface Effect {
  type: 'brightness' | 'contrast' | 'saturation' | 'temperature' | 'blur' | (string & {})
  params: Record<string, number>
  enabled: boolean
}

export interface Transition {
  type: 'dissolve' | 'wipe' | 'slide' | 'fade' | (string & {})
  duration: number // 초 — 시간 의미론은 DATA-MODEL.md §1.1 (소스 핸들 규칙)
  params?: Record<string, number>
  /** 전환 효과음 (phase-9) — id 는 shared/sfx.ts SFX_LIBRARY 참조. params 가 number-only 라 별도 필드. 옵셔널이라 구버전 하위호환. */
  sound?: { id: string; volume?: number }
}

export interface TextContent {
  value: string
  fontFamily: string
  fontSize: number
  color: string
  align: 'left' | 'center' | 'right'
  bold?: boolean
  italic?: boolean
  letterSpacing?: number // px (기본 0)
  lineHeight?: number // 배수 (기본 1.25)
  /** 글자색 그라디언트 — 지정 시 color 대신 사용 */
  gradient?: { from: string; to: string; horizontal?: boolean }
  /** 네온 글로우 — strength 는 블러 반경(px) */
  glow?: { color: string; strength: number }
  stroke?: { color: string; width: number }
  shadow?: { color: string; blur: number; x: number; y: number }
  background?: { color: string; padding: number; radius?: number }
  /** 형광펜 하이라이트 — 줄 단위 박스 (배경 박스와 별개) */
  highlight?: { color: string; padding?: number }
  animationIn?: TextAnimation
  animationOut?: TextAnimation
  /** 지속 루프 애니메이션 (shake/pulse/float) — duration 은 주기(초) */
  loop?: TextAnimation
}

export interface TextAnimation {
  type:
    | 'fade'
    | 'slide' // 아래에서 등장
    | 'slide-down' // 위에서 등장
    | 'slide-left' // 왼쪽에서 등장
    | 'slide-right' // 오른쪽에서 등장
    | 'pop'
    | 'zoom'
    | 'typewriter'
    | 'shake' // 루프 전용
    | 'pulse'
    | 'float'
    | (string & {})
  duration: number // 초 (루프면 주기)
  params?: Record<string, number>
}
