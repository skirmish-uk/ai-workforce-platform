export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  inputPerMillion: number
  /** USD per 1,000,000 output tokens (0 for embedding models). */
  outputPerMillion: number
  /**
   * USD per 1,000,000 input tokens read from the prompt cache. When omitted: 0.1x input for
   * Claude models (Anthropic's standard rate), 0.5x for OpenAI models.
   */
  cacheReadPerMillion?: number
}

/** Anthropic bills 5-minute cache writes at 1.25x the input rate; OpenAI doesn't charge for them. */
const CLAUDE_CACHE_WRITE_MULTIPLIER = 1.25
const CLAUDE_CACHE_READ_MULTIPLIER = 0.1
const OPENAI_CACHE_READ_MULTIPLIER = 0.5

/**
 * USD per 1M tokens. Fetched from claude.com/pricing and
 * developers.openai.com/api/docs/pricing on 2026-09-22 — provider pricing
 * pages change, so re-verify before relying on this for real customer
 * invoicing. Unknown models fall back to `null` from `estimateCostUsd()`
 * rather than guessing a number — this includes every Ollama model
 * (checkSpendCap treats a null cost as $0, which is correct: local Ollama
 * inference has no cloud API charge, only the customer's own hardware).
 */
const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  // Cache reads: Fable 5.1 $0.25 and Opus 5.5 / Sonnet 5.5 $0.20 per MTok (claude-api model
  // reference, 2026-10-13); the rest use Anthropic's standard 0.1x of input.
  'claude-fable-5-1': { inputPerMillion: 10, outputPerMillion: 50, cacheReadPerMillion: 0.25 },
  'claude-opus-5': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-sonnet-5': { inputPerMillion: 2, outputPerMillion: 10 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 1, outputPerMillion: 5 },
  // Current generation, from Anthropic's model table (claude-api reference, cached 2026-10-06).
  'claude-opus-5-5': { inputPerMillion: 4, outputPerMillion: 20, cacheReadPerMillion: 0.2 },
  'claude-sonnet-5-5': { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.2 },
  // Haiku 5.5 is $0.10 / $0.50 for prompts up to 100K tokens ($0.50 / $2.50 beyond); agent
  // prompts here are far below 100K, so the lower tier is used.
  'claude-haiku-5-5': { inputPerMillion: 0.1, outputPerMillion: 0.5 },

  // OpenAI chat models
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  o1: { inputPerMillion: 15, outputPerMillion: 60 },

  // OpenAI embeddings (packages/knowledge) — no output tokens.
  'text-embedding-3-small': { inputPerMillion: 0.02, outputPerMillion: 0 },
  'text-embedding-3-large': { inputPerMillion: 0.13, outputPerMillion: 0 },
  'text-embedding-ada-002': { inputPerMillion: 0.1, outputPerMillion: 0 },
}

export function estimateCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
): number | null {
  const pricing = PRICING[model]
  if (!pricing) return null
  const claude = model.startsWith('claude-')
  const readRate = pricing.cacheReadPerMillion ?? pricing.inputPerMillion * (claude ? CLAUDE_CACHE_READ_MULTIPLIER : OPENAI_CACHE_READ_MULTIPLIER)
  const writeRate = pricing.inputPerMillion * (claude ? CLAUDE_CACHE_WRITE_MULTIPLIER : 1)
  return (
    (usage.inputTokens * pricing.inputPerMillion +
      (usage.cacheReadTokens ?? 0) * readRate +
      (usage.cacheWriteTokens ?? 0) * writeRate +
      usage.outputTokens * pricing.outputPerMillion) /
    1_000_000
  )
}

export function isKnownModel(model: string): boolean {
  return model in PRICING
}
