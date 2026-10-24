import OpenAI from 'openai'
import type { LLMClient, LLMClientConfig, LLMCompleteParams, LLMResponse } from './types'
import { parseOpenAIChatCompletion, toOpenAIMessages, toOpenAITools } from './openai'

const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_BASE_URL = 'http://localhost:11434/v1'

/**
 * Ollama exposes an OpenAI-compatible `/v1` endpoint, so this reuses the same
 * message/tool conversion and response parsing as OpenAILLMClient — just
 * pointed at a local (or self-hosted) Ollama server instead of
 * api.openai.com. No API key is required (Ollama ignores it), so a
 * placeholder is used unless OLLAMA_API_KEY is set (e.g. a self-hosted
 * Ollama behind an auth proxy).
 *
 * This is the "data never leaves our infrastructure" option: point an
 * agent's Agent.modelProvider at "ollama" (with Agent.modelName set to
 * whatever model is pulled, e.g. "llama3.1") and no conversation content
 * goes to Anthropic or OpenAI. Tool-calling reliability with local models
 * varies a lot by model — verify it against a specific skill before relying
 * on it for tool-heavy agents.
 */
export class OllamaLLMClient implements LLMClient {
  readonly provider = 'ollama' as const
  readonly model: string
  private client: OpenAI
  private defaultMaxTokens: number
  private defaultTemperature?: number

  constructor(model: string, config: LLMClientConfig = {}) {
    this.model = model
    this.client = new OpenAI({
      apiKey: config.apiKey ?? process.env.OLLAMA_API_KEY ?? 'ollama',
      baseURL: config.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL,
    })
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
    })

    return parseOpenAIChatCompletion(response)
  }
}
