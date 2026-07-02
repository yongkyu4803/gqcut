/**
 * preload — 화이트리스트 API 만 contextBridge 로 노출 (보안: nodeIntegration off, contextIsolation on)
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { EditorApi, ExportStartOptions, ProxyProgress } from '../shared/ipc-types'

const api: EditorApi = {
  ping: () => ipcRenderer.invoke('app:ping'),
  platform: process.platform,
  isE2E: process.env.E2E === '1',

  openVideoDialog: () => ipcRenderer.invoke('media:openDialog'),
  probe: (path) => ipcRenderer.invoke('media:probe', path),
  makeProxy: (path, jobId) => ipcRenderer.invoke('media:makeProxy', path, jobId),
  makePerfProxy: (path, jobId) => ipcRenderer.invoke('media:makePerfProxy', path, jobId),
  onProxyProgress: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, p: ProxyProgress) => cb(p)
    ipcRenderer.on('media:proxyProgress', listener)
    return () => ipcRenderer.off('media:proxyProgress', listener)
  },
  extractAudio: (path) => ipcRenderer.invoke('media:extractAudio', path, 48000),

  saveProjectDialog: (json) => ipcRenderer.invoke('project:saveDialog', json),
  saveProject: (path, json) => ipcRenderer.invoke('project:save', path, json),
  openProjectDialog: () => ipcRenderer.invoke('project:openDialog'),
  autosave: (json, originalPath) => ipcRenderer.invoke('project:autosave', json, originalPath),
  checkAutosave: () => ipcRenderer.invoke('project:checkAutosave'),
  clearAutosave: () => ipcRenderer.invoke('project:clearAutosave'),

  exportStart: (opts: ExportStartOptions) => ipcRenderer.invoke('export:start', opts),
  exportAudioChunk: (jobId, chunk) => ipcRenderer.invoke('export:audioChunk', jobId, chunk),
  exportAudioDone: (jobId) => ipcRenderer.invoke('export:audioDone', jobId),
  exportFrame: (jobId, frame) => ipcRenderer.invoke('export:frame', jobId, frame),
  exportFinish: (jobId) => ipcRenderer.invoke('export:finish', jobId),
  exportCancel: (jobId) => ipcRenderer.invoke('export:cancel', jobId),
  saveFileDialog: (defaultName) => ipcRenderer.invoke('export:saveDialog', defaultName),

  fileExists: (path) => ipcRenderer.invoke('media:fileExists', path)
}

contextBridge.exposeInMainWorld('editor', api)
// 드래그앤드롭 File → 절대경로 (Electron 32+ 에서 File.path 제거됨)
contextBridge.exposeInMainWorld('electronFilePath', (file: File) => webUtils.getPathForFile(file))
