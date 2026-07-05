/**
 * 무음 감지 자동 컷 — 통합 테스트. ffmpeg silencedetect 는 모델 다운로드가 없어 가볍다(STT와 달리 게이팅 불필요).
 * 임포트 → 무음 감지 → 미리보기(타임라인 마커/인스펙터 체크박스) → 선택 해제/재선택 → 적용 → undo 관통 시나리오.
 */
/// <reference lib="dom" />
/// <reference path="../src/preload/api.d.ts" />
import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')
const FIXTURES = join(ROOT, 'e2e', '.fixtures')
const SAMPLE = join(FIXTURES, 'silence_sample.mp4')
const MUSIC = join(FIXTURES, 'silence_music.m4a')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static')

test.beforeAll(() => {
  mkdirSync(FIXTURES, { recursive: true })
  if (!existsSync(SAMPLE)) {
    // 4초: 1~2초 구간만 완전 무음(volume=0), 나머지는 440Hz 톤 (30fps, 640x360)
    execFileSync(ffmpegPath, [
      '-y',
      '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '4',
      '-af', "volume=enable='between(t,1,2)':volume=0",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30',
      '-c:a', 'aac',
      SAMPLE
    ])
  }
  if (!existsSync(MUSIC)) {
    // 오디오 전용(비디오 스트림 없음) 6초 배경음악 픽스처 — kind: 'audio' 로 프로브됨
    execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '6', '-c:a', 'aac', MUSIC])
  }
})

test('무음 감지 → 미리보기(선택 해제/재선택) → 적용 → undo', async () => {
  const app = await electron.launch({ args: [join(ROOT, 'out', 'main', 'index.js')], env: { ...process.env, E2E: '1' } })
  const win = await app.firstWindow()
  win.on('dialog', (d) => void d.accept())
  await win.waitForSelector('[data-testid="import-btn"]')

  await win.evaluate((p) => window.__test!.importFile(p), SAMPLE)
  await win.waitForSelector('[data-testid^="clip-"]')

  const n = await win.evaluate(() => window.__test!.detectSilence(-30, 0.3))
  expect(n).toBe(1)

  const preview = JSON.parse(await win.evaluate(() => window.__test!.getSilencePreviewJson())) as {
    candidates: Array<{ start: number; end: number }>
  }
  expect(preview.candidates).toHaveLength(1)
  expect(preview.candidates[0].start).toBeGreaterThan(0.8)
  expect(preview.candidates[0].start).toBeLessThan(1.2)
  expect(preview.candidates[0].end).toBeGreaterThan(1.8)
  expect(preview.candidates[0].end).toBeLessThan(2.2)

  // 타임라인 마커 + 인스펙터 후보 리스트가 실제로 렌더링되는지 (실 UI 확인)
  await win.waitForSelector('[data-testid^="silence-marker-"]')
  await win.waitForSelector('[data-testid="apply-silence-btn"]')

  // 체크박스로 선택 해제 → 적용 버튼 비활성화 → 다시 선택 → 활성화
  const checkbox = win.locator('[data-testid="silence-candidate-list"] input[type=checkbox]')
  await checkbox.uncheck()
  await expect(win.locator('[data-testid="apply-silence-btn"]')).toBeDisabled()
  await checkbox.check()
  await expect(win.locator('[data-testid="apply-silence-btn"]')).toBeEnabled()

  await win.click('[data-testid="apply-silence-btn"]')

  const getClips = async (): Promise<Array<{ timelineStart: number; timelineEnd: number }>> => {
    const project = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
    return project.tracks.find((t: { kind: string }) => t.kind === 'video').clips
  }
  const clips = await getClips()
  expect(clips).toHaveLength(2)
  const totalDuration = Math.max(...clips.map((c) => c.timelineEnd))
  expect(totalDuration).toBeGreaterThan(2.8)
  expect(totalDuration).toBeLessThan(3.2) // 4초 - 약 1초 무음

  // 단일 undo 로 원복
  await win.keyboard.press('Meta+z')
  const restored = await getClips()
  expect(restored).toHaveLength(1)
  expect(restored[0].timelineEnd).toBeCloseTo(4, 1)

  await app.close()
})

test('전체 트랙 스코프: 배경음악은 잘리지 않고 위치만 밀린다', async () => {
  const app = await electron.launch({ args: [join(ROOT, 'out', 'main', 'index.js')], env: { ...process.env, E2E: '1' } })
  const win = await app.firstWindow()
  win.on('dialog', (d) => void d.accept())
  await win.waitForSelector('[data-testid="import-btn"]')

  await win.evaluate((p) => window.__test!.importFile(p), SAMPLE)
  await win.waitForSelector('[data-testid^="clip-"]')
  const proj0 = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
  const videoClipId = proj0.tracks.find((t: { kind: string }) => t.kind === 'video').clips[0].id

  // 배경음악 임포트(오디오 트랙에 배치) — 임포트하면 이 클립이 선택되므로 이후 비디오 클립을 다시 선택해야 함
  await win.evaluate((p) => window.__test!.importFile(p), MUSIC)
  await win.click(`[data-testid="clip-${videoClipId}"]`)

  const n = await win.evaluate(() => window.__test!.detectSilence(-30, 0.3, 'all-tracks'))
  expect(n).toBe(1)
  await win.click('[data-testid="apply-silence-btn"]')

  const project = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
  const videoClips = project.tracks.find((t: { kind: string }) => t.kind === 'video').clips
  expect(videoClips).toHaveLength(2) // 비디오는 무음 구간에서 잘려 2조각

  const musicClips = project.tracks.find((t: { kind: string }) => t.kind === 'audio').clips
  expect(musicClips).toHaveLength(1) // 음악은 잘리지 않고 한 조각 그대로
  const musicDuration = musicClips[0].timelineEnd - musicClips[0].timelineStart
  expect(musicDuration).toBeGreaterThan(5.8)
  expect(musicDuration).toBeLessThan(6.2) // 원본 6초 길이 그대로 보존(글리치 없음)

  await app.close()
})
