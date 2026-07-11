/**
 * 타입 안전 IPC 핸들러 등록 (0.1.2, 0.2.3)
 * 채널 이름은 shared/ipc-types.ts 의 EditorApi 와 1:1 대응.
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SFX_LIBRARY } from '../shared/sfx'
import { getFonts } from 'font-list'
import { probeMedia } from './ffmpeg/probe'
import { extractAudioWav, makeCompatProxy, makePerfProxy } from './ffmpeg/proxy'
import { checkAutosave, clearAutosave, openProjectFrom, saveProjectTo, writeAutosave } from './project'
import { audioDone, cancelExport, finishExport, startExport, writeAudioChunk, writeFrame } from './export'
import { cancelTranscribe, transcribe } from './stt'
import { cancelSilenceDetect, detectSilence } from './silence'
import type { ExportStartOptions, SilenceDetectOptions, SttTranscribeOptions } from '../shared/ipc-types'
import type { SttModel } from '../shared/subtitles'

export function registerIpcHandlers(): void {
  ipcMain.handle('app:ping', () => 'pong')

  // 자막 폰트 선택(3.1) — OS 에 설치된 폰트 목록(family 명, 공백 포함 시 따옴표로 이미 감싸져 있어 CSS font 문자열에 그대로 사용 가능)
  ipcMain.handle('app:listFonts', async () => {
    try {
      return await getFonts()
    } catch {
      return []
    }
  })

  ipcMain.handle('media:openDialog', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '미디어', extensions: ['mp4', 'mov', 'mkv', 'webm', 'gif', 'mp3', 'wav', 'aac', 'm4a', 'png', 'jpg', 'jpeg', 'webp', 'bmp'] }
      ]
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('media:probe', (_e, path: string) => probeMedia(path))

  // 번들 전환 효과음(phase-9) 절대경로 — 패키징=process.resourcesPath/sfx (extraResources),
  // dev/비패키징=레포 resources/sfx (main 은 out/main/index.js 이므로 __dirname 에서 두 단계 상위)
  ipcMain.handle('sfx:paths', () => {
    const dir = app.isPackaged ? join(process.resourcesPath, 'sfx') : join(__dirname, '..', '..', 'resources', 'sfx')
    return SFX_LIBRARY.map((s) => ({ id: s.id, path: join(dir, s.file) })).filter((e) => existsSync(e.path))
  })

  ipcMain.handle('media:makeProxy', async (e, path: string, jobId: string) => {
    const probe = await probeMedia(path)
    const sender = e.sender
    const job = makeCompatProxy(
      path,
      probe.durationSec,
      Math.min(60, Math.round(probe.fps ?? 30)),
      (percent) => {
        if (!sender.isDestroyed()) sender.send('media:proxyProgress', { jobId, percent, done: false })
      },
      probe.hdr
    )
    try {
      const proxyPath = await job.promise
      if (!sender.isDestroyed()) sender.send('media:proxyProgress', { jobId, percent: 100, done: true, proxyPath })
      return proxyPath
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!sender.isDestroyed()) sender.send('media:proxyProgress', { jobId, percent: 0, done: true, error: msg })
      throw err
    }
  })

  ipcMain.handle('media:extractAudio', (_e, path: string, sampleRate: number) => extractAudioWav(path, sampleRate))

  // 성능 프록시 (6.2.1): 고해상도 소스 → 720p 편집용. 내보내기는 원본 사용.
  ipcMain.handle('media:makePerfProxy', async (e, path: string, jobId: string) => {
    const probe = await probeMedia(path)
    const sender = e.sender
    const job = makePerfProxy(
      path,
      probe.durationSec,
      Math.min(60, Math.round(probe.fps ?? 30)),
      (percent) => {
        if (!sender.isDestroyed()) sender.send('media:proxyProgress', { jobId, percent, done: false })
      },
      probe.hdr
    )
    const proxyPath = await job.promise
    if (!sender.isDestroyed()) sender.send('media:proxyProgress', { jobId, percent: 100, done: true, proxyPath })
    return proxyPath
  })

  ipcMain.handle('media:fileExists', (_e, path: string) => existsSync(path))

  ipcMain.handle('project:saveDialog', async (e, json: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: 'untitled.gqproj',
      filters: [{ name: '프로젝트', extensions: ['gqproj'] }]
    })
    if (result.canceled || !result.filePath) return null
    await saveProjectTo(result.filePath, json)
    return result.filePath
  })

  ipcMain.handle('project:save', (_e, path: string, json: string) => saveProjectTo(path, json))

  ipcMain.handle('project:openDialog', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: '프로젝트', extensions: ['gqproj'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    return { path, json: await openProjectFrom(path) }
  })

  ipcMain.handle('project:autosave', (_e, json: string, originalPath: string | null) => writeAutosave(json, originalPath))
  ipcMain.handle('project:checkAutosave', () => checkAutosave())
  ipcMain.handle('project:clearAutosave', () => clearAutosave())

  ipcMain.handle('export:saveDialog', async (e, defaultName: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: defaultName,
      filters: [{ name: 'MP4', extensions: ['mp4'] }]
    })
    return result.canceled ? null : (result.filePath ?? null)
  })

  ipcMain.handle('export:start', (_e, opts: ExportStartOptions) => startExport(opts))
  ipcMain.handle('export:audioChunk', (_e, jobId: string, chunk: ArrayBuffer) => writeAudioChunk(jobId, chunk))
  ipcMain.handle('export:audioDone', (_e, jobId: string) => audioDone(jobId))
  ipcMain.handle('export:frame', (_e, jobId: string, frame: ArrayBuffer) => writeFrame(jobId, frame))
  ipcMain.handle('export:finish', (_e, jobId: string) => finishExport(jobId))
  ipcMain.handle('export:cancel', (_e, jobId: string) => cancelExport(jobId))

  // 자동 자막 (3.2)
  ipcMain.handle('stt:transcribe', async (e, opts: SttTranscribeOptions) => {
    const sender = e.sender
    try {
      const segments = await transcribe(
        { ...opts, model: opts.model as SttModel },
        (p) => {
          if (!sender.isDestroyed()) sender.send('stt:progress', { jobId: opts.jobId, ...p })
        }
      )
      return { ok: true, segments }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg }
    }
  })
  ipcMain.handle('stt:cancel', (_e, jobId: string) => cancelTranscribe(jobId))

  // 무음 감지
  ipcMain.handle('silence:detect', async (e, opts: SilenceDetectOptions) => {
    const sender = e.sender
    try {
      const intervals = await detectSilence(opts, (p) => {
        if (!sender.isDestroyed()) sender.send('silence:progress', { jobId: opts.jobId, ...p })
      })
      return { ok: true, intervals }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg }
    }
  })
  ipcMain.handle('silence:cancel', (_e, jobId: string) => cancelSilenceDetect(jobId))

  ipcMain.handle('export:saveSrt', async (e, defaultName: string, content: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: defaultName,
      filters: [{ name: '자막', extensions: ['srt'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, content, 'utf8')
    return result.filePath
  })

  // 자막 SRT 가져오기 (feature-5)
  ipcMain.handle('subtitles:openSrt', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: '자막', extensions: ['srt'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    const content = await readFile(path, 'utf8')
    return { name: path.split(/[/\\]/).pop() ?? 'subtitles.srt', content }
  })
}
