/**
 * 자동 자막(STT, 3.2) 통합 테스트 — 모델 다운로드+CPU 추론이 무거워 기본 CI 게이트에서는 제외한다.
 * 로컬/전용 잡에서 RUN_STT_E2E=1 로 실행: `RUN_STT_E2E=1 npx playwright test stt`.
 * (순수 로직은 tests/subtitles.test.ts 가 항상 커버 — 이 스펙은 실제 Whisper 파이프라인 회귀 검증)
 */
/// <reference lib="dom" />
/// <reference path="../src/preload/api.d.ts" />
import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')
const FIXTURES = join(ROOT, 'e2e', '.fixtures')
const SPEECH = join(FIXTURES, 'speech.mp4')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static')

test.skip(!process.env.RUN_STT_E2E, 'STT 통합 테스트는 RUN_STT_E2E=1 일 때만 (모델 다운로드/추론)')
test.describe.configure({ timeout: 300_000 })

test.beforeAll(() => {
  mkdirSync(FIXTURES, { recursive: true })
  if (!existsSync(SPEECH)) {
    // macOS 음성합성(say)으로 한국어 픽스처 생성 → SMPTE 바와 mux
    const aiff = join(FIXTURES, 'ko.aiff')
    execFileSync('say', ['-v', 'Yuna', '-o', aiff, '안녕하세요. 자동 자막 생성 테스트입니다. 위스퍼 모델이 잘 동작하는지 확인합니다.'])
    execFileSync(ffmpegPath, [
      '-y', '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=30',
      '-i', aiff, '-t', '6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-shortest',
      SPEECH
    ])
  }
})

test('음성 비디오 → 자동 자막 생성 → 자막 트랙 배치 + SRT', async () => {
  const app = await electron.launch({ args: [join(ROOT, 'out', 'main', 'index.js')], env: { ...process.env, E2E: '1' } })
  const win = await app.firstWindow()
  win.on('dialog', (d) => void d.accept())
  await win.waitForSelector('[data-testid="import-btn"]')

  await win.evaluate((p) => window.__test!.importFile(p), SPEECH)
  const count = await win.evaluate(() => window.__test!.generateCaptions('whisper-base', 'korean'))
  expect(count, '자막 세그먼트가 1개 이상 생성되어야 한다').toBeGreaterThanOrEqual(1)

  const proj = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
  const textClips = proj.tracks.filter((t: { kind: string }) => t.kind === 'text').flatMap((t: { clips: unknown[] }) => t.clips) as Array<{
    timelineStart: number
    timelineEnd: number
    text: { value: string }
  }>
  expect(textClips.length).toBe(count)

  // 타임코드: 모두 6초 클립 범위 안, 시작<끝, 시간순 비겹침
  const sorted = [...textClips].sort((a, b) => a.timelineStart - b.timelineStart)
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]
    expect(c.timelineStart).toBeGreaterThanOrEqual(0)
    expect(c.timelineEnd).toBeLessThanOrEqual(6 + 1e-6)
    expect(c.timelineEnd).toBeGreaterThan(c.timelineStart)
    expect(c.text.value.trim().length).toBeGreaterThan(0)
    if (i > 0) expect(c.timelineStart).toBeGreaterThanOrEqual(sorted[i - 1].timelineEnd - 1e-6)
  }
  // 한국어 인식 정확도(대략): 핵심 단어가 잡히는지
  const all = textClips.map((c) => c.text.value).join(' ')
  expect(all).toMatch(/자막|안녕|모델|확인/)

  // undo 1회로 자막 전체 롤백
  await win.keyboard.press('Meta+z')
  const proj2 = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
  const remaining = proj2.tracks.filter((t: { kind: string }) => t.kind === 'text').flatMap((t: { clips: unknown[] }) => t.clips)
  expect(remaining.length).toBe(0)

  await app.close()
})
