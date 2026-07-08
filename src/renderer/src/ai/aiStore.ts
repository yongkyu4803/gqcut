/**
 * AI 어시스턴트 UI 상태 (phase-7) — 채팅 메시지·실행 상태·확인 게이트·사용량.
 * 편집 히스토리는 useEditor 가 소유하고, 여기서는 대화/UX 상태만 다룬다.
 *
 * 확인 게이트(7.3): 파괴적/프라이버시 도구는 executor 가 requestConfirm() 으로
 * 이 스토어에 대기 상태를 만들고, UI 의 [실행]/[취소] 가 resolveConfirm() 으로 응답한다.
 */
import { create } from 'zustand'
import { genId } from '@shared/model/factory'
import type { AiAuthStatus } from '@shared/ipc-types'
import { useEditor } from '../state/store'
import { playback } from '../engine/playback'

export type ToolChipStatus = 'running' | 'ok' | 'error'

export interface ToolChip {
  callId: string
  name: string
  status: ToolChipStatus
  summary?: string
}

export interface AiMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  tools?: ToolChip[]
  /** 이 어시스턴트 턴 시작/종료 시점의 히스토리 길이 — 턴 단위 되돌리기용 (7.2.3) */
  turnStartRevision?: number
  turnEndRevision?: number
}

export interface PendingConfirm {
  id: string
  title: string
  detail: string
  /** 프라이버시 옵트인(비전 캡처)인지 — UI 문구 분기 */
  privacy?: boolean
  resolve: (ok: boolean) => void
}

export interface AiUsage {
  costUsd: number
  inputTokens: number
  outputTokens: number
}

interface AiState {
  auth: AiAuthStatus | null
  messages: AiMessage[]
  running: boolean
  currentRequestId: string | null
  activeAssistantId: string | null
  pendingConfirm: PendingConfirm | null
  usage: AiUsage
  visionOptIn: boolean

  setAuth(a: AiAuthStatus): void
  pushUser(text: string): void
  beginAssistant(requestId: string): string
  appendAssistantText(text: string): void
  addToolChip(callId: string, name: string): void
  updateToolChip(callId: string, status: ToolChipStatus, summary?: string): void
  endAssistant(result: { ok: boolean; error?: string; usage?: { inputTokens: number; outputTokens: number }; costUsd?: number }): void
  requestConfirm(title: string, detail: string, privacy?: boolean): Promise<boolean>
  resolveConfirm(ok: boolean): void
  rollbackTurn(messageId: string): void
  setVisionOptIn(v: boolean): void
  clear(): void
}

export const useAi = create<AiState>((set, get) => ({
  auth: null,
  messages: [],
  running: false,
  currentRequestId: null,
  activeAssistantId: null,
  pendingConfirm: null,
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
  visionOptIn: false,

  setAuth: (auth) => set({ auth }),

  pushUser: (text) => set((s) => ({ messages: [...s.messages, { id: genId('msg'), role: 'user', text }] })),

  beginAssistant: (requestId) => {
    const id = genId('msg')
    set((s) => ({
      running: true,
      currentRequestId: requestId,
      activeAssistantId: id,
      messages: [
        ...s.messages,
        { id, role: 'assistant', text: '', streaming: true, tools: [], turnStartRevision: useEditor.getState().past.length }
      ]
    }))
    return id
  },

  appendAssistantText: (text) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === s.activeAssistantId ? { ...m, text: m.text + text } : m))
    })),

  addToolChip: (callId, name) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === s.activeAssistantId ? { ...m, tools: [...(m.tools ?? []), { callId, name, status: 'running' }] } : m
      )
    })),

  updateToolChip: (callId, status, summary) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === s.activeAssistantId
          ? { ...m, tools: (m.tools ?? []).map((c) => (c.callId === callId ? { ...c, status, summary } : c)) }
          : m
      )
    })),

  endAssistant: (result) =>
    set((s) => {
      const usage = result.usage
        ? {
            costUsd: s.usage.costUsd + (result.costUsd ?? 0),
            inputTokens: s.usage.inputTokens + result.usage.inputTokens,
            outputTokens: s.usage.outputTokens + result.usage.outputTokens
          }
        : s.usage
      return {
        running: false,
        currentRequestId: null,
        usage,
        messages: s.messages.map((m) =>
          m.id === s.activeAssistantId
            ? {
                ...m,
                streaming: false,
                turnEndRevision: useEditor.getState().past.length,
                text: m.text || (result.ok ? m.text : `⚠️ ${result.error ?? '오류가 발생했습니다.'}`)
              }
            : m
        ),
        activeAssistantId: null
      }
    }),

  requestConfirm: (title, detail, privacy) =>
    new Promise<boolean>((resolve) => {
      set({ pendingConfirm: { id: genId('cf'), title, detail, privacy, resolve } })
    }),

  resolveConfirm: (ok) => {
    const pc = get().pendingConfirm
    if (pc) pc.resolve(ok)
    set({ pendingConfirm: null })
  },

  rollbackTurn: (messageId) => {
    const m = get().messages.find((x) => x.id === messageId)
    if (!m || m.turnStartRevision === undefined || m.turnEndRevision === undefined) return
    const steps = m.turnEndRevision - m.turnStartRevision
    for (let i = 0; i < steps; i++) useEditor.getState().undo()
    if (steps > 0) playback.refresh()
  },

  setVisionOptIn: (visionOptIn) => set({ visionOptIn }),

  clear: () => set({ messages: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 }, activeAssistantId: null })
}))
