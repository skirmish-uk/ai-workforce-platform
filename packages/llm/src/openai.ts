import OpenAI from 'openai'
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions'
import type {
  LLMClient,
  LLMClientConfig,
  LLMCompleteParams,
  LLMMessage,
  LLMResponse,
  LLMStopReason,
  LLMSystemBlock,
  LLMTool,
  LLMToolCall,
} from './types'
import { LLMConfigError, systemText } from './types'

const DEFAULT_MAX_TOKENS = 4096

/** Exported so OllamaLLMClient (an OpenAI-compatible server) can reuse the same conversion. */
export function toOpenAIMessages(system: string | LLMSystemBlock[] | undefined, messages: LLMMessage[]): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []

  // OpenAI caches the longest identical prefix automatically, so the blocks are simply joined
  // in order (stable part first, request-specific part last).
  const systemPrompt = systemText(system)
  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const message of messages) {
    if (message.toolCalls?.length) {
      result.push({
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      })
      continue
    }

    if (message.toolResults?.length) {
      for (const toolResult of message.toolResults) {
        result.push({
          role: 'tool',
          tool_call_id: toolResult.toolCallId,
          content: typeof toolResult.output === 'string' ? toolResult.output : JSON.stringify(toolResult.output ?? null),
        })
      }
      continue
    }

    result.push({ role: message.role, content: message.content ?? '' })
  }

  return result
}

export function toOpenAITools(tools: LLMTool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))
}

export function mapOpenAIStopReason(reason: string | null): LLMStopReason {
  switch (reason) {
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'stop':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

/** Parses an OpenAI-shaped chat completion response — shared with OllamaLLMClient. */
export function parseOpenAIChatCompletion(response: OpenAI.Chat.Completions.ChatCompletion): LLMResponse {
  const choice = response.choices[0]
  const message = choice?.message

  const toolCalls: LLMToolCall[] = (message?.tool_calls ?? [])
    .filter((call): call is Extract<typeof call, { type: 'function' }> => call.type === 'function')
    .map((call) => {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(call.function.arguments || '{}')
      } catch {
        input = {}
      }
      return { id: call.id, name: call.function.name, input }
    })

  return {
    content: message?.content ?? null,
    toolCalls,
    stopReason: mapOpenAIStopReason(choice?.finish_reason ?? null),
    usage: {
      // prompt_tokens includes cached tokens; split them out so they're priced at the cached rate.
      inputTokens: (response.usage?.prompt_tokens ?? 0) - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      outputTokens: response.usage?.completion_tokens ?? 0,
      cacheReadTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    model: response.model,
    raw: response,
  }
}

export class OpenAILLMClient implements LLMClient {
  readonly provider = 'openai' as const
  readonly model: string
  private client: OpenAI
  private defaultMaxTokens: number
  private defaultTemperature?: number

  constructor(model: string, config: LLMClientConfig = {}) {
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new LLMConfigError('OPENAI_API_KEY is not configured. Set it in .env to use the OpenAI provider.')
    }
    this.model = model
    this.client = new OpenAI({ apiKey })
    this.defaultMaxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
    this.defaultTemperature = config.temperature
  }

  async complete(params: LLMCompleteParams): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(params.system, params.messages),
      tools: params.tools?.length ? toOpenAITools(params.tools) : undefined,
      max_completion_tokens: params.maxTokens ?? this.defaultMaxTokens,
      temperature: params.temperature ?? this.defaultTemperature,
      // Routes requests with the same prefix (one agent's runs) to the same prompt cache.
      ...(params.cacheKey ? { prompt_cache_key: params.cacheKey } : {}),
    })

    return parseOpenAIChatCompletion(response)
  }
}
