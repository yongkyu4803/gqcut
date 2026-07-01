/**
 * 최상위 에러 바운더리 — 렌더 오류 시 검정 화면 대신 원인을 표시한다.
 */
import React from 'react'

interface State {
  error: Error | null
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: '#ff8080', fontFamily: 'monospace', userSelect: 'text' }}>
          <h2 style={{ marginBottom: 12 }}>렌더 오류가 발생했습니다</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{this.state.error.stack ?? String(this.state.error)}</pre>
          <button style={{ marginTop: 16, padding: '6px 14px' }} onClick={() => location.reload()}>
            새로고침
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
