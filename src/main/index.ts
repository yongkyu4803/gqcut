import { app, BrowserWindow, protocol, net } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpcHandlers } from './ipc'
import { registerAiHandlers } from './ai'

// ── 크래시 로깅 (6.2.3) — userData/logs/crash.log 에 기록 ──
function crashLog(kind: string, detail: string): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'crash.log'), `[${new Date().toISOString()}] ${kind}\n${detail}\n\n`)
  } catch {
    /* 로깅 실패는 무시 */
  }
}

process.on('uncaughtException', (e) => {
  crashLog('main:uncaughtException', e.stack ?? String(e))
  console.error(e)
})
process.on('unhandledRejection', (reason) => {
  crashLog('main:unhandledRejection', reason instanceof Error ? (reason.stack ?? String(reason)) : String(reason))
})

// media:// 커스텀 프로토콜 — 렌더러가 로컬 미디어 파일을 fetch 로 스트리밍 (contextIsolation 유지)
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { stream: true, bypassCSP: true, supportFetchAPI: true } }
])

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#141417',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // 렌더러 프로세스 사망 감지 (6.2.3) — 로그 후 재로드 제안
  win.webContents.on('render-process-gone', (_e, details) => {
    crashLog('renderer:gone', JSON.stringify(details))
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) win.webContents.reload()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  // media:///absolute/path 형태의 URL 을 로컬 파일 스트림으로 응답
  protocol.handle('media', (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname)
    return net.fetch(pathToFileURL(filePath).toString(), {
      headers: request.headers
    })
  })

  registerIpcHandlers()
  registerAiHandlers()
  createWindow()

  // 메모리 감시 (6.2.4): RSS 상한 초과 시 경고 로그 (캐시 상한은 렌더러 LRU 가 담당)
  const MEMORY_WARN_BYTES = 3 * 1024 * 1024 * 1024
  setInterval(() => {
    const { rss } = process.memoryUsage()
    if (rss > MEMORY_WARN_BYTES) crashLog('memory:warn', `main RSS ${(rss / 1e9).toFixed(2)}GB`)
  }, 60_000)

  // 자동 업데이트 (6.3.3): 패키징 빌드에서만. 게시 채널은 electron-builder.yml 의 publish 설정.
  if (app.isPackaged) {
    void import('electron-updater')
      .then(({ autoUpdater }) => {
        autoUpdater.logger = { info: () => {}, warn: () => {}, error: (m: unknown) => crashLog('updater:error', String(m)), debug: () => {} }
        void autoUpdater.checkForUpdatesAndNotify()
      })
      .catch(() => {})
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || process.env.E2E) app.quit()
})
