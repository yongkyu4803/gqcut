/**
 * 메인 ↔ 렌더러 IPC 계약 (타입 안전 채널).
 * preload 가 이 시그니처대로 contextBridge 에 노출한다.
 */

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
  width: number
  height: number
  fps: number
  /** 오디오 패스스루 세그먼트 (스파이크: 볼륨/페이드 없이 이어붙이기). 갭은 무음 세그먼트로 채운다. */
  audioSegments: Array<{ wavPath?: string; sourceIn?: number; sourceOut?: number; silenceSec?: number }>
  sampleRate: number
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

  openVideoDialog(): Promise<string[]>
  probe(path: string): Promise<ProbeResult>
  /** 호환 프록시(H.264 CFR) 생성 — progress 콜백은 onProxyProgress 이벤트로 */
  makeProxy(path: string, jobId: string): Promise<string>
  onProxyProgress(cb: (p: ProxyProgress) => void): () => void
  /** 오디오 트랙을 wav 로 추출 (재생/파형/믹스다운용, 캐시됨) */
  extractAudio(path: string): Promise<string | null>

  saveProjectDialog(json: string): Promise<string | null>
  openProjectDialog(): Promise<{ path: string; json: string } | null>

  exportStart(opts: ExportStartOptions): Promise<{ jobId: string }>
  exportFrame(jobId: string, frame: ArrayBuffer): Promise<void>
  exportFinish(jobId: string): Promise<ExportResult>
  exportCancel(jobId: string): Promise<void>
  saveFileDialog(defaultName: string): Promise<string | null>

  /** e2e 전용: 파일 경로 직접 임포트 (다이얼로그 우회) */
  fileExists(path: string): Promise<boolean>
}
