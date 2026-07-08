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
      applyFilter(type: string, value: number): void
      applyTransition(type: string, duration: number): void
      captureFrame(t: number): Promise<string>
      setSelectedClip(patch: Record<string, unknown>): void
      generateCaptions(model: string, language: string): Promise<number>
      exportTo(path: string): Promise<{ ok: boolean; error?: string; stats?: { frames: number; elapsedMs: number; mbPerSec: number } }>
      detectSilence(noiseDb: number, minDurationSec: number, scope?: 'this-track' | 'all-tracks'): Promise<number>
      toggleSilenceCandidate(id: string): void
      applySilenceCut(): void
      cancelSilencePreview(): void
      getSilencePreviewJson(): string
      aiRunTools(calls: Array<{ name: string; input: Record<string, unknown> }>): Promise<Array<{ ok: boolean; message: string }>>
      aiSendAndWait(prompt: string): Promise<void>
    }
  }
}

export {}
