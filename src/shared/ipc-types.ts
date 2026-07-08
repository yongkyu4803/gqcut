/**
 * 메인 ↔ 렌더러 IPC 계약 (타입 안전 채널).
 * preload 가 이 시그니처대로 contextBridge 에 노출한다.
 */
import type { SttSegment } from './subtitles'
import type { SilenceInterval } from './silence'

export interface SttTranscribeOptions {
  jobId: string
  sourcePath: string
  sourceIn: number
  sourceOut: number
  speed?: number
  /** 'whisper-tiny' | 'whisper-base' | 'whisper-small' */
  model: string
  /** 'auto' | 'korean' | ... */
  language: string
}

export interface SttProgressEvent {
  jobId: string
  phase: 'extract' | 'download' | 'transcribe' | 'done'
  percent: number
}

export interface SttResult {
  ok: boolean
  segments?: SttSegment[]
  error?: string
}

export interface SilenceDetectOptions {
  jobId: string
  sourcePath: string
  sourceIn: number
  sourceOut: number
  /** dBFS 임계치 (예: -35) — 이보다 조용하면 무음으로 판정 */
  noiseDb: number
  /** 이 길이(초) 이상 지속돼야 무음 구간으로 인정 */
  minDurationSec: number
}

export interface SilenceProgressEvent {
  jobId: string
  phase: 'analyze' | 'done'
  percent: number
}

export interface SilenceResult {
  ok: boolean
  intervals?: SilenceInterval[]
  error?: string
}

export interface ProbeResult {
  path: string
  kind: 'video' | 'audio' | 'image'
  durationSec: number
  width?: number
  height?: number
  fps?: number
  vfr: boolean
  videoCodec?: string
  audioCodec?: string
  hasAudio: boolean
  /** WebCodecs 로 디코딩 시도해볼 수 있는 코덱인지 (렌더러에서 최종 확인) */
  likelyWebCodecsSupported: boolean
}

export interface ProxyProgress {
  jobId: string
  percent: number // 0~100
  done: boolean
  error?: string
  proxyPath?: string
}

export interface ExportStartOptions {
  outputPath: string
  /** 렌더(파이프 입력) 해상도 = 프로젝트 해상도 */
  width: number
  height: number
  fps: number
  sampleRate: number
  /** 인코딩 품질 (libx264 CRF, 5.2.4 프리셋) */
  crf: number
  /** 출력 해상도 프리셋 — 지정 시 인코딩 단계에서 스케일 (렌더는 프로젝트 해상도 유지) */
  scaleWidth?: number
  scaleHeight?: number
  /** 오디오: 'mixdown' 이면 export:audioChunk 스트림(f32le 스테레오)을 받은 뒤 인코딩 시작 */
  audio: 'mixdown' | 'none'
  /** WebGL readPixels 는 bottom-up — true 면 ffmpeg 에서 vflip */
  vflip?: boolean
}

export interface ExportResult {
  ok: boolean
  error?: string
  /** 처리량 측정 (1.5.3) */
  stats?: { frames: number; elapsedMs: number; bytesPiped: number; mbPerSec: number }
}

// ── AI 편집 어시스턴트 (phase-7) ──

export interface AiAuthStatus {
  loggedIn: boolean
  /** 'subscription' | 'api-key' | 'none' — UI 배지용 */
  method: string
  detail?: string
}

export interface AiSendOptions {
  requestId: string
  /** 사용자 지시문 */
  prompt: string
  /** summarizeProject() 결과 JSON — 모델이 참조할 현재 프로젝트 상태 */
  contextJson: string
  /** 최근 대화(팔로업 맥락용, 텍스트만) */
  history?: Array<{ role: 'user' | 'assistant'; text: string }>
}

/** main → renderer 스트리밍 이벤트 */
export type AiStreamEvent =
  | { type: 'assistant'; text: string }
  | { type: 'done'; ok: boolean; error?: string; usage?: { inputTokens: number; outputTokens: number }; costUsd?: number }

/** main → renderer 도구 실행 요청 (렌더러 executor 가 dispatch 후 aiToolReply 로 응답) */
export interface AiToolCallEvent {
  requestId: string
  callId: string
  name: string
  input: Record<string, unknown>
}

/** renderer → main 도구 실행 결과 */
export interface AiToolReply {
  ok: boolean
  /** 모델이 읽는 결과/에러 메시지 (한국어) */
  message: string
  /** 비전 도구: 프리뷰 PNG dataURL — 있으면 모델에 이미지 블록으로 전달 */
  imageDataUrl?: string
}

export interface EditorApi {
  ping(): Promise<string>
  platform: string
  /** e2e 테스트 환경 여부 (E2E=1) — 테스트 훅 주입/복구 프롬프트 분기 */
  isE2E: boolean

  /** OS 설치 폰트 family 목록 (자막 폰트 선택용, 3.1) */
  listFonts(): Promise<string[]>

  openVideoDialog(): Promise<string[]>
  probe(path: string): Promise<ProbeResult>
  /** 호환 프록시(H.264 CFR) 생성 — progress 콜백은 onProxyProgress 이벤트로 */
  makeProxy(path: string, jobId: string): Promise<string>
  /** 성능 프록시(720p, 프리뷰 전용) 생성 */
  makePerfProxy(path: string, jobId: string): Promise<string>
  onProxyProgress(cb: (p: ProxyProgress) => void): () => void
  /** 오디오 트랙을 wav 로 추출 (재생/파형/믹스다운용, 캐시됨) */
  extractAudio(path: string): Promise<string | null>

  saveProjectDialog(json: string): Promise<string | null>
  saveProject(path: string, json: string): Promise<void>
  openProjectDialog(): Promise<{ path: string; json: string } | null>
  autosave(json: string, originalPath: string | null): Promise<void>
  checkAutosave(): Promise<{ json: string; savedAt: string; originalPath: string | null } | null>
  clearAutosave(): Promise<void>

  exportStart(opts: ExportStartOptions): Promise<{ jobId: string }>
  /** 오디오 믹스다운(f32le interleaved stereo) 청크 스트림 — audioDone 후 프레임 전송 시작 */
  exportAudioChunk(jobId: string, chunk: ArrayBuffer): Promise<void>
  exportAudioDone(jobId: string): Promise<void>
  exportFrame(jobId: string, frame: ArrayBuffer): Promise<void>
  exportFinish(jobId: string): Promise<ExportResult>
  exportCancel(jobId: string): Promise<void>
  saveFileDialog(defaultName: string): Promise<string | null>

  /** 자동 자막(STT, 3.2): 클립 소스 구간 전사 → 세그먼트. 진행률은 onSttProgress */
  sttTranscribe(opts: SttTranscribeOptions): Promise<SttResult>
  sttCancel(jobId: string): Promise<void>
  onSttProgress(cb: (p: SttProgressEvent) => void): () => void
  /** SRT 파일 저장 다이얼로그 */
  saveSrtDialog(defaultName: string, content: string): Promise<string | null>

  /** 무음 감지: 클립 소스 구간에서 ffmpeg silencedetect 실행 → 무음 구간 목록. 진행률은 onSilenceProgress */
  silenceDetect(opts: SilenceDetectOptions): Promise<SilenceResult>
  silenceCancel(jobId: string): Promise<void>
  onSilenceProgress(cb: (p: SilenceProgressEvent) => void): () => void

  /** e2e 전용: 파일 경로 직접 임포트 (다이얼로그 우회) */
  fileExists(path: string): Promise<boolean>

  // ── AI 편집 어시스턴트 (phase-7) ──
  /** Claude Code 구독/API 키 로그인 상태 (배지·안내용) */
  aiCheckAuth(): Promise<AiAuthStatus>
  /** 지시문 전송 → Agent SDK 실행 시작. 결과/스트림은 onAiEvent, 도구 실행은 onAiToolCall. Promise 는 완료(done) 시 resolve. */
  aiSend(opts: AiSendOptions): Promise<void>
  /** 진행 중인 실행 중단 */
  aiCancel(requestId: string): Promise<void>
  /** 스트리밍 답변/완료 이벤트 구독 */
  onAiEvent(cb: (requestId: string, ev: AiStreamEvent) => void): () => void
  /** 도구 실행 요청 구독 (렌더러가 executor 로 실행 후 aiToolReply) */
  onAiToolCall(cb: (ev: AiToolCallEvent) => void): () => void
  /** 도구 실행 결과를 main 으로 반환 (모델로 중계됨) */
  aiToolReply(callId: string, reply: AiToolReply): Promise<void>
}
