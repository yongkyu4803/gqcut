/**
 * ffprobe 미디어 프로브 (0.2.2, 0.2.4)
 * - 코덱/해상도/fps/duration 추출
 * - VFR 감지: r_frame_rate vs avg_frame_rate 비교
 * - WebCodecs 지원 가능성 판별 (최종 판별은 렌더러의 VideoDecoder.isConfigSupported)
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ffprobePath } from './binaries'
import type { ProbeResult } from '../../shared/ipc-types'

const execFileP = promisify(execFile)

interface FfprobeStream {
  codec_type: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  duration?: string
  nb_frames?: string
  color_space?: string
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: { duration?: string; format_name?: string }
}

function parseRate(rate?: string): number | undefined {
  if (!rate) return undefined
  const [num, den] = rate.split('/').map(Number)
  if (!num || !den) return undefined
  return num / den
}

/** Chromium WebCodecs 가 일반적으로 디코딩 가능한 코덱 (OS 편차는 렌더러에서 최종 확인) */
const LIKELY_SUPPORTED = new Set(['h264', 'vp8', 'vp9', 'av1'])

export async function probeMedia(filePath: string): Promise<ProbeResult> {
  let parsed: FfprobeOutput
  try {
    const { stdout } = await execFileP(ffprobePath(), [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ], { maxBuffer: 16 * 1024 * 1024 })
    parsed = JSON.parse(stdout) as FfprobeOutput
  } catch (e) {
    throw new Error(`미디어를 읽을 수 없습니다: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  }

  const streams = parsed.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')
  if (!video && !audio) throw new Error('비디오/오디오 스트림이 없는 파일입니다')

  const durationSec = Number(parsed.format?.duration ?? video?.duration ?? audio?.duration ?? 0)

  // 정지 이미지 판별 — duration 유무가 아니라 포맷/코덱 기반 (일부 이미지는 1프레임 duration 을 보고해
  // '0.04초짜리 비디오'로 오분류되면 타임라인에서 늘릴 수 없는 클립이 된다)
  const fmtName = parsed.format?.format_name ?? ''
  const stillFormat = /image2|_pipe/.test(fmtName)
  const IMAGE_CODECS = new Set(['png', 'mjpeg', 'bmp', 'webp', 'tiff', 'gif'])
  const codecLower = video?.codec_name?.toLowerCase() ?? ''
  const stillCodec = IMAGE_CODECS.has(codecLower) && !(durationSec > 0.5) // 0.5초 초과면 애니메이션(GIF 등)으로 간주
  if (video && !audio && (stillFormat || stillCodec)) {
    return {
      path: filePath,
      kind: 'image',
      durationSec: 0,
      width: video.width,
      height: video.height,
      fps: undefined,
      vfr: false,
      videoCodec: video.codec_name,
      hasAudio: false,
      likelyWebCodecsSupported: false
    }
  }

  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('유효한 duration 을 읽을 수 없습니다')
  }

  // VFR 감지: 명목 프레임레이트(r)와 평균(avg)이 다르면 VFR (0.2.4)
  const r = parseRate(video?.r_frame_rate)
  const avg = parseRate(video?.avg_frame_rate)
  const vfr = !!(r && avg && Math.abs(r - avg) / r > 0.01)

  // 색공간 판별 (WYSIWYG): Chromium(WebCodecs→GL)은 BT.601 계열 태그를 무시하고 BT.709 로
  // 변환하는 것이 실측으로 확인됨 → BT.709 가 아닌(또는 SD 미태깅) 소스는 프록시에서 709 로 정규화.
  const cs = video?.color_space?.toLowerCase()
  const colorOk = !video || cs === 'bt709' || (!cs && (video.height ?? 0) >= 720)

  const videoCodec = video?.codec_name?.toLowerCase()
  return {
    path: filePath,
    kind: video ? 'video' : 'audio',
    durationSec,
    width: video?.width,
    height: video?.height,
    fps: avg ?? r,
    vfr,
    videoCodec,
    audioCodec: audio?.codec_name,
    hasAudio: !!audio,
    likelyWebCodecsSupported: !!videoCodec && LIKELY_SUPPORTED.has(videoCodec) && !vfr && colorOk
  }
}
