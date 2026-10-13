import Anthropic from '@anthropic-ai/sdk'
import type {
  LLMClient,
  LLMClientConfig,
  LLMCompleteParams,
  LLMMessage,
  LLMResponse,
  LLMStopReason,
  LLMTool,
  LLMToolCall,
} from './types'
import { LLMConfigError } from './types'

const DEFAULT_MAX_TOKENS = 4096

export function toAnthropicMessages(messages: LLMMessage[], model: string): Anthropic.MessageParam[] {
  return messages.map((message) => {
    // Replay this model's own assistant turn exactly as returned (thinking blocks included).
    if (message.role === 'assistant' && message.providerContent?.provider === 'anthropic' && message.providerContent.model === model) {
      return { role: 'assistant', content: message.providerContent.content as Anthropic.ContentBlockParam[] }
    }
    const blocks: Anthropic.ContentBlockParam[] = []

    if (message.content) {
      blocks.push({ type: 'text', text: message.content })
    }

    for (const toolCall of message.toolCalls ?? []) {
      blocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
      })
    }

    for (const toolResult of message.toolResults ?? []) {
      blocks.push({
        type: 'tool_result',
        tool_use_id: toolResult.toolCallId,
        content: typeof toolResult.output === 'string' ? toolResult.output : JSON.stringify(toolResult.output ?? null),
        is_error: toolResult.isError,
      })
    }

    return { role: message.role, content: blocks }
  })
}

function toAnthropicTools(tools: LLMTool[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }))
}

function mapStopReason(reason: Anthropic.Message['stop_reason']): LLMStopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    case 'stop_sequence':
      return 'stop_sequence'
    case 'end_turn':
    default:
      return 'end_turn'
  }
}

/**
 * Whether a model accepts sampling parameters (temperature/top_p/top_k). They are removed
 * on Claude Opus 4.7+ / Sonnet 5+ / Fable and rejected with a 400 ("`temperature` is
 * deprecated for this model"); Sonnet 5.5 / Haiku 5.5 reject non-default values. Only
 * older models known to accept them get one, so a new model never fails on it.
 */
export function supportsSamplingParams(model: string): boolean {
  // Family followed by end of id or a date snapshot (so "opus-4" never matches "opus-4-7").
  return /^claude-(3|3-5|3-7|haiku-4-5|sonnet-4|sonnet-4-5|sonnet-4-6|opus-4|opus-4-1|opus-4-5|opus-4-6)(-\d{8}|$)/.test(model) ||
    /^claude-3-(5-)?(haiku|sonnet|opus)/.test(model)
}

export class AnthropicLLMClient implements LLMClient {
  readonly provider = 'anthropic' as const
  readonly model: string
  private client: Anthropic
  private defaultMaxTokens: number
  private defaultTemperature?: number

  constructor(model: string, config: LLMClientConfig = {}) {
    const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      throw new LLMConfigError('ANTHROPIC_API_KEY is not configured. Set it in .env to use the Anthropic provider.')
    }
    this.model = model
    this.client = new Anthropic({ apiKey })
    this.defaultMaxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
    this.defaultTemperature = config.temperature
  }

  async complete(params: LLMCompleteParams): Promise<LLMResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      system: params.system,
      messages: toAnthropicMessages(params.messages, this.model),
      tools: params.tools?.length ? toAnthropicTools(params.tools) : undefined,
      max_tokens: params.maxTokens ?? this.defaultMaxTokens,
      ...(supportsSamplingParams(this.model) ? { temperature: params.temperature ?? this.defaultTemperature } : {}),
    })

    let content: string | null = null
    const toolCalls: LLMToolCall[] = []

    for (const block of response.content) {
      if (block.type === 'text') {
        content = (content ?? '') + block.text
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        })
      }
    }

    return {
      content,
      toolCalls,
      stopReason: mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      model: response.model,
      raw: response,
      providerContent: { provider: 'anthropic', model: this.model, content: response.content },
    }
  }
}
