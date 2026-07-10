import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { applyTheme, getStoredTheme } from './theme'
import './styles.css'

// 저장된 테마를 첫 페인트 전에 적용 (깜빡임 방지)
applyTheme(getStoredTheme())

// IPC 스모크 (0.1 검증 루프): 앱 시작 시 ping → pong 콘솔 확인
void window.editor.ping().then((r) => console.info(`[ipc] ping → ${r}`))

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
