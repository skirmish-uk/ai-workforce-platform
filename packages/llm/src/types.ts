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
  /** Input tokens billed at the full rate (not read from or written to a prompt cache). */
  inputTokens: number
  outputTokens: number
  /** Input tokens served from the provider's prompt cache (billed at a fraction of the input rate). */
  cacheReadTokens?: number
  /** Input tokens written to the prompt cache this call (Anthropic bills them at 1.25x input). */
  cacheWriteTokens?: number
}

/** Every input token of a call, cached or not. */
export function totalInputTokens(usage: LLMUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/**
 * One part of the system prompt. `cache: true` ends a stable prefix (everything up to and
 * including this block is identical between calls), which the client marks for prompt caching.
 * Put request-specific content (retrieved knowledge, the current time) in later blocks.
 */
export interface LLMSystemBlock {
  text: string
  cache?: boolean
}

/** The system prompt as one string, for providers without block-level caching. */
export function systemText(system: string | LLMSystemBlock[] | undefined): string | undefined {
  if (system === undefined || typeof system === 'string') return system
  return system.map((block) => block.text).filter(Boolean).join('\n\n')
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
  system?: string | LLMSystemBlock[]
  messages: LLMMessage[]
  /**
   * Groups requests that share a prompt prefix (e.g. "agent:<id>") so the provider routes them
   * to the same cache. Used by OpenAI (prompt_cache_key); Anthropic caches by prefix alone.
   */
  cacheKey?: string
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
