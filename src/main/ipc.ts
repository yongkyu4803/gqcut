/**
 * 타입 안전 IPC 핸들러 등록 (0.1.2, 0.2.3)
 * 채널 이름은 shared/ipc-types.ts 의 EditorApi 와 1:1 대응.
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { probeMedia } from './ffmpeg/probe'
import { extractAudioWav, makeCompatProxy } from './ffmpeg/proxy'
import { cancelExport, finishExport, startExport, writeFrame } from './export'
import type { ExportStartOptions } from '../shared/ipc-types'

export function registerIpcHandlers(): void {
  ipcMain.handle('app:ping', () => 'pong')

  ipcMain.handle('media:openDialog', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '미디어', extensions: ['mp4', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'aac', 'm4a', 'png', 'jpg', 'jpeg'] }
      ]
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('media:probe', (_e, path: string) => probeMedia(path))

  ipcMain.handle('media:makeProxy', async (e, path: string, jobId: string) => {
    const probe = await probeMedia(path)
    const sender = e.sender
    const job = makeCompatProxy(path, probe.durationSec, Math.min(60, Math.round(probe.fps ?? 30)), (percent) => {
      if (!sender.isDestroyed()) sender.send('media:proxyProgress', { jobId, percent, done: false })
    })
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

  ipcMain.handle('media:fileExists', (_e, path: string) => existsSync(path))

  ipcMain.handle('project:saveDialog', async (e, json: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: 'untitled.gqproj',
      filters: [{ name: '프로젝트', extensions: ['gqproj'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, json, 'utf8')
    return result.filePath
  })

  ipcMain.handle('project:openDialog', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: '프로젝트', extensions: ['gqproj'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    return { path, json: await readFile(path, 'utf8') }
  })

  ipcMain.handle('export:saveDialog', async (e, defaultName: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: defaultName,
      filters: [{ name: 'MP4', extensions: ['mp4'] }]
    })
    return result.canceled ? null : (result.filePath ?? null)
  })

  ipcMain.handle('export:start', (_e, opts: ExportStartOptions) => startExport(opts))
  ipcMain.handle('export:frame', (_e, jobId: string, frame: ArrayBuffer) => writeFrame(jobId, frame))
  ipcMain.handle('export:finish', (_e, jobId: string) => finishExport(jobId))
  ipcMain.handle('export:cancel', (_e, jobId: string) => cancelExport(jobId))
}
