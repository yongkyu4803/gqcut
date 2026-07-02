/**
 * 메인 ↔ 렌더러 IPC 계약 (타입 안전 채널).
 * preload 가 이 시그니처대로 contextBridge 에 노출한다.
 */
import type { SttSegment } from './subtitles'

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

export interface EditorApi {
  ping(): Promise<string>
  platform: string
  /** e2e 테스트 환경 여부 (E2E=1) — 테스트 훅 주입/복구 프롬프트 분기 */
  isE2E: boolean

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

  /** e2e 전용: 파일 경로 직접 임포트 (다이얼로그 우회) */
  fileExists(path: string): Promise<boolean>
}
