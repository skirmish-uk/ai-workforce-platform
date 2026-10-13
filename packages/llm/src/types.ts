export type LLMProvider = 'anthropic' | 'openai' | 'ollama'

export type LLMMessageRole = 'user' | 'assistant'

/**
 * A single tool invocation requested by the model.
 */
export interface LLMToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

/**
 * The result of executing a tool call, fed back to the model on the next turn.
 */
export interface LLMToolResult {
  toolCallId: string
  name: string
  output: unknown
  isError?: boolean
}

/**
 * Provider-agnostic conversation message. A single "turn" can carry text,
 * tool calls (assistant asking to invoke tools), and/or tool results
 * (results of previously requested tool calls).
 */
export interface LLMMessage {
  role: LLMMessageRole
  content?: string
  toolCalls?: LLMToolCall[]
  toolResults?: LLMToolResult[]
  /**
   * The provider's own content for an assistant turn (e.g. Anthropic content blocks,
   * including thinking blocks), replayed unchanged on the next request. Newer Claude
   * models reject a conversation whose earlier assistant turns were rebuilt or edited.
   */
  providerContent?: { provider: LLMProvider; model: string; content: unknown }
}

/**
 * A tool definition exposed to the model, using JSON Schema for the input shape.
 */
export interface LLMTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type LLMStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error'

export interface LLMUsage {
  inputTokens: number
  outputTokens: number
}

export interface LLMResponse {
  content: string | null
  toolCalls: LLMToolCall[]
  stopReason: LLMStopReason
  usage: LLMUsage
  model: string
  raw?: unknown
  /** See LLMMessage.providerContent: pass it on the assistant message that records this response. */
  providerContent?: LLMMessage['providerContent']
}

export interface LLMCompleteParams {
  system?: string
  messages: LLMMessage[]
  tools?: LLMTool[]
  maxTokens?: number
  temperature?: number
}

export interface LLMClientConfig {
  apiKey?: string
  maxTokens?: number
  temperature?: number
  /** Overrides the provider's default API host — how OllamaLLMClient points at a local/self-hosted server. */
  baseUrl?: string
}

export interface LLMClient {
  readonly provider: LLMProvider
  readonly model: string
  complete(params: LLMCompleteParams): Promise<LLMResponse>
}

export class LLMConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LLMConfigError'
  }
}
