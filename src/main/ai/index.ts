/**
 * AI 어시스턴트 IPC 브리지 (7.1.2) — 스트리밍/도구 콜백 중계 + 중단.
 *
 * 흐름:
 *   renderer aiSend ──▶ provider.run() (메인, Agent SDK)
 *        모델이 도구 호출 → provider executeTool ──ai:toolCall──▶ renderer executor
 *        renderer ──aiToolReply(callId)──▶ 메인이 대기 중인 Promise resolve → 모델로 결과 반환
 *        어시스턴트 텍스트 ──ai:event(assistant)──▶ renderer
 *   완료/에러/중단 ──ai:event(done)──▶ renderer
 */
import { ipcMain } from 'electron'
import { genId } from '@shared/model/factory'
import type { AiSendOptions, AiStreamEvent, AiToolCallEvent, AiToolReply } from '@shared/ipc-types'
import { getProvider } from './provider'

/** callId → 렌더러 응답을 기다리는 resolver */
const pendingTool = new Map<string, (r: AiToolReply) => void>()
/** requestId → 실행 취소 컨트롤러 */
const activeRuns = new Map<string, AbortController>()

export function registerAiHandlers(): void {
  ipcMain.handle('ai:checkAuth', () => getProvider().detectAuth())

  ipcMain.handle('ai:toolReply', (_e, callId: string, reply: AiToolReply) => {
    const resolve = pendingTool.get(callId)
    if (resolve) {
      pendingTool.delete(callId)
      resolve(reply)
    }
  })

  ipcMain.handle('ai:cancel', (_e, requestId: string) => {
    activeRuns.get(requestId)?.abort()
  })

  ipcMain.handle('ai:send', async (e, opts: AiSendOptions) => {
    const sender = e.sender
    const { requestId } = opts
    const ac = new AbortController()
    activeRuns.set(requestId, ac)

    const send = (ev: AiStreamEvent): void => {
      if (!sender.isDestroyed()) sender.send('ai:event', requestId, ev)
    }

    const executeTool = (name: string, input: Record<string, unknown>): Promise<AiToolReply> =>
      new Promise<AiToolReply>((resolve) => {
        if (sender.isDestroyed()) {
          resolve({ ok: false, message: '창이 닫혀 실행할 수 없습니다.' })
          return
        }
        const callId = genId('call')
        pendingTool.set(callId, resolve)
        // 실행 중단 시 매달린 도구 호출을 정리(모델 루프가 멈추도록 에러 반환)
        ac.signal.addEventListener(
          'abort',
          () => {
            if (pendingTool.has(callId)) {
              pendingTool.delete(callId)
              resolve({ ok: false, message: '사용자가 중단했습니다.' })
            }
          },
          { once: true }
        )
        const ev: AiToolCallEvent = { requestId, callId, name, input }
        sender.send('ai:toolCall', ev)
      })

    try {
      const result = await getProvider().run({
        prompt: opts.prompt,
        contextJson: opts.contextJson,
        history: opts.history,
        signal: ac.signal,
        executeTool,
        onAssistantText: (text) => send({ type: 'assistant', text })
      })
      send({ type: 'done', ok: result.ok, error: result.error, usage: result.usage, costUsd: result.costUsd })
    } catch (err) {
      send({ type: 'done', ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      activeRuns.delete(requestId)
    }
  })
}
