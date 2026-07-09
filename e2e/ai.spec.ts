/**
 * AI 편집 어시스턴트 e2e (7.3.4).
 *  - 모의 경로(네트워크 없음): __test.aiRunTools 로 executor→프로젝트 상태를 실제 렌더러에서 단언 → 기본 CI 그린.
 *  - 실 API 1턴: RUN_AI_E2E=1 일 때만 (구독 한도 사용). `RUN_AI_E2E=1 npx playwright test ai`.
 */
/// <reference lib="dom" />
/// <reference path="../src/preload/api.d.ts" />
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')
const FIXTURES = join(ROOT, 'e2e', '.fixtures')
const CLIP = join(FIXTURES, 'ai-clip.mp4')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static')

type ProjJson = { tracks: Array<{ kind: string; clips: Array<{ id: string }> }> }
const clipsOfKind = (proj: ProjJson, kind: string): Array<{ id: string }> =>
  proj.tracks.filter((t) => t.kind === kind).flatMap((t) => t.clips)

async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ args: [join(ROOT, 'out', 'main', 'index.js')], env: { ...process.env, E2E: '1' } })
  const win = await app.firstWindow()
  win.on('dialog', (d) => void d.accept())
  await win.waitForSelector('[data-testid="import-btn"]')
  return { app, win }
}

test.describe('AI 패널 — 모의 경로 (네트워크 없이 CI 그린)', () => {
  test('AI 탭이 열리고 패널·인증 배지가 렌더된다', async () => {
    const { app, win } = await launch()
    await win.click('[data-testid="ai-tab"]')
    await expect(win.locator('[data-testid="ai-panel"]')).toBeVisible()
    await expect(win.locator('.ai-auth-badge')).toBeVisible()
    await app.close()
  })

  test('aiRunTools: add_text → split_clip 이 실제 렌더러 상태에 반영된다', async () => {
    const { app, win } = await launch()

    const add = await win.evaluate(() =>
      window.__test!.aiRunTools([{ name: 'add_text', input: { value: '오프닝', atSec: 0, durationSec: 5 } }])
    )
    expect(add[0].ok).toBe(true)

    const proj1 = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson())) as ProjJson
    const textClip = clipsOfKind(proj1, 'text')[0]
    expect(textClip).toBeTruthy()

    const split = await win.evaluate(
      (id) => window.__test!.aiRunTools([{ name: 'split_clip', input: { clipId: id, atSec: 2 } }]),
      textClip.id
    )
    expect(split[0].ok).toBe(true)

    const proj2 = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson())) as ProjJson
    expect(clipsOfKind(proj2, 'text').length).toBe(2)

    // 없는 id → 한국어 에러(크래시 없이 순환)
    const bad = await win.evaluate(() =>
      window.__test!.aiRunTools([{ name: 'split_clip', input: { clipId: 'nope', atSec: 1 } }])
    )
    expect(bad[0].ok).toBe(false)
    expect(bad[0].message).toContain('찾을 수 없습니다')

    await app.close()
  })

  test('add_text 자막이 실제 렌더링에서 하단 가이드선(0.95H)에 놓인다 (픽셀 검증)', async () => {
    const { app, win } = await launch()
    // 검정 배경 + 흰 자막을 t=0 에 추가하고 실제 합성 프레임을 캡처해 흰 글자 픽셀 세로 범위를 분석
    const info = await win.evaluate(async () => {
      await window.__test!.aiRunTools([{ name: 'add_text', input: { value: '자막 위치 테스트', atSec: 0, durationSec: 2 } }])
      const dataUrl = await window.__test!.captureFrame(0)
      const img = new Image()
      await new Promise<void>((res, rej) => {
        img.onload = () => res()
        img.onerror = () => rej(new Error('img load fail'))
        img.src = dataUrl
      })
      const cv = document.createElement('canvas')
      cv.width = img.width
      cv.height = img.height
      const ctx = cv.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, cv.width, cv.height).data
      let minY = cv.height
      let maxY = -1
      for (let y = 0; y < cv.height; y++) {
        for (let x = 0; x < cv.width; x++) {
          const i = (y * cv.width + x) * 4
          if (data[i] + data[i + 1] + data[i + 2] > 200) {
            if (y < minY) minY = y
            if (y > maxY) maxY = y
            break
          }
        }
      }
      return { w: img.width, h: img.height, minY, maxY }
    })

    expect(info.maxY, '자막 픽셀이 렌더링되어야 한다').toBeGreaterThan(0)
    // 텍스트 하단이 화면 중앙(0.5H) 훨씬 아래 = 하단 배치
    expect(info.maxY / info.h).toBeGreaterThan(0.85)
    // 텍스트 하단이 하단 가이드선(0.95H) 근처 (안전영역 밖으로 벗어나지 않고 ±6% 이내)
    expect(Math.abs(info.maxY - info.h * 0.95)).toBeLessThan(info.h * 0.06)
    await app.close()
  })
})

test.describe('AI 실제 1턴 (RUN_AI_E2E)', () => {
  test.skip(!process.env.RUN_AI_E2E, '실 API 테스트는 RUN_AI_E2E=1 일 때만 (Claude Code 구독 한도 사용)')
  test.describe.configure({ timeout: 180_000 })

  test.beforeAll(() => {
    mkdirSync(FIXTURES, { recursive: true })
    if (!existsSync(CLIP)) {
      execFileSync(ffmpegPath, [
        '-y',
        '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=30',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-t', '5',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-shortest',
        CLIP
      ])
    }
  })

  test('"2초에서 잘라줘" → 선택 클립이 2개로 분할된다', async () => {
    const { app, win } = await launch()
    await win.evaluate((p) => window.__test!.importFile(p), CLIP)

    const before = clipsOfKind(JSON.parse(await win.evaluate(() => window.__test!.getProjectJson())) as ProjJson, 'video')
    expect(before.length).toBe(1)

    await win.evaluate(() => window.__test!.aiSendAndWait('선택한 클립을 2초 지점에서 둘로 잘라줘.'))

    const after = clipsOfKind(JSON.parse(await win.evaluate(() => window.__test!.getProjectJson())) as ProjJson, 'video')
    expect(after.length, 'AI 가 split_clip 을 실행해 클립이 2개가 되어야 한다').toBe(2)

    await app.close()
  })
})
