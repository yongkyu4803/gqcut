/**
 * ffmpeg/ffprobe 바이너리 경로 해석 (0.2.1).
 * ffmpeg-static / ffprobe-static 이 플랫폼별 바이너리를 번들한다.
 * 패키징(asar) 시에는 unpacked 경로로 치환해야 한다 (electron-builder asarUnpack — Phase 6.3).
 */
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { existsSync } from 'node:fs'

function unpacked(p: string): string {
  return p.replace('app.asar', 'app.asar.unpacked')
}

export function ffmpegPath(): string {
  const p = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string)
  if (!p) throw new Error('ffmpeg 바이너리를 찾을 수 없습니다')
  const resolved = unpacked(p)
  if (!existsSync(resolved)) throw new Error(`ffmpeg 바이너리가 존재하지 않습니다: ${resolved}`)
  return resolved
}

export function ffprobePath(): string {
  const p = process.env.FFPROBE_PATH || ffprobeStatic.path
  if (!p) throw new Error('ffprobe 바이너리를 찾을 수 없습니다')
  const resolved = unpacked(p)
  if (!existsSync(resolved)) throw new Error(`ffprobe 바이너리가 존재하지 않습니다: ${resolved}`)
  return resolved
}
