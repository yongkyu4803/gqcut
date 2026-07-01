/**
 * e2e 스모크 (1.6.1): 임포트 → 컷 편집 → 시크 → 내보내기 관통 시나리오.
 * 회귀 게이트 — 이 테스트가 깨지면 phase 진행 불가 (globalVerificationGates).
 */
/// <reference lib="dom" />
/// <reference path="../src/preload/api.d.ts" />
import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')
const FIXTURES = join(ROOT, 'e2e', '.fixtures')
const SAMPLE = join(FIXTURES, 'sample.mp4')
const OUTPUT = join(FIXTURES, 'out.mp4')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobePath: string = require('ffprobe-static').path

function probeDuration(file: string): number {
  const out = execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
  return Number(out.toString().trim())
}

/** 동일 시각 프레임의 SSIM (WYSIWYG 스팟 체크, 1.5) — 원본을 출력 해상도로 스케일해 비교. crop 지정 시 해당 영역만. */
function ssimAt(outFile: string, srcFile: string, t: number, crop?: string): number {
  const c = crop ? `,crop=${crop}` : ''
  const result = spawnSync(
    ffmpegPath,
    [
      '-ss', String(t), '-i', outFile,
      '-ss', String(t), '-i', srcFile,
      '-filter_complex', `[0:v]null${c}[a];[1:v]scale=1920:1080:flags=bicubic${c}[b];[a][b]ssim`,
      '-frames:v', '1', '-f', 'null', '-'
    ],
    { encoding: 'utf8' }
  )
  const m = /All:(\d+\.\d+)/.exec(result.stderr)
  if (!m) throw new Error(`SSIM 파싱 실패: ${result.stderr.slice(-500)}`)
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
  rmSync(OUTPUT, { force: true })
})

test('임포트 → 분할 → 삭제 → 시크 → 내보내기 스모크', async () => {
  const app = await electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, E2E: '1' }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('[data-testid="import-btn"]')

  // 0.1 검증: IPC ping/pong
  const pong = await win.evaluate(() => window.editor.ping())
  expect(pong).toBe('pong')

  // 0.2 검증: 손상/비미디어 파일은 크래시 없이 에러 반환 (graceful)
  const probeError = await win.evaluate(() => window.editor.probe('/nonexistent/broken.mp4').then(() => null, (e: Error) => e.message))
  expect(probeError).toBeTruthy()

  // 임포트 (0.2 프로브 + 0.3) — 테스트 훅으로 다이얼로그 우회
  const assetId = await win.evaluate((path) => window.__test!.importFile(path), SAMPLE)
  expect(assetId).toBeTruthy()
  await win.waitForSelector('[data-testid^="clip-"]')

  // 프로젝트 상태 확인: 4초 클립 1개
  let project = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
  const videoTrack = project.tracks.find((t: { kind: string }) => t.kind === 'video')
  expect(videoTrack.clips).toHaveLength(1)
  expect(videoTrack.clips[0].timelineEnd).toBeCloseTo(4, 1)

  // 컷 편집 (1.2.4): 2초 지점에서 분할 → 뒤 클립 삭제 → 2초 타임라인
  await win.evaluate(() => window.__test!.seek(2))
  await win.waitForTimeout(300)
  await win.evaluate(() => window.__test!.splitAtPlayhead())
  project = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
  const clips = project.tracks.find((t: { kind: string }) => t.kind === 'video').clips
  expect(clips).toHaveLength(2)
  expect(clips[0].timelineEnd).toBeCloseTo(2, 2)
  expect(clips[1].sourceIn).toBeCloseTo(2, 2)

  // 뒤 클립 삭제 — UI 경로 (클립 선택 후 Delete 키, 1.2.6 단축키 검증 겸)
  await win.click(`[data-testid="clip-${clips[1].id}"]`)
  await win.keyboard.press('Delete')
  project = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
  expect(project.tracks.find((t: { kind: string }) => t.kind === 'video').clips).toHaveLength(1)

  // undo/redo (1.1.3): 삭제 취소 → 2개 복원, 다시실행 → 1개
  await win.keyboard.press('Meta+z')
  project = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
  expect(project.tracks.find((t: { kind: string }) => t.kind === 'video').clips).toHaveLength(2)
  await win.keyboard.press('Shift+Meta+z')
  project = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
  expect(project.tracks.find((t: { kind: string }) => t.kind === 'video').clips).toHaveLength(1)

  // 텍스트 오버레이 추가 (3.1): 플레이헤드 1초에 3초짜리 텍스트 → 타임라인 4초로 확장
  await win.evaluate(() => window.__test!.seek(1))
  await win.waitForTimeout(300)
  await win.click('[data-testid="add-text-btn"]')
  project = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
  const textClips = project.tracks.find((t: { kind: string }) => t.kind === 'text').clips
  expect(textClips).toHaveLength(1)
  expect(textClips[0].timelineEnd).toBeCloseTo(4, 2)

  // 시크 후 프리뷰 렌더 (0.3.3 / 1.4.4)
  await win.evaluate(() => window.__test!.seek(1.5))
  await win.waitForTimeout(500)

  // 내보내기 (1.5): 컷 + 텍스트 + 오디오 패스스루 → mp4
  const result = await win.evaluate((path) => window.__test!.exportTo(path), OUTPUT)
  expect(result.ok, result.error).toBe(true)
  // 처리량 기록 (1.5.3)
  if (result.stats) {
    console.log(
      `[export stats] frames=${result.stats.frames} elapsed=${(result.stats.elapsedMs / 1000).toFixed(1)}s ` +
        `pipe=${result.stats.mbPerSec.toFixed(0)}MB/s speed=${(4 / (result.stats.elapsedMs / 1000)).toFixed(2)}x realtime`
    )
  }

  // 출력 검증: duration = 타임라인 duration (±1프레임)
  expect(existsSync(OUTPUT)).toBe(true)
  const dur = probeDuration(OUTPUT)
  expect(Math.abs(dur - 4)).toBeLessThanOrEqual(1 / 30 + 0.05)

  // WYSIWYG 스팟 체크 (1.5): 텍스트 없는 0.5초 지점에서 출력 vs 원본 SSIM
  const ssim = ssimAt(OUTPUT, SAMPLE, 0.5)
  expect(ssim, `SSIM=${ssim}`).toBeGreaterThan(0.95)

  // 텍스트 렌더 검증 (3.1): 텍스트가 놓이는 중앙 영역은 원본과 확연히 달라야 한다 (오버레이가 실제 픽셀에 존재)
  const CENTER = '600:200:660:440'
  const ssimTextRegion = ssimAt(OUTPUT, SAMPLE, 1.5, CENTER)
  const ssimTextRegionBefore = ssimAt(OUTPUT, SAMPLE, 0.5, CENTER)
  expect(ssimTextRegion, `SSIM(text region)=${ssimTextRegion}`).toBeLessThan(0.93)
  expect(ssimTextRegionBefore, `SSIM(no-text region)=${ssimTextRegionBefore}`).toBeGreaterThan(0.95)

  await app.close()
})
