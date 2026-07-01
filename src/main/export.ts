/**
 * 내보내기 파이프 — 메인 프로세스 측 (1.5 스파이크)
 * 렌더러가 프레임(RGBA)을 IPC 로 보내면 FFmpeg stdin 으로 파이프해 인코딩한다.
 * - 백프레셔: stdin.write() 가 false 면 drain 까지 대기 → IPC invoke 응답 지연으로 렌더러가 자연히 감속
 * - 오디오: wav 세그먼트 atrim + concat 패스스루 (1.5.4 — 믹스다운은 Phase 5)
 * - 처리량 측정 (1.5.3): 프레임 수/바이트/MB/s 를 결과로 반환
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { unlink } from 'node:fs/promises'
import { ffmpegPath } from './ffmpeg/binaries'
import type { ExportResult, ExportStartOptions } from '../shared/ipc-types'

interface ExportJob {
  child: ChildProcessByStdio<Writable, null, Readable>
  opts: ExportStartOptions
  startedAt: number
  frames: number
  bytes: number
  stderrTail: string
  closed: Promise<number | null>
  cancelled: boolean
}

const jobs = new Map<string, ExportJob>()
let jobCounter = 0

export function startExport(opts: ExportStartOptions): { jobId: string } {
  const jobId = `export_${++jobCounter}`

  const args: string[] = [
    '-y',
    // 비디오: 렌더러가 파이프로 보내는 raw RGBA 프레임
    '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${opts.width}x${opts.height}`,
    '-r', String(opts.fps),
    '-i', 'pipe:0'
  ]

  // 오디오 세그먼트 입력 + concat 필터그래프 (wav 구간 or 무음)
  const segs = opts.audioSegments
  const fmt = `aformat=sample_fmts=fltp:sample_rates=${opts.sampleRate}:channel_layouts=stereo`
  const wavSegs = segs.filter((s) => s.wavPath)
  for (const seg of wavSegs) args.push('-i', seg.wavPath!)
  const filters: string[] = []
  if (segs.length > 0) {
    let wavInput = 0
    segs.forEach((seg, i) => {
      if (seg.wavPath) {
        wavInput += 1
        filters.push(`[${wavInput}:a]atrim=start=${seg.sourceIn}:end=${seg.sourceOut},asetpts=PTS-STARTPTS,${fmt}[a${i}]`)
      } else {
        filters.push(`aevalsrc=0|0:s=${opts.sampleRate}:d=${Math.max(0.001, seg.silenceSec ?? 0)},${fmt}[a${i}]`)
      }
    })
    filters.push(`${segs.map((_, i) => `[a${i}]`).join('')}concat=n=${segs.length}:v=0:a=1[aout]`)
    args.push('-filter_complex', filters.join(';'))
  }

  // 색공간 규칙 (1.3.4 / WYSIWYG): RGB→YUV 매트릭스를 BT.709 로 고정하고 스트림에 태깅.
  // 미지정 시 swscale 기본값(해상도 의존)과 플레이어 추정이 어긋나 G 채널이 틀어진다.
  const vf = [...(opts.vflip ? ['vflip'] : []), 'scale=out_color_matrix=bt709:out_range=tv'].join(',')
  args.push('-vf', vf, '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709')
  args.push('-map', '0:v')
  if (segs.length > 0) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ar', String(opts.sampleRate))

  args.push(
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    opts.outputPath
  )

  const child = spawn(ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'] })
  const job: ExportJob = {
    child,
    opts,
    startedAt: Date.now(),
    frames: 0,
    bytes: 0,
    stderrTail: '',
    cancelled: false,
    closed: new Promise((resolvePromise) => child.on('close', (code) => resolvePromise(code)))
  }
  child.stderr.on('data', (d: Buffer) => {
    job.stderrTail = (job.stderrTail + d.toString()).slice(-4000)
  })
  child.on('error', () => {
    /* close 에서 처리 */
  })
  jobs.set(jobId, job)
  return { jobId }
}

export async function writeFrame(jobId: string, frame: ArrayBuffer): Promise<void> {
  const job = jobs.get(jobId)
  if (!job || job.cancelled) throw new Error(`알 수 없는 내보내기 잡: ${jobId}`)
  const buf = Buffer.from(frame)
  job.frames += 1
  job.bytes += buf.length
  const ok = job.child.stdin.write(buf)
  if (!ok) {
    await new Promise<void>((resolvePromise, reject) => {
      const onDrain = () => {
        cleanup()
        resolvePromise()
      }
      const onErr = (e: Error) => {
        cleanup()
        reject(e)
      }
      const cleanup = () => {
        job.child.stdin.off('drain', onDrain)
        job.child.stdin.off('error', onErr)
      }
      job.child.stdin.once('drain', onDrain)
      job.child.stdin.once('error', onErr)
    })
  }
}

export async function finishExport(jobId: string): Promise<ExportResult> {
  const job = jobs.get(jobId)
  if (!job) return { ok: false, error: `알 수 없는 잡: ${jobId}` }
  job.child.stdin.end()
  const code = await job.closed
  jobs.delete(jobId)
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
  job.child.kill('SIGKILL')
  await job.closed
  jobs.delete(jobId)
  // 임시파일 정리 (5.2.3 취소 시 출력물 삭제)
  await unlink(job.opts.outputPath).catch(() => {})
}
