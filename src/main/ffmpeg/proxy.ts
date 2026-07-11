/**
 * 코덱 호환성 fallback — 호환 프록시 생성 (0.4)
 * WebCodecs 미지원 코덱·VFR 소스를 H.264 CFR 로 트랜스코딩해 편집 가능하게 한다.
 * - GOP 30 (1초 간격 키프레임) → 시크 성능 확보
 * - 캐시: 소스 경로+mtime 해시로 재생성 방지 (0.4.3)
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { app } from 'electron'
import { existsSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ffmpegPath } from './binaries'

export function cacheDir(sub: string): string {
  const dir = join(app.getPath('userData'), 'cache', sub)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function cacheKey(sourcePath: string): string {
  const mtime = statSync(sourcePath).mtimeMs
  return createHash('sha1').update(`${sourcePath}:${mtime}`).digest('hex').slice(0, 16)
}

export interface ProxyJob {
  cancel(): void
  promise: Promise<string>
}

/**
 * HDR(PQ/HLG)→SDR 톤매핑 필터 체인. zscale(libzimg)+tonemap 사용 — ffmpeg-static 6.0 에
 * --enable-libzimg 로 번들되어 있음을 확인했다. 입력의 실제 색 태그(transfer/primaries)를
 * zscale 이 자동 감지하므로 in-파라미터 지정 없이도 PQ/HLG 양쪽에 동일 체인이 적용된다.
 * (프리뷰=perfProxy, 내보내기=compatProxy 둘 다 여기를 거치므로 이 한 곳만 바꾸면 WYSIWYG 유지)
 */
const HDR_TONEMAP_VF = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p'

/** 색공간 정규화 -vf 체인. HDR 이면 톤매핑, 아니면 기존 BT.601→709 매트릭스 정규화. scalePrefix 로 해상도 축소를 앞에 끼울 수 있다. */
function colorNormalizeVf(hdr: boolean, scalePrefix = ''): string {
  return hdr ? `${scalePrefix}${HDR_TONEMAP_VF}` : `${scalePrefix}scale=in_color_matrix=auto:out_color_matrix=bt709:out_range=tv`
}

/**
 * 호환 프록시 생성. onProgress 는 0~100.
 * 프록시 스펙: H.264 yuv420p, CFR(원본 avg fps 반올림 또는 30), GOP=fps(1초), faststart.
 * hdr=true 면 색공간 정규화 대신 HDR→SDR 톤매핑을 적용한다 (WYSIWYG: 프리뷰·내보내기 모두 이 프록시를 거침).
 */
export function makeCompatProxy(
  sourcePath: string,
  durationSec: number,
  fps: number,
  onProgress: (percent: number) => void,
  hdr = false
): ProxyJob {
  const outPath = join(cacheDir('proxy'), `${cacheKey(sourcePath)}.mp4`)
  if (existsSync(outPath)) {
    onProgress(100)
    return { cancel: () => {}, promise: Promise.resolve(outPath) }
  }

  const gop = Math.max(1, Math.round(fps))
  const args = [
    '-y',
    '-i', sourcePath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
    '-pix_fmt', 'yuv420p',
    // 색공간 정규화(또는 HDR 톤매핑): Chromium 은 BT.601 태그를 무시하므로 프록시는 항상 BT.709 로 통일 (WYSIWYG)
    '-vf', colorNormalizeVf(hdr),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-vsync', 'cfr', '-r', String(gop), // CFR 정규화 (VFR → 고정 fps)
    '-g', String(gop), '-keyint_min', String(gop),
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outPath
  ]

  const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderrTail = ''
  child.stderr.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000)
  })
  child.stdout.on('data', (d: Buffer) => {
    // -progress 출력에서 out_time_us 파싱
    const m = /out_time_us=(\d+)/.exec(d.toString())
    if (m && durationSec > 0) {
      const pct = Math.min(99, (Number(m[1]) / 1e6 / durationSec) * 100)
      onProgress(pct)
    }
  })

  const promise = new Promise<string>((resolvePromise, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        onProgress(100)
        resolvePromise(outPath)
      } else {
        reject(new Error(`프록시 생성 실패 (ffmpeg exit ${code}): ${stderrTail.split('\n').slice(-3).join(' ')}`))
      }
    })
  })

  return { cancel: () => child.kill('SIGKILL'), promise }
}

/**
 * 성능 프록시 (6.2.1) — 고해상도 소스를 720p 로 낮춰 프리뷰 전용으로 사용.
 * 내보내기는 원본(또는 호환 프록시)을 사용하므로 화질에 영향 없음.
 * hdr=true 면 색공간 정규화 대신 HDR→SDR 톤매핑을 적용한다.
 */
export function makePerfProxy(
  sourcePath: string,
  durationSec: number,
  fps: number,
  onProgress: (percent: number) => void,
  hdr = false
): ProxyJob {
  const outPath = join(cacheDir('perf-proxy'), `${cacheKey(sourcePath)}_720.mp4`)
  if (existsSync(outPath)) {
    onProgress(100)
    return { cancel: () => {}, promise: Promise.resolve(outPath) }
  }

  const gop = Math.max(1, Math.round(fps))
  const args = [
    '-y',
    '-i', sourcePath,
    '-map', '0:v:0', // 프리뷰 비디오 전용 — 오디오는 wav 추출본 사용
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-vf', colorNormalizeVf(hdr, 'scale=-2:720,'),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-vsync', 'cfr', '-r', String(gop),
    '-g', String(gop), '-keyint_min', String(gop),
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outPath
  ]

  const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderrTail = ''
  child.stderr.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000)
  })
  child.stdout.on('data', (d: Buffer) => {
    const m = /out_time_us=(\d+)/.exec(d.toString())
    if (m && durationSec > 0) onProgress(Math.min(99, (Number(m[1]) / 1e6 / durationSec) * 100))
  })
  const promise = new Promise<string>((resolvePromise, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        onProgress(100)
        resolvePromise(outPath)
      } else reject(new Error(`성능 프록시 생성 실패 (exit ${code}): ${stderrTail.split('\n').slice(-2).join(' ')}`))
    })
  })
  return { cancel: () => child.kill('SIGKILL'), promise }
}

/**
 * 오디오 트랙을 wav(pcm f32le) 로 추출 — 재생/파형/믹스다운 공용 (1.4.5, 2.1)
 * 오디오가 없으면 null.
 */
export async function extractAudioWav(sourcePath: string, sampleRate: number): Promise<string | null> {
  const outPath = join(cacheDir('audio'), `${cacheKey(sourcePath)}_${sampleRate}.wav`)
  if (existsSync(outPath)) return outPath

  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpegPath(), [
      '-y', '-i', sourcePath,
      '-vn', '-map', '0:a:0',
      '-acodec', 'pcm_f32le', '-ar', String(sampleRate), '-ac', '2',
      outPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderrTail = ''
    child.stderr.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise(outPath)
      else if (/does not contain any stream|matches no streams/i.test(stderrTail)) resolvePromise(null)
      else reject(new Error(`오디오 추출 실패: ${stderrTail.split('\n').slice(-2).join(' ')}`))
    })
  })
}
