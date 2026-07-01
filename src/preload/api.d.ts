import type { EditorApi } from '../shared/ipc-types'

declare global {
  interface Window {
    editor: EditorApi
    electronFilePath?: (file: File) => string
    /** e2e 테스트 훅 (E2E 환경에서만 주입) */
    __test?: {
      importFile(path: string): Promise<string>
      splitAtPlayhead(): void
      seek(t: number): void
      getProjectJson(): string
      exportTo(path: string): Promise<{ ok: boolean; error?: string; stats?: { frames: number; elapsedMs: number; mbPerSec: number } }>
    }
  }
}

export {}
