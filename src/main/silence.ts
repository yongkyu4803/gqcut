/**
 * 무음 감지 — 메인 프로세스.
 * ffmpeg silencedetect 오디오 필터로 클립 소스 구간의 무음 구간을 찾는다.
 * STT(main/stt.ts)와 달리 모델 로딩이 없어 ffmpeg 단일 패스로 끝난다 — phase 는 analyze→done 뿐.
 */
import { spawn } from 'node:child_process'
import { ffmpegPath } from './ffmpeg/binaries'
import type { SilenceInterval } from '../shared/silence'

export interface SilenceDetectRequest {
  jobId: string
  sourcePath: string
  sourceIn: number
  sourceOut: number
  noiseDb: number
  minDurationSec: number
}

export interface SilenceProgress {
  jobId: string
  phase: 'analyze' | 'done'
  percent: number
}

const cancelled = new Set<string>()

const SILENCE_START_RE = /silence_start:\s*(-?[\d.]+)/
const SILENCE_END_RE = /silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/

export async function detectSilence(
  req: SilenceDetectRequest,
  onProgress: (p: Omit<SilenceProgress, 'jobId'>) => void
): Promise<SilenceInterval[]> {
  cancelled.delete(req.jobId)
  onProgress({ phase: 'analyze', percent: 0 })

  const durSec = Math.max(0.05, req.sourceOut - req.sourceIn)
  const args = [
    '-ss', String(Math.max(0, req.sourceIn)),
    '-i', req.sourcePath,
    '-t', String(durSec),
    '-af', `silencedetect=noise=${req.noiseDb}dB:d=${req.minDurationSec}`,
    '-f', 'null', '-'
  ]

  const intervals: SilenceInterval[] = []
  let pendingStart: number | null = null
  let lineBuf = ''

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderrTail = ''

    const timer = setInterval(() => {
      if (cancelled.has(req.jobId)) child.kill('SIGKILL')
    }, 200)

    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      stderrTail = (stderrTail + text).slice(-2000)
      lineBuf += text
      const lines = lineBuf.split('\n')
      lineBuf = lines.pop() ?? '' // 불완전한 마지막 줄은 다음 청크로 이월

      for (const line of lines) {
        const startMatch = SILENCE_START_RE.exec(line)
        if (startMatch) {
          pendingStart = Number(startMatch[1])
          continue
        }
        const endMatch = SILENCE_END_RE.exec(line)
        if (endMatch && pendingStart !== null) {
          intervals.push({ start: pendingStart, end: Number(endMatch[1]) })
          pendingStart = null
        }
      }
    })

    child.on('error', (e) => {
      clearInterval(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearInterval(timer)
      if (cancelled.has(req.jobId)) {
        reject(new Error('cancelled'))
        return
      }
      if (code !== 0) {
        reject(new Error(`무음 감지 실패 (ffmpeg exit ${code}): ${stderrTail.split('\n').slice(-3).join(' ')}`))
        return
      }
      // 클립 끝까지 무음이 이어지면 silence_end 로그가 안 나온다 — 구간 끝으로 마감 처리
      if (pendingStart !== null) intervals.push({ start: pendingStart, end: durSec })
      resolvePromise()
    })
  })

  onProgress({ phase: 'done', percent: 100 })
  return intervals
}

export function cancelSilenceDetect(jobId: string): void {
  cancelled.add(jobId)
}
