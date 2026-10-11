export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  inputPerMillion: number
  /** USD per 1,000,000 output tokens (0 for embedding models). */
  outputPerMillion: number
}

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
  'claude-fable-5-1': { inputPerMillion: 10, outputPerMillion: 50 },
  'claude-opus-5': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-sonnet-5': { inputPerMillion: 2, outputPerMillion: 10 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 1, outputPerMillion: 5 },

  // OpenAI chat models
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  o1: { inputPerMillion: 15, outputPerMillion: 60 },

  // OpenAI embeddings (packages/knowledge) — no output tokens.
  'text-embedding-3-small': { inputPerMillion: 0.02, outputPerMillion: 0 },
  'text-embedding-3-large': { inputPerMillion: 0.13, outputPerMillion: 0 },
  'text-embedding-ada-002': { inputPerMillion: 0.1, outputPerMillion: 0 },
}

export function estimateCostUsd(model: string, usage: { inputTokens: number; outputTokens: number }): number | null {
  const pricing = PRICING[model]
  if (!pricing) return null
  return (usage.inputTokens / 1_000_000) * pricing.inputPerMillion + (usage.outputTokens / 1_000_000) * pricing.outputPerMillion
}

export function isKnownModel(model: string): boolean {
  return model in PRICING
}
