/**
 * 테마 전환(다크 ↔ 라이트-베이지) e2e
 * 기본=다크 → 토글 시 data-theme=light + 배경색이 베이지로 변함 → 재로드 후에도 유지(localStorage).
 */
/// <reference lib="dom" />
/// <reference path="../src/preload/api.d.ts" />
import { test, expect, _electron as electron } from '@playwright/test'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')

test('테마 토글 + 지속성', async () => {
  const app = await electron.launch({ args: [join(ROOT, 'out', 'main', 'index.js')], env: { ...process.env, E2E: '1' } })
  const win = await app.firstWindow()
  win.on('dialog', (d) => void d.accept())
  await win.waitForSelector('[data-testid="theme-toggle"]')

  // 기본: 다크(data-theme 없음)
  expect(await win.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull()
  const darkBg = await win.evaluate(() => getComputedStyle(document.body).backgroundColor)

  // 토글 → 라이트
  await win.click('[data-testid="theme-toggle"]')
  expect(await win.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light')
  const lightBg = await win.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(lightBg).not.toBe(darkBg)
  // 베이지(밝고 따뜻) — R,G,B 모두 높고 R>=B (따뜻)
  const rgb = /rgb\((\d+), (\d+), (\d+)\)/.exec(lightBg)!
  const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  expect(r).toBeGreaterThan(200)
  expect(g).toBeGreaterThan(190)
  expect(r).toBeGreaterThanOrEqual(b) // 따뜻한 톤(적색 >= 청색)

  // 재로드 후에도 라이트 유지 (localStorage → main.tsx applyTheme)
  await win.reload()
  await win.waitForSelector('[data-testid="theme-toggle"]')
  expect(await win.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light')

  // 다시 토글 → 다크 복귀
  await win.click('[data-testid="theme-toggle"]')
  expect(await win.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull()

  await app.close()
})
