/**
 * e2e 스모크 (1.6.1) + WYSIWYG 수치 검증 (5.2.5)
 * 임포트 → 컷 편집 → undo/redo → 텍스트 → 필터 → 전환 → 내보내기 관통 시나리오.
 * WYSIWYG 게이트: 기준 프레임(프리뷰와 동일 렌더 경로 캡처) vs 출력 프레임 SSIM ≥ 0.99.
 * 회귀 게이트 — 이 테스트가 깨지면 phase 진행 불가 (globalVerificationGates).
 */
/// <reference lib="dom" />
/// <reference path="../src/preload/api.d.ts" />
import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')
const FIXTURES = join(ROOT, 'e2e', '.fixtures')
const SAMPLE = join(FIXTURES, 'sample.mp4')
const IMAGE = join(FIXTURES, 'overlay.png')
const OUTPUT = join(FIXTURES, 'out.mp4')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobePath: string = require('ffprobe-static').path

function probeDuration(file: string): number {
  const out = execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
  return Number(out.toString().trim())
}

function probeStreams(file: string): string {
  return execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]).toString()
}

/** 출력 파일의 fi 번째 프레임 추출 */
function extractFrame(file: string, frameIndex: number, outPng: string): void {
  execFileSync(ffmpegPath, ['-y', '-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frameIndex})`, '-frames:v', '1', outPng])
}

/**
 * 두 이미지의 SSIM (WYSIWYG 수치 판정).
 * 양쪽을 yuv420p 로 정규화해 비교 — H.264 의 4:2:0 크로마 서브샘플링은 인코딩 고유 손실이라
 * 렌더 파이프라인 동일성 판정에서 제외한다 (색바 같은 고채도 경계에서만 크게 나타남).
 */
function ssimImages(a: string, b: string): number {
  const result = spawnSync(
    ffmpegPath,
    ['-i', a, '-i', b, '-filter_complex', '[0:v]format=yuv420p[ra];[1:v]format=yuv420p[rb];[ra][rb]ssim', '-frames:v', '1', '-f', 'null', '-'],
    { encoding: 'utf8' }
  )
  const m = /All:(\d+\.\d+)/.exec(result.stderr)
  if (!m) throw new Error(`SSIM 파싱 실패: ${result.stderr.slice(-400)}`)
  return Number(m[1])
}

test.beforeAll(() => {
  mkdirSync(FIXTURES, { recursive: true })
  if (!existsSync(SAMPLE)) {
    // 4초 테스트 영상: SMPTE 바 + 440Hz 톤 (30fps, 640x360, GOP 30)
    execFileSync(ffmpegPath, [
      '-y',
      '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30',
      '-c:a', 'aac',
      SAMPLE
    ])
  }
  if (!existsSync(IMAGE)) {
    execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'color=red:size=320x240', '-frames:v', '1', IMAGE])
  }
  rmSync(OUTPUT, { force: true })
})

test('임포트 → 컷 → undo/redo → 텍스트/필터/전환 → 내보내기 → WYSIWYG SSIM', async () => {
  const app = await electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, E2E: '1' }
  })
  const win = await app.firstWindow()
  win.on('dialog', (d) => void d.accept()) // confirm/alert 자동 수락 (새 프로젝트 확인 등)
  await win.waitForSelector('[data-testid="import-btn"]')

  // 0.1 검증: IPC ping/pong
  expect(await win.evaluate(() => window.editor.ping())).toBe('pong')

  // 0.2 검증: 손상/비미디어 파일은 크래시 없이 에러 반환 (graceful)
  const probeError = await win.evaluate(() => window.editor.probe('/nonexistent/broken.mp4').then(() => null, (e: Error) => e.message))
  expect(probeError).toBeTruthy()

  // 임포트 (0.2 프로브 + 0.3 + 0.4 프록시: 샘플은 bt470bg 라 색공간 정규화 프록시 경로를 탄다)
  const assetId = await win.evaluate((path) => window.__test!.importFile(path), SAMPLE)
  expect(assetId).toBeTruthy()
  await win.waitForSelector('[data-testid^="clip-"]')

  const getClips = async (): Promise<Array<{ id: string; timelineStart: number; timelineEnd: number; sourceIn: number }>> => {
    const project = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
    return project.tracks.find((t: { kind: string }) => t.kind === 'video').clips
  }

  // 컷 편집 (1.2.4): 2초 지점에서 분할 — 단축키 C 로 검증
  await win.evaluate(() => window.__test!.seek(2))
  await win.waitForTimeout(300)
  await win.keyboard.press('c')
  let clips = await getClips()
  expect(clips).toHaveLength(2)
  expect(clips[0].timelineEnd).toBeCloseTo(2, 2)
  expect(clips[1].sourceIn).toBeCloseTo(2, 2)

  // 컷 병합 (분할의 역연산): 왼쪽 클립 선택 후 병합 버튼 → 원래 1클립으로 복원
  await win.click(`[data-testid="clip-${clips[0].id}"]`)
  await win.click('[data-testid="merge-btn"]')
  let mergedClips = await getClips()
  expect(mergedClips).toHaveLength(1)
  expect(mergedClips[0].timelineEnd).toBeCloseTo(4, 2)
  await win.keyboard.press('r') // 되돌리기 단축키(R) 검증 — 병합 취소 → 2클립 상태 복원
  clips = await getClips()
  expect(clips).toHaveLength(2)

  // 삭제 → undo → redo → undo (1.1.3, 1.2.6): 최종적으로 2클립 유지
  await win.click(`[data-testid="clip-${clips[1].id}"]`)
  await win.keyboard.press('Delete')
  expect(await getClips()).toHaveLength(1)
  await win.keyboard.press('Meta+z')
  expect(await getClips()).toHaveLength(2)
  await win.keyboard.press('Shift+Meta+z')
  expect(await getClips()).toHaveLength(1)
  await win.keyboard.press('Meta+z')
  expect(await getClips()).toHaveLength(2)

  // 텍스트 오버레이 (3.1): 1초에 3초짜리 → 타임라인 4초 유지
  await win.evaluate(() => window.__test!.seek(1))
  await win.waitForTimeout(300)
  await win.click('[data-testid="add-text-btn"]')
  const project = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
  expect(project.tracks.find((t: { kind: string }) => t.kind === 'text').clips).toHaveLength(1)

  // 필터 (4.1) + 전환 (4.2): 채도 1.5 전체 적용, 컷 지점(2초)에 1초 디졸브
  await win.evaluate(() => window.__test!.applyFilter('saturation', 1.5))
  await win.evaluate(() => window.__test!.applyTransition('dissolve', 1.0))

  // 이미지 오버레이 (멀티트랙): PNG 임포트 → 메인 위에 새 비디오 트랙 생성
  await win.evaluate(() => window.__test!.seek(0.5))
  await win.waitForTimeout(200)
  await win.evaluate((path) => window.__test!.importFile(path), IMAGE)
  let proj = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
  let videoTracks = proj.tracks.filter((t: { kind: string }) => t.kind === 'video')
  expect(videoTracks).toHaveLength(2)
  expect(videoTracks[0].clips[0].kind).toBe('image') // 오버레이(상위 레이어) 트랙
  expect(videoTracks[1].clips).toHaveLength(2) // 메인 트랙은 그대로
  // 타임라인 duration 을 바꾸지 않도록 undo (오버레이 트랙+클립이 한 번에 되돌아감)
  await win.keyboard.press('Meta+z')
  proj = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
  videoTracks = proj.tracks.filter((t: { kind: string }) => t.kind === 'video')
  expect(videoTracks).toHaveLength(1)

  // 내보내기 (5.2): 컷+텍스트+필터+전환+오디오 믹스다운
  const result = await win.evaluate((path) => window.__test!.exportTo(path), OUTPUT)
  expect(result.ok, result.error).toBe(true)
  if (result.stats) {
    console.log(
      `[export stats] frames=${result.stats.frames} elapsed=${(result.stats.elapsedMs / 1000).toFixed(1)}s ` +
        `pipe=${result.stats.mbPerSec.toFixed(0)}MB/s speed=${(4 / (result.stats.elapsedMs / 1000)).toFixed(2)}x realtime`
    )
  }

  // 출력 구조 검증: duration ±1프레임, 비디오+오디오 스트림
  expect(existsSync(OUTPUT)).toBe(true)
  expect(Math.abs(probeDuration(OUTPUT) - 4)).toBeLessThanOrEqual(1 / 30 + 0.05)
  const streams = probeStreams(OUTPUT)
  expect(streams).toContain('video')
  expect(streams).toContain('audio')

  // WYSIWYG 수치 게이트 (5.2.5): 기준 프레임(동일 렌더 경로 캡처) vs 출력 프레임 SSIM ≥ 0.99
  // 프레임 15(0.5s 필터), 45(1.5s 필터+텍스트), 60(2.0s 전환 중앙)
  for (const fi of [15, 45, 60]) {
    const t = (fi + 0.5) / 30
    const dataUrl = await win.evaluate((tt) => window.__test!.captureFrame(tt), t)
    const refPng = join(FIXTURES, `ref_${fi}.png`)
    const outPng = join(FIXTURES, `out_${fi}.png`)
    writeFileSync(refPng, Buffer.from(dataUrl.split(',')[1], 'base64'))
    extractFrame(OUTPUT, fi, outPng)
    const ssim = ssimImages(refPng, outPng)
    console.log(`[wysiwyg] frame ${fi} (t=${t.toFixed(3)}s) SSIM=${ssim}`)
    expect(ssim, `frame ${fi} SSIM=${ssim}`).toBeGreaterThanOrEqual(0.99)
  }

  // 새 프로젝트: 미저장 변경 확인(자동 수락) 후 빈 프로젝트로 초기화
  await win.click('[data-testid="new-project-btn"]')
  const fresh = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
  expect(fresh.assets).toHaveLength(0)
  expect(fresh.tracks.every((t: { clips: unknown[] }) => t.clips.length === 0)).toBe(true)

  await app.close()
})
