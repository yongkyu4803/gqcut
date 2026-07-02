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
}

export interface TextContent {
  value: string
  fontFamily: string
  fontSize: number
  color: string
  align: 'left' | 'center' | 'right'
  bold?: boolean
  italic?: boolean
  stroke?: { color: string; width: number }
  shadow?: { color: string; blur: number; x: number; y: number }
  background?: { color: string; padding: number }
  animationIn?: TextAnimation
  animationOut?: TextAnimation
}

export interface TextAnimation {
  type: 'fade' | 'slide' | 'pop' | (string & {})
  duration: number // 초
  params?: Record<string, number>
}
