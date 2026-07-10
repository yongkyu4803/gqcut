/**
 * 다중 선택 · 일괄 편집 e2e (phase-8)
 * 자막 3개 배치 → 1·3번만 ⌘클릭 선택 → 글자 크기 일괄 변경 → 2번은 불변 → ⌘Z 한 번에 전부 복원.
 * 미디어 임포트 없이 텍스트 클립만으로 UI 경로(수식키 선택 + 인스펙터 일괄 모드 + updateClips)를 관통한다.
 */
/// <reference lib="dom" />
/// <reference path="../src/preload/api.d.ts" />
import { test, expect, _electron as electron } from '@playwright/test'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')

interface TextClip {
  id: string
  timelineStart: number
  text?: { fontSize: number }
}

test('다중 선택 → 글자 크기 일괄 변경 → 선택 클립만 반영 + 단일 undo', async () => {
  const app = await electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, E2E: '1' }
  })
  const win = await app.firstWindow()
  win.on('dialog', (d) => void d.accept())
  await win.waitForSelector('[data-testid="add-text-btn"]')

  const textClips = async (): Promise<TextClip[]> => {
    const project = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
    return [...project.tracks.find((t: { kind: string }) => t.kind === 'text').clips].sort(
      (a: TextClip, b: TextClip) => a.timelineStart - b.timelineStart
    )
  }

  // 자막 3개 (0s, 4s, 8s) 배치
  for (const at of [0, 4, 8]) {
    await win.evaluate((t) => window.__test!.seek(t), at)
    await win.waitForTimeout(120)
    await win.click('[data-testid="add-text-btn"]')
  }
  let clips = await textClips()
  expect(clips).toHaveLength(3)
  const baseSize = clips[0].text!.fontSize

  // 1번 클릭(단일) → 3번 ⌘클릭(토글) = 1·3번만 선택
  await win.click(`[data-testid="clip-${clips[0].id}"]`)
  await win.click(`[data-testid="clip-${clips[2].id}"]`, { modifiers: ['Meta'] })

  // 인스펙터가 일괄 모드로 전환 ("2개 선택")
  await expect(win.locator('[data-testid="inspector-heading"]')).toContainText('2개 선택')

  // 글자 크기 일괄 변경
  const sizeInput = win.locator('[data-testid="text-fontsize"]')
  await sizeInput.fill('96')
  await sizeInput.blur()

  clips = await textClips()
  expect(clips[0].text!.fontSize).toBe(96) // 선택됨
  expect(clips[2].text!.fontSize).toBe(96) // 선택됨
  expect(clips[1].text!.fontSize).toBe(baseSize) // 미선택 — 불변

  // 단일 undo 로 두 클립 모두 원복
  await win.keyboard.press('Meta+z')
  clips = await textClips()
  expect(clips[0].text!.fontSize).toBe(baseSize)
  expect(clips[2].text!.fontSize).toBe(baseSize)

  await app.close()
})
