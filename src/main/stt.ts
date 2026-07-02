/**
 * 자동 자막(STT, dev-plan 3.2) — 메인 프로세스.
 *
 * 엔진: @huggingface/transformers(Whisper, ONNX) + onnxruntime-node.
 * whisper.cpp 대신 채택한 이유: 순수 npm 설치로 크로스플랫폼(네이티브 바이너리 배포/빌드 불필요),
 * onnxruntime-node 는 N-API 라 Electron ABI 문제 없이 로드된다(실측 검증). 같은 Whisper 모델·
 * 오프라인·로컬·프라이버시 속성 유지. 속도가 필요하면 이후 whisper.cpp 로 교체 가능.
 *
 * 흐름: 클립 소스 구간을 16kHz mono f32 로 추출(ffmpeg) → Whisper ASR(타임스탬프) →
 *       소스-상대 세그먼트 반환. 모델은 첫 사용 시 userData/stt-cache 로 다운로드·캐시.
 */
import { spawn } from 'node:child_process'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { ffmpegPath } from './ffmpeg/binaries'
import { STT_MODEL_INFO, type SttModel, type SttSegment } from '../shared/subtitles'

export interface SttProgress {
  jobId: string
  phase: 'extract' | 'download' | 'transcribe' | 'done'
  percent: number // 0~100 (transcribe/일부 phase 는 대략값)
}

export interface TranscribeRequest {
  jobId: string
  sourcePath: string
  sourceIn: number
  sourceOut: number
  speed?: number
  model: SttModel
  /** 'auto' 면 자동 감지(언어 미지정) */
  language: string
}

const cancelled = new Set<string>()

/** 모델 파이프라인 캐시 (model+dtype 키) — 재전사 시 재로딩 방지 */
const pipelineCache = new Map<string, Promise<unknown>>()

function sttCacheDir(): string {
  return join(app.getPath('userData'), 'stt-cache')
}

/** 소스 구간을 16kHz mono f32le 로 추출 → Float32Array */
async function extractMonoF32(sourcePath: string, startSec: number, durSec: number, jobId: string): Promise<Float32Array> {
  const dir = await mkdtemp(join(tmpdir(), 'gqcut-stt-'))
  const outPath = join(dir, 'audio.f32')
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(
        ffmpegPath(),
        [
          '-y',
          '-ss', String(Math.max(0, startSec)),
          '-i', sourcePath,
          '-t', String(Math.max(0.05, durSec)),
          '-vn', '-map', '0:a:0',
          '-ac', '1', '-ar', '16000',
          '-f', 'f32le',
          outPath
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      )
      let tail = ''
      child.stderr.on('data', (d: Buffer) => {
        tail = (tail + d.toString()).slice(-2000)
      })
      // 취소 시 추출 프로세스 종료
      const timer = setInterval(() => {
        if (cancelled.has(jobId)) child.kill('SIGKILL')
      }, 200)
      child.on('error', (e) => {
        clearInterval(timer)
        reject(e)
      })
      child.on('close', (code) => {
        clearInterval(timer)
        if (code === 0) resolvePromise()
        else if (/matches no streams|does not contain/i.test(tail)) reject(new Error('이 클립에는 오디오가 없습니다'))
        else reject(new Error(`오디오 추출 실패: ${tail.split('\n').slice(-2).join(' ')}`))
      })
    })
    const buf = await readFile(outPath)
    // Buffer → Float32Array (바이트 정렬 보장을 위해 복사)
    const copy = new Uint8Array(buf.byteLength)
    copy.set(buf)
    return new Float32Array(copy.buffer)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Transformers.js 파이프라인 로드(캐시). progress_callback → 다운로드 진행률 */
async function getPipeline(model: SttModel, onDownload: (percent: number) => void): Promise<unknown> {
  const repo = STT_MODEL_INFO[model].repo
  const key = `${repo}:q8`
  let p = pipelineCache.get(key)
  if (!p) {
    p = (async () => {
      // 동적 import: ESM 전용 패키지를 CJS 메인 번들에서 로드 (externalize 됨)
      const tf = (await import('@huggingface/transformers')) as {
        pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>
        env: { cacheDir: string; allowLocalModels: boolean }
      }
      tf.env.cacheDir = sttCacheDir()
      tf.env.allowLocalModels = true
      const progressByFile = new Map<string, number>()
      return tf.pipeline('automatic-speech-recognition', repo, {
        dtype: 'q8',
        progress_callback: (info: { status?: string; file?: string; progress?: number }) => {
          if (info.status === 'progress' && typeof info.progress === 'number' && info.file) {
            progressByFile.set(info.file, info.progress)
            const vals = [...progressByFile.values()]
            const avg = vals.reduce((a, b) => a + b, 0) / vals.length
            onDownload(Math.min(99, avg))
          }
        }
      })
    })()
    p.catch(() => pipelineCache.delete(key)) // 실패 시 캐시 무효화(재시도 가능)
    pipelineCache.set(key, p)
  }
  return p
}

type AsrFn = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: Array<{ text: string; timestamp: [number, number | null] }> }>

export async function transcribe(req: TranscribeRequest, onProgress: (p: Omit<SttProgress, 'jobId'>) => void): Promise<SttSegment[]> {
  cancelled.delete(req.jobId)
  try {
    onProgress({ phase: 'extract', percent: 0 })
    const audio = await extractMonoF32(req.sourcePath, req.sourceIn, req.sourceOut - req.sourceIn, req.jobId)
    if (cancelled.has(req.jobId)) throw new Error('cancelled')

    onProgress({ phase: 'download', percent: 0 })
    const asr = (await getPipeline(req.model, (percent) => onProgress({ phase: 'download', percent }))) as AsrFn
    if (cancelled.has(req.jobId)) throw new Error('cancelled')

    onProgress({ phase: 'transcribe', percent: 50 })
    const result = await asr(audio, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
      ...(req.language && req.language !== 'auto' ? { language: req.language } : {})
    })
    if (cancelled.has(req.jobId)) throw new Error('cancelled')

    const durSrc = req.sourceOut - req.sourceIn
    const segments: SttSegment[] = (result.chunks ?? [])
      .map((c) => ({
        text: (c.text ?? '').trim(),
        start: c.timestamp[0] ?? 0,
        end: c.timestamp[1] ?? durSrc
      }))
      .filter((s) => s.text.length > 0)
    // 청크가 하나도 없으면 전체 텍스트를 단일 세그먼트로
    if (segments.length === 0 && result.text?.trim()) {
      segments.push({ text: result.text.trim(), start: 0, end: durSrc })
    }
    onProgress({ phase: 'done', percent: 100 })
    return segments
  } finally {
    cancelled.delete(req.jobId)
  }
}

export function cancelTranscribe(jobId: string): void {
  cancelled.add(jobId)
}
