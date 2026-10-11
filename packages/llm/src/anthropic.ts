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

function toAnthropicMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
  return messages.map((message) => {
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
      messages: toAnthropicMessages(params.messages),
      tools: params.tools?.length ? toAnthropicTools(params.tools) : undefined,
      max_tokens: params.maxTokens ?? this.defaultMaxTokens,
      temperature: params.temperature ?? this.defaultTemperature,
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
    }
  }
}
