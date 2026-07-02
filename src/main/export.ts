/**
 * 내보내기 파이프 — 메인 프로세스 측 (1.5 스파이크 → 5.2 완성)
 *
 * 흐름:
 *  1) startExport: 잡 생성. audio='mixdown' 이면 임시 f32 파일 스트림 준비, ffmpeg 스폰은 오디오 완료까지 지연
 *  2) writeAudioChunk / audioDone: 렌더러가 OfflineAudioContext 믹스다운(f32le 스테레오)을 스트리밍
 *  3) writeFrame: 렌더러의 RGBA 프레임을 stdin 파이프 (백프레셔: drain 대기 → IPC 응답 지연으로 자연 감속)
 *  4) finishExport: stdin 종료 → 인코딩 완료 대기 → 처리량 통계 반환
 *
 * 색공간 (ARCHITECTURE §6.3): RGB→YUV 매트릭스 BT.709 고정 + 스트림 태깅.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { createWriteStream, type WriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpegPath } from './ffmpeg/binaries'
import type { ExportResult, ExportStartOptions } from '../shared/ipc-types'

interface ExportJob {
  opts: ExportStartOptions
  child: ChildProcessByStdio<Writable, null, Readable> | null
  /** ffmpeg 스폰 완료를 기다리는 배리어 (오디오 믹스다운 수신 후 스폰) */
  ready: Promise<void>
  markReady: () => void
  audioFile: string | null
  audioStream: WriteStream | null
  startedAt: number
  frames: number
  bytes: number
  stderrTail: string
  closed: Promise<number | null> | null
  cancelled: boolean
}

const jobs = new Map<string, ExportJob>()
let jobCounter = 0

function buildArgs(opts: ExportStartOptions, audioFile: string | null): string[] {
  const args: string[] = [
    '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${opts.width}x${opts.height}`,
    '-r', String(opts.fps),
    '-i', 'pipe:0'
  ]
  if (audioFile) args.push('-f', 'f32le', '-ar', String(opts.sampleRate), '-ac', '2', '-i', audioFile)

  // vflip + (선택) 프리셋 스케일 + BT.709 매트릭스 고정
  const scalePart = opts.scaleWidth && opts.scaleHeight ? `${opts.scaleWidth}:${opts.scaleHeight}:flags=bicubic:` : ''
  const vf = [...(opts.vflip ? ['vflip'] : []), `scale=${scalePart}out_color_matrix=bt709:out_range=tv`].join(',')
  args.push('-vf', vf, '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709')

  args.push('-map', '0:v')
  if (audioFile) args.push('-map', '1:a', '-c:a', 'aac', '-b:a', '192k')

  args.push(
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(opts.crf),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-shortest',
    opts.outputPath
  )
  return args
}

function spawnFfmpeg(job: ExportJob): void {
  const child = spawn(ffmpegPath(), buildArgs(job.opts, job.audioFile), { stdio: ['pipe', 'ignore', 'pipe'] })
  child.stderr.on('data', (d: Buffer) => {
    job.stderrTail = (job.stderrTail + d.toString()).slice(-4000)
  })
  child.on('error', () => {
    /* close 에서 처리 */
  })
  job.child = child
  job.closed = new Promise((resolvePromise) => child.on('close', (code) => resolvePromise(code)))
  job.markReady()
}

export function startExport(opts: ExportStartOptions): { jobId: string } {
  const jobId = `export_${++jobCounter}`
  let markReady!: () => void
  const ready = new Promise<void>((resolvePromise) => {
    markReady = resolvePromise
  })
  const job: ExportJob = {
    opts,
    child: null,
    ready,
    markReady,
    audioFile: null,
    audioStream: null,
    startedAt: Date.now(),
    frames: 0,
    bytes: 0,
    stderrTail: '',
    closed: null,
    cancelled: false
  }
  jobs.set(jobId, job)

  if (opts.audio === 'mixdown') {
    job.audioFile = join(tmpdir(), `gqcut_${jobId}.f32`)
    job.audioStream = createWriteStream(job.audioFile)
  } else {
    spawnFfmpeg(job)
  }
  return { jobId }
}

function getJob(jobId: string): ExportJob {
  const job = jobs.get(jobId)
  if (!job || job.cancelled) throw new Error(`알 수 없는 내보내기 잡: ${jobId}`)
  return job
}

async function writeWithDrain(stream: Writable, buf: Buffer): Promise<void> {
  if (stream.write(buf)) return
  await new Promise<void>((resolvePromise, reject) => {
    const onDrain = (): void => {
      cleanup()
      resolvePromise()
    }
    const onErr = (e: Error): void => {
      cleanup()
      reject(e)
    }
    const cleanup = (): void => {
      stream.off('drain', onDrain)
      stream.off('error', onErr)
    }
    stream.once('drain', onDrain)
    stream.once('error', onErr)
  })
}

export async function writeAudioChunk(jobId: string, chunk: ArrayBuffer): Promise<void> {
  const job = getJob(jobId)
  if (!job.audioStream) throw new Error('오디오 스트림이 없는 잡입니다')
  await writeWithDrain(job.audioStream, Buffer.from(chunk))
}

export async function audioDone(jobId: string): Promise<void> {
  const job = getJob(jobId)
  if (!job.audioStream) throw new Error('오디오 스트림이 없는 잡입니다')
  await new Promise<void>((resolvePromise) => job.audioStream!.end(resolvePromise))
  spawnFfmpeg(job)
}

export async function writeFrame(jobId: string, frame: ArrayBuffer): Promise<void> {
  const job = getJob(jobId)
  await job.ready
  if (job.cancelled || !job.child) throw new Error('취소된 잡입니다')
  const buf = Buffer.from(frame)
  job.frames += 1
  job.bytes += buf.length
  await writeWithDrain(job.child.stdin, buf)
}

export async function finishExport(jobId: string): Promise<ExportResult> {
  const job = jobs.get(jobId)
  if (!job) return { ok: false, error: `알 수 없는 잡: ${jobId}` }
  await job.ready
  job.child?.stdin.end()
  const code = job.closed ? await job.closed : null
  jobs.delete(jobId)
  if (job.audioFile) await unlink(job.audioFile).catch(() => {})
  const elapsedMs = Date.now() - job.startedAt
  if (job.cancelled) return { ok: false, error: 'cancelled' }
  if (code !== 0) {
    return { ok: false, error: `ffmpeg exit ${code}: ${job.stderrTail.split('\n').slice(-4).join(' ')}` }
  }
  return {
    ok: true,
    stats: {
      frames: job.frames,
      elapsedMs,
      bytesPiped: job.bytes,
      mbPerSec: job.bytes / 1e6 / Math.max(0.001, elapsedMs / 1000)
    }
  }
}

export async function cancelExport(jobId: string): Promise<void> {
  const job = jobs.get(jobId)
  if (!job) return
  job.cancelled = true
  job.markReady() // ready 대기 중인 writeFrame 해제
  job.audioStream?.destroy()
  job.child?.kill('SIGKILL')
  if (job.closed) await job.closed
  jobs.delete(jobId)
  // 임시파일 정리 (5.2.3): 출력물 + 오디오 믹스다운
  await unlink(job.opts.outputPath).catch(() => {})
  if (job.audioFile) await unlink(job.audioFile).catch(() => {})
}
