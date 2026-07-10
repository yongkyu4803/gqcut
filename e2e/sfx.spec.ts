/**
 * 전환 효과음(SFX) e2e (phase-9)
 * 1) sfx:paths IPC 가 번들 효과음 절대경로를 돌려준다(dev 리소스 리졸버).
 * 2) 컷을 나눠 인접 쌍을 만들고 전환+효과음을 UI 로 지정 → 프로젝트 JSON 에 transitionOut.sound 반영, ⌘Z 복원.
 * 3) 효과음이 붙은 프로젝트를 내보내면 오디오 스트림이 포함된다.
 */
/// <reference lib="dom" />
/// <reference path="../src/preload/api.d.ts" />
import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')
const FIXTURES = join(ROOT, 'e2e', '.fixtures')
const SAMPLE = join(FIXTURES, 'sample.mp4')
const OUTPUT = join(FIXTURES, 'sfx-out.mp4')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobePath: string = require('ffprobe-static').path

function streamTypes(file: string): string {
  return execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]).toString()
}

test.beforeAll(() => {
  mkdirSync(FIXTURES, { recursive: true })
  if (!existsSync(SAMPLE)) {
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

test('전환 효과음: IPC 경로 + UI 지정 + 내보내기 오디오 포함', async () => {
  const app = await electron.launch({ args: [join(ROOT, 'out', 'main', 'index.js')], env: { ...process.env, E2E: '1' } })
  const win = await app.firstWindow()
  win.on('dialog', (d) => void d.accept())
  await win.waitForSelector('[data-testid="import-btn"]')

  // 1) 번들 효과음 경로 IPC (dev 리소스 리졸버 + 파일 존재 필터)
  const sfx = await win.evaluate(() => window.editor.sfxPaths())
  expect(sfx.length).toBeGreaterThanOrEqual(5)
  expect(sfx.map((s) => s.id)).toContain('whoosh')

  // 샘플 임포트 → 2s 에서 분할해 인접 쌍 생성
  await win.evaluate((p) => window.__test!.importFile(p), SAMPLE)
  await win.waitForSelector('[data-testid^="clip-"]')
  await win.evaluate(() => window.__test!.seek(2))
  await win.waitForTimeout(200)
  await win.keyboard.press('c')

  const videoClips = async (): Promise<Array<{ id: string; transitionOut?: { type: string; sound?: { id: string } } }>> => {
    const project = JSON.parse(await win.evaluate(() => window.__test!.getProjectJson()))
    return [...project.tracks.find((t: { kind: string }) => t.kind === 'video').clips].sort(
      (a: { timelineStart: number }, b: { timelineStart: number }) => a.timelineStart - b.timelineStart
    )
  }
  let clips = await videoClips()
  expect(clips).toHaveLength(2)

  // 2) 왼쪽 클립 선택 → 전환 유형 dissolve → 효과음 whoosh
  await win.click(`[data-testid="clip-${clips[0].id}"]`)
  await win.selectOption('[data-testid="transition-type"]', 'dissolve')
  await win.selectOption('[data-testid="transition-sfx"]', 'whoosh')

  clips = await videoClips()
  expect(clips[0].transitionOut?.type).toBe('dissolve')
  expect(clips[0].transitionOut?.sound?.id).toBe('whoosh')

  // ⌘Z: 효과음 지정만 되돌아가고 전환 유형은 남는다
  await win.keyboard.press('Meta+z')
  clips = await videoClips()
  expect(clips[0].transitionOut?.sound).toBeFalsy()
  expect(clips[0].transitionOut?.type).toBe('dissolve')

  // 효과음 다시 지정 후 내보내기
  await win.click(`[data-testid="clip-${clips[0].id}"]`)
  await win.selectOption('[data-testid="transition-sfx"]', 'whoosh')

  // 3) 내보내기 → 오디오 스트림 포함
  const result = await win.evaluate((out) => window.__test!.exportTo(out), OUTPUT)
  expect(result.ok).toBe(true)
  expect(existsSync(OUTPUT)).toBe(true)
  const types = streamTypes(OUTPUT)
  expect(types).toContain('video')
  expect(types).toContain('audio')

  await app.close()
})
