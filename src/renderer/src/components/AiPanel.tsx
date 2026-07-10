/**
 * AI 채팅 패널 (7.1.3 / 7.2.3 / 7.3.3) — 우측 탭의 ✦ AI.
 * 자연어 지시 → Agent SDK(메인) → 편집 도구 실행. 스트리밍 답변·도구 칩·턴 되돌리기·확인 게이트.
 */
import { useEffect, useRef, useState } from 'react'
import { genId } from '@shared/model/factory'
import { summarizeProject } from '@shared/aiSummary'
import { useEditor } from '../state/store'
import { useAi, type ToolChip } from '../ai/aiStore'
import { executeTool } from '../ai/executor'

const TOOL_LABELS: Record<string, string> = {
  get_project_state: '상태 조회',
  seek: '재생위치 이동',
  select_clip: '클립 선택',
  split_clip: '클립 분할',
  trim_clip: '트림',
  move_clip: '클립 이동',
  merge_clip: '컷 병합',
  delete_clip: '클립 삭제',
  add_text: '자막 추가',
  update_text_style: '자막 스타일',
  apply_filter: '색보정',
  add_transition: '화면 전환',
  set_volume_fade: '볼륨/페이드',
  set_transform: '위치/크기',
  auto_captions: '자동 자막',
  remove_silence: '무음 감지',
  apply_silence_cut: '무음 컷 적용',
  add_overlay: '오버레이 추가',
  export_video: '내보내기',
  capture_preview: '화면 캡처'
}

function ChipView({ chip }: { chip: ToolChip }): React.JSX.Element {
  const icon = chip.status === 'running' ? '…' : chip.status === 'ok' ? '✓' : '⚠'
  return (
    <span className={`ai-chip ai-chip--${chip.status}`} title={chip.summary ?? ''}>
      <span className="ai-chip-icon">{icon}</span>
      {TOOL_LABELS[chip.name] ?? chip.name}
    </span>
  )
}

export function AiPanel({ active }: { active: boolean }): React.JSX.Element {
  const auth = useAi((s) => s.auth)
  const messages = useAi((s) => s.messages)
  const running = useAi((s) => s.running)
  const currentRequestId = useAi((s) => s.currentRequestId)
  const pendingConfirm = useAi((s) => s.pendingConfirm)
  const usage = useAi((s) => s.usage)
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // 이벤트/도구 콜백 구독 (마운트 1회 — 탭 전환과 무관하게 계속 수신)
  useEffect(() => {
    void window.editor.aiCheckAuth().then((a) => useAi.getState().setAuth(a))
    const offEvent = window.editor.onAiEvent((requestId, ev) => {
      const st = useAi.getState()
      if (st.currentRequestId && requestId !== st.currentRequestId) return
      if (ev.type === 'assistant') st.appendAssistantText(ev.text)
      else if (ev.type === 'done') st.endAssistant(ev)
    })
    const offTool = window.editor.onAiToolCall(async (ev) => {
      const st = useAi.getState()
      st.addToolChip(ev.callId, ev.name)
      const reply = await executeTool({ name: ev.name, input: ev.input })
      st.updateToolChip(ev.callId, reply.ok ? 'ok' : 'error', reply.message)
      void window.editor.aiToolReply(ev.callId, reply)
    })
    return () => {
      offEvent()
      offTool()
    }
  }, [])

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages])

  useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active])

  const send = (): void => {
    const text = input.trim()
    if (!text || running) return
    const s = useEditor.getState()
    const contextJson = JSON.stringify(
      summarizeProject(s.project, { selectedClipId: s.selectedClipId, selectedClipIds: s.selectedClipIds, playhead: s.playhead })
    )
    const history = useAi
      .getState()
      .messages.slice(-6)
      .map((m) => ({ role: m.role, text: m.text }))
      .filter((h) => h.text)
    const requestId = genId('req')
    useAi.getState().pushUser(text)
    useAi.getState().beginAssistant(requestId)
    setInput('')
    void window.editor.aiSend({ requestId, prompt: text, contextJson, history })
  }

  const stop = (): void => {
    if (currentRequestId) void window.editor.aiCancel(currentRequestId)
  }

  return (
    <div className="ai-panel" data-testid="ai-panel">
      {auth && !auth.loggedIn && (
        <div className="ai-auth-warn" data-testid="ai-auth-warn">
          {auth.detail ?? 'Claude Code 로그인이 필요합니다.'}
        </div>
      )}

      <div className="ai-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="ai-empty">
            <p>편집을 말로 지시하세요.</p>
            <ul>
              <li>&ldquo;2초에서 잘라줘&rdquo;</li>
              <li>&ldquo;시작 부분에 &lsquo;오프닝&rsquo; 자막 넣어줘&rdquo;</li>
              <li>&ldquo;무음 구간 잘라줘&rdquo;</li>
            </ul>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`ai-msg ai-msg--${m.role}`}>
            {m.text && <div className="ai-msg-text">{m.text}</div>}
            {m.streaming && !m.text && <div className="ai-msg-text ai-thinking">생각 중…</div>}
            {m.tools && m.tools.length > 0 && (
              <div className="ai-chips">
                {m.tools.map((c) => (
                  <ChipView key={c.callId} chip={c} />
                ))}
              </div>
            )}
            {m.role === 'assistant' &&
              !m.streaming &&
              m.turnStartRevision !== undefined &&
              m.turnEndRevision !== undefined &&
              m.turnEndRevision > m.turnStartRevision && (
                <button className="ai-undo-turn" onClick={() => useAi.getState().rollbackTurn(m.id)}>
                  ↩ 이 편집 되돌리기
                </button>
              )}
          </div>
        ))}
      </div>

      <div className="ai-input-row">
        <textarea
          ref={inputRef}
          className="ai-input"
          data-testid="ai-input"
          rows={2}
          placeholder={auth?.loggedIn === false ? '로그인 후 사용 가능' : '편집 지시를 입력하세요…'}
          value={input}
          disabled={auth?.loggedIn === false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        {running ? (
          <button className="btn small ai-stop" data-testid="ai-stop" onClick={stop}>
            중단
          </button>
        ) : (
          <button className="btn small primary ai-send" data-testid="ai-send" onClick={send} disabled={!input.trim()}>
            보내기
          </button>
        )}
      </div>

      <div className="ai-footer">
        <span className="ai-auth-badge">
          {auth?.loggedIn
            ? auth.method === 'api-key'
              ? 'API 키 연결됨'
              : '구독 로그인 · 한도 공유'
            : '미로그인'}
        </span>
        {(usage.inputTokens > 0 || usage.costUsd > 0) && (
          <span className="ai-usage" data-testid="ai-usage">
            {(usage.inputTokens + usage.outputTokens).toLocaleString()} 토큰 · ${usage.costUsd.toFixed(3)}
          </span>
        )}
      </div>

      {pendingConfirm && (
        <div className="ai-confirm-overlay" data-testid="ai-confirm">
          <div className={`ai-confirm ${pendingConfirm.privacy ? 'ai-confirm--privacy' : ''}`}>
            <h4>{pendingConfirm.privacy ? '🔒 ' : '⚠ '}{pendingConfirm.title}</h4>
            <p>{pendingConfirm.detail}</p>
            <div className="ai-confirm-actions">
              <button className="btn small" onClick={() => useAi.getState().resolveConfirm(false)}>
                취소
              </button>
              <button
                className="btn small primary"
                data-testid="ai-confirm-ok"
                onClick={() => useAi.getState().resolveConfirm(true)}
              >
                실행
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
