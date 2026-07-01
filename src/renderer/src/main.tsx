import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// IPC 스모크 (0.1 검증 루프): 앱 시작 시 ping → pong 콘솔 확인
void window.editor.ping().then((r) => console.info(`[ipc] ping → ${r}`))

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
