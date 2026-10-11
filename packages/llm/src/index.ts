import { AnthropicLLMClient } from './anthropic'
import { OpenAILLMClient } from './openai'
import { OllamaLLMClient } from './ollama'
import type { LLMClient, LLMClientConfig, LLMProvider } from './types'

export * from './types'
export * from './pricing'
export { AnthropicLLMClient } from './anthropic'
export { OpenAILLMClient } from './openai'
export { OllamaLLMClient } from './ollama'

/**
 * Factory that returns a provider-agnostic LLM client. `provider` and `model`
 * normally come straight from `Agent.modelProvider` / `Agent.modelName`.
 * "ollama" runs entirely against a local/self-hosted Ollama server — no
 * conversation data leaves the customer's infrastructure.
 */
export function createLLMClient(
  provider: string,
  model: string,
  config: LLMClientConfig = {}
): LLMClient {
  const normalized = provider.toLowerCase() as LLMProvider

  switch (normalized) {
    case 'anthropic':
      return new AnthropicLLMClient(model, config)
    case 'openai':
      return new OpenAILLMClient(model, config)
    case 'ollama':
      return new OllamaLLMClient(model, config)
    default:
      throw new Error(`Unsupported model provider: "${provider}". Expected "anthropic", "openai", or "ollama".`)
  }
}
