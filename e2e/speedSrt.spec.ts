/**
 * 속도 조절(feature-4) + SRT 자막 가져오기(feature-5) e2e
 * - 자막 SRT 가져오기: __test.importSrt 로 3개 배치 → 텍스트 트랙에 반영, ⌘Z 단일 복원
 * - 속도: 클립 선택 → 배속 입력 → 타임라인 길이 변화(슬로모=길어짐) + ⌘Z 복원
 */
/// <reference lib="dom" />
/// <reference path="../src/preload/api.d.ts" />
import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')
const FIXTURES = join(ROOT, 'e2e', '.fixtures')
const SAMPLE = join(FIXTURES, 'sample.mp4')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static')

const SRT = `1
00:00:00,500 --> 00:00:02,000
첫 번째 자막

2
00:00:02,500 --> 00:00:04,000
두 번째 자막

3
00:00:04,500 --> 00:00:06,000
세 번째 자막
`

test.beforeAll(() => {
  mkdirSync(FIXTURES, { recursive: true })
  if (!existsSync(SAMPLE)) {
    execFileSync(ffmpegPath, [
      '-y',
      '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', SAMPLE
    ])
  }
})

test('SRT 가져오기 + 속도 조절', async () => {
  const app = await electron.launch({ args: [join(ROOT, 'out', 'main', 'index.js')], env: { ...process.env, E2E: '1' } })
  const win = await app.firstWindow()
  win.on('dialog', (d) => void d.accept())
  await win.waitForSelector('[data-testid="add-text-btn"]')

  const proj = async (): Promise<{ tracks: Array<{ kind: string; clips: Array<{ id: string; timelineStart: number; timelineEnd: number; text?: { value: string } }> }> }> =>
    JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
  const textClips = async (): Promise<Array<{ text?: { value: string } }>> => (await proj()).tracks.find((t) => t.kind === 'text')!.clips

  // ── SRT 가져오기 (feature-5) ──
  const n = await win.evaluate((srt) => window.__test!.importSrt(srt), SRT)
  expect(n).toBe(3)
  let subs = await textClips()
  expect(subs).toHaveLength(3)
  expect(subs.map((c) => c.text?.value).sort()).toEqual(['두 번째 자막', '세 번째 자막', '첫 번째 자막'])
  await win.keyboard.press('Meta+z') // 단일 undo 로 3개 모두 제거
  expect(await textClips()).toHaveLength(0)

  // ── 속도 조절 (feature-4) ──
  await win.evaluate((p) => window.__test!.importFile(p), SAMPLE)
  await win.waitForSelector('[data-testid^="clip-"]')
  const videoClip = async (): Promise<{ id: string; timelineStart: number; timelineEnd: number; speed?: number }> => {
    const p = await proj()
    return p.tracks.find((t) => t.kind === 'video')!.clips[0]
  }
  const c0 = await videoClip()
  const origLen = c0.timelineEnd - c0.timelineStart

  await win.click(`[data-testid="clip-${c0.id}"]`)
  const speedInput = win.locator('[data-testid="clip-speed"]')
  await speedInput.fill('0.5')
  await speedInput.blur()

  const slow = await videoClip()
  expect(slow.speed).toBeCloseTo(0.5, 3)
  expect(slow.timelineEnd - slow.timelineStart).toBeCloseTo(origLen * 2, 1) // 슬로모 → 길이 2배

  await win.keyboard.press('Meta+z')
  const restored = await videoClip()
  expect(restored.speed ?? 1).toBeCloseTo(1, 3)
  expect(restored.timelineEnd - restored.timelineStart).toBeCloseTo(origLen, 1)

  await app.close()
})
