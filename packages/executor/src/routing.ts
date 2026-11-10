import { createLLMClient, LLMConfigError, type LLMClient, type LLMClientConfig, type LLMCompleteParams, type LLMResponse } from '@ai-workforce/llm'
import { safeErrorMessage } from '@ai-workforce/domain'
import type { AgentContract, ModelRef, ModelTier } from './contract'

export interface ModelCandidate extends ModelRef {
  role: 'primary' | 'tier' | 'fallback'
}

/**
 * Ordered list of models a run may use: the tier-specific model (when the
 * caller asked for a tier the contract defines) or the agent's primary model,
 * then the contract's fallbacks. Model IDs come only from configuration.
 * Under privacy=local_only, cloud providers are removed even if configured.
 */
export function selectModelCandidates(
  agent: { modelProvider: string; modelName: string },
  contract: AgentContract,
  tier?: ModelTier
): ModelCandidate[] {
  const tierRef = tier ? contract.model.tiers?.[tier] : undefined
  const first: ModelCandidate = tierRef
    ? { ...tierRef, role: 'tier' }
    : { provider: agent.modelProvider.toLowerCase() as ModelRef['provider'], model: agent.modelName, role: 'primary' }

  const all: ModelCandidate[] = [first, ...contract.model.fallbacks.map((ref) => ({ ...ref, role: 'fallback' as const }))]
  const seen = new Set<string>()
  return all.filter((candidate) => {
    const key = `${candidate.provider}/${candidate.model}`
    if (seen.has(key)) return false
    seen.add(key)
    return contract.model.privacy !== 'local_only' || candidate.provider === 'ollama'
  })
}

const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])
const FATAL_STATUS = new Set([400, 404, 413, 422])

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status
  return typeof status === 'number' ? status : undefined
}

/** Rate limits, overload, 5xx and network failures: worth retrying with backoff. */
export function isTransientLLMError(error: unknown): boolean {
  const status = statusOf(error)
  if (status !== undefined) return TRANSIENT_STATUS.has(status)
  const text = `${(error as Error)?.name ?? ''} ${(error as Error)?.message ?? ''}`
  return /APIConnection|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|timed? ?out|overloaded/i.test(text)
}

/** Requests that are wrong in themselves; another provider won't fix them, so don't mask the bug. */
export function isFatalLLMError(error: unknown): boolean {
  const status = statusOf(error)
  return status !== undefined && FATAL_STATUS.has(status)
}

export class ModelUnavailableError extends Error {
  constructor(public readonly attempts: ModelAttempt[]) {
    super(`No configured model could serve the request (${attempts.map((a) => `${a.provider}/${a.model}: ${a.error}`).join('; ')})`)
    this.name = 'ModelUnavailableError'
  }
}

export interface ModelAttempt {
  provider: string
  model: string
  role: ModelCandidate['role']
  ok: boolean
  error?: string
  latencyMs: number
}

export interface CompleteWithFallbackDeps {
  createClient?: (provider: string, model: string, config: LLMClientConfig) => LLMClient
  sleep?: (ms: number) => Promise<void>
}

export function backoffMs(attempt: number, baseMs = 500, capMs = 8_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt)
  return Math.round(exp / 2 + Math.random() * (exp / 2))
}

/**
 * Calls the first available candidate. Transient errors are retried with
 * exponential backoff up to `maxRetries`; a candidate that stays unavailable
 * (or has no API key configured) hands over to the next one. Fatal request
 * errors are thrown immediately rather than silently re-tried elsewhere.
 */
export async function completeWithFallback(params: {
  candidates: ModelCandidate[]
  request: LLMCompleteParams
  modelConfig: LLMClientConfig
  maxRetries: number
  deps?: CompleteWithFallbackDeps
  onAttempt?: (attempt: ModelAttempt) => void
}): Promise<{ response: LLMResponse; candidate: ModelCandidate; attempts: ModelAttempt[] }> {
  const createClient = params.deps?.createClient ?? createLLMClient
  const sleep = params.deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const attempts: ModelAttempt[] = []
  const record = (attempt: ModelAttempt) => {
    attempts.push(attempt)
    params.onAttempt?.(attempt)
  }

  for (const candidate of params.candidates) {
    let client: LLMClient
    try {
      client = createClient(candidate.provider, candidate.model, params.modelConfig)
    } catch (error) {
      record({ ...candidate, ok: false, error: safeErrorMessage(error), latencyMs: 0 })
      if (error instanceof LLMConfigError || /Unsupported model provider/.test(String((error as Error)?.message))) continue
      throw error
    }

    for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
      const started = Date.now()
      try {
        const response = await client.complete(params.request)
        record({ ...candidate, ok: true, latencyMs: Date.now() - started })
        return { response, candidate, attempts }
      } catch (error) {
        record({ ...candidate, ok: false, error: safeErrorMessage(error), latencyMs: Date.now() - started })
        if (isFatalLLMError(error)) throw error
        if (!isTransientLLMError(error)) break // e.g. auth failure: this provider is unusable, try the next
        if (attempt < params.maxRetries) await sleep(backoffMs(attempt))
      }
    }
  }

  throw new ModelUnavailableError(attempts)
}
