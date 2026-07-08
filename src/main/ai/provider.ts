/**
 * AI 프로바이더 추상화 (7.1.1) — 백엔드 교체 가능하도록.
 * v1: AgentSdkProvider — @anthropic-ai/claude-agent-sdk 를 메인에서 실행하고
 *     이 머신의 Claude Code 로그인(구독)을 상속한다(API 키 불필요, 구독 한도 공유).
 *     직접 OAuth 토큰 재사용은 ToS 위반이라 SDK 에 인증을 위임한다.
 * 추후: 배포용 ApiKeyProvider(ANTHROPIC_API_KEY) 를 같은 인터페이스로 추가.
 *
 * 커맨드 레이어는 인프로세스 커스텀 도구(createSdkMcpServer+tool)로 노출하고, 실제 실행은
 * executeTool 콜백(IPC→렌더러 executor)에 위임한다. 에이전트 루프는 SDK 가 소유(maxTurns 캡).
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AI_TOOLS, AI_TOOL_NAMES } from '@shared/aiTools'
import type { AiAuthStatus, AiToolReply } from '@shared/ipc-types'

export interface ProviderRunRequest {
  prompt: string
  contextJson: string
  history?: Array<{ role: 'user' | 'assistant'; text: string }>
  signal: AbortSignal
  /** 도구 실행을 렌더러로 위임 (IPC 왕복) */
  executeTool: (name: string, input: Record<string, unknown>) => Promise<AiToolReply>
  /** 어시스턴트 텍스트 스트림 */
  onAssistantText: (text: string) => void
}

export interface ProviderRunResult {
  ok: boolean
  error?: string
  usage?: { inputTokens: number; outputTokens: number }
  costUsd?: number
}

export interface AiProvider {
  readonly id: string
  detectAuth(): Promise<AiAuthStatus>
  run(req: ProviderRunRequest): Promise<ProviderRunResult>
}

const SYSTEM_PROMPT = `당신은 데스크톱 영상 편집기 "GQCut" 에 내장된 편집 어시스턴트입니다.
사용자의 한국어 지시를 받아 제공된 도구로 타임라인을 실제로 편집합니다.

원칙:
- 반드시 도구로만 편집한다. 파일시스템·셸·네트워크 접근 권한은 없다.
- 매 지시마다 현재 프로젝트 상태(JSON)가 함께 주어진다. 클립 id·시간은 그 상태를 신뢰한다. 확실치 않으면 get_project_state 로 다시 확인한다.
- 시간 단위는 초. 프레임 스냅·겹침 회피·불변식은 편집 커맨드가 알아서 처리하므로 대략적인 초 값이면 된다.
- 도구가 한국어 에러를 반환하면 원인을 읽고 스스로 값을 고쳐 다시 시도한다(예: 범위를 벗어난 시각, 없는 id).
- 삭제·무음컷·내보내기·화면캡처는 사용자 확인 게이트를 거친다. 사용자가 취소하면 존중하고 대안을 제안한다.
- 지시가 모호하면 한 번만 짧게 되묻고, 합리적으로 실행 가능하면 실행 후 무엇을 했는지 한 문장으로 알린다.
- 답변은 한국어로 간결하게. 완료 후에는 결과를 먼저 말한다.`

function buildPrompt(req: ProviderRunRequest): string {
  const parts = ['## 현재 프로젝트 상태(JSON)', req.contextJson]
  if (req.history && req.history.length > 0) {
    parts.push('## 최근 대화', req.history.map((h) => `${h.role === 'user' ? '사용자' : 'AI'}: ${h.text}`).join('\n'))
  }
  parts.push('## 사용자 지시', req.prompt)
  return parts.join('\n\n')
}

/** dataURL(data:image/png;base64,....) → MCP 이미지 블록 인자 */
function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl)
  return m ? { mimeType: m[1], data: m[2] } : null
}

export class AgentSdkProvider implements AiProvider {
  readonly id = 'agent-sdk'

  async detectAuth(): Promise<AiAuthStatus> {
    if (process.env.ANTHROPIC_API_KEY) return { loggedIn: true, method: 'api-key' }
    if (process.platform === 'darwin') {
      try {
        // 존재 여부만 확인(-w 없이) — 비밀번호를 읽지 않으므로 Keychain 접근 프롬프트가 뜨지 않는다
        execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { stdio: 'ignore' })
        return { loggedIn: true, method: 'subscription' }
      } catch {
        /* not found */
      }
    } else if (existsSync(join(homedir(), '.claude', '.credentials.json'))) {
      return { loggedIn: true, method: 'subscription' }
    }
    return {
      loggedIn: false,
      method: 'none',
      detail: 'Claude Code 로그인이 필요합니다. 터미널에서 `claude` 실행 후 로그인하면 구독으로 동작합니다.'
    }
  }

  async run(req: ProviderRunRequest): Promise<ProviderRunResult> {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const { query, tool, createSdkMcpServer } = sdk

    const tools = AI_TOOLS.map((spec) =>
      tool(spec.name, spec.description, spec.shape, async (args: Record<string, unknown>) => {
        const reply = await req.executeTool(spec.name, args ?? {})
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
        if (reply.imageDataUrl) {
          const img = parseDataUrl(reply.imageDataUrl)
          if (img) content.push({ type: 'image', data: img.data, mimeType: img.mimeType })
        }
        content.push({ type: 'text', text: reply.message })
        return { content, isError: !reply.ok }
      })
    )

    const server = createSdkMcpServer({ name: 'gqcut', version: '1.0.0', tools })

    const ac = new AbortController()
    if (req.signal.aborted) ac.abort()
    else req.signal.addEventListener('abort', () => ac.abort(), { once: true })

    let usage: ProviderRunResult['usage']
    let costUsd = 0

    try {
      const q = query({
        prompt: buildPrompt(req),
        options: {
          abortController: ac,
          systemPrompt: SYSTEM_PROMPT,
          mcpServers: { gqcut: server },
          // 이름 나열 시 canUseTool 보다 먼저 자동 승인 → SDK 레벨 권한 프롬프트로 멈추지 않음.
          // 실제 사용자 확인(파괴적/프라이버시)은 렌더러 executor 가 별도 게이트로 처리한다.
          allowedTools: AI_TOOL_NAMES.map((n) => `mcp__gqcut__${n}`),
          tools: [], // 내장 Claude Code 도구 전면 비활성 — AI 는 우리 편집 도구만 만진다
          settingSources: [], // 사용자/프로젝트 설정·CLAUDE.md 무시(격리)
          maxTurns: 12,
          includePartialMessages: false
        }
      })

      for await (const msg of q) {
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) req.onAssistantText(block.text)
          }
        } else if (msg.type === 'result') {
          const u = msg.usage
          usage = {
            inputTokens:
              (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
            outputTokens: u.output_tokens ?? 0
          }
          costUsd = msg.total_cost_usd ?? 0
          if (msg.subtype !== 'success') {
            return { ok: false, error: `실행이 완료되지 못했습니다 (${msg.subtype}).`, usage, costUsd }
          }
        }
      }
      return { ok: true, usage, costUsd }
    } catch (e) {
      if (ac.signal.aborted) return { ok: true, usage, costUsd } // 사용자 취소 — 오류 아님
      const message = e instanceof Error ? e.message : String(e)
      return { ok: false, error: message, usage, costUsd }
    }
  }
}

let cached: AiProvider | null = null
export function getProvider(): AiProvider {
  if (!cached) cached = new AgentSdkProvider()
  return cached
}
