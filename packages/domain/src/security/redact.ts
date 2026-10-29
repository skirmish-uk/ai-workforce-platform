/**
 * Redaction for anything written to logs, audit rows, traces, or approval
 * summaries. Two layers: object keys that name a secret are replaced wholesale,
 * and string values are scanned for well-known credential shapes (provider API
 * keys, bearer tokens, JWTs, PEM private keys). This is defence in depth — the
 * primary control is that credentials never enter model-visible context or
 * tool inputs in the first place (see packages/tools/src/executor.ts).
 */

export const REDACTED = '[REDACTED]'

const SECRET_KEY_PATTERN =
  /^(?:.*[_-])?(?:password|passwd|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|authorization|auth|cookie|credentials?|private[_-]?key|client[_-]?secret|session[_-]?token)$/i

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g, // Anthropic / OpenAI style keys
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe
  /\bwhsec_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bya29\.[A-Za-z0-9_-]{20,}\b/g, // Google OAuth access tokens
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
]

export interface RedactOptions {
  /** Truncate long strings so audit rows can't balloon with tool output. Default 4000. */
  maxStringLength?: number
  /** Guard against pathological nesting. Default 8. */
  maxDepth?: number
}

export function redactString(value: string, maxStringLength = 4000): string {
  let out = value
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED)
  }
  if (out.length > maxStringLength) {
    out = `${out.slice(0, maxStringLength)}…[truncated ${out.length - maxStringLength} chars]`
  }
  return out
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key)
}

/** Returns a deep copy of `value` with secrets removed. Never mutates the input. */
export function redact<T>(value: T, options: RedactOptions = {}): T {
  const maxStringLength = options.maxStringLength ?? 4000
  const maxDepth = options.maxDepth ?? 8
  const seen = new WeakSet<object>()

  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') return redactString(node, maxStringLength)
    if (node === null || typeof node !== 'object') return node
    if (node instanceof Date) return node.toISOString()
    if (seen.has(node)) return '[Circular]'
    if (depth >= maxDepth) return '[MaxDepth]'
    seen.add(node)

    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1))

    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      out[key] = isSecretKey(key) && child !== null && child !== undefined && child !== '' ? REDACTED : walk(child, depth + 1)
    }
    return out
  }

  return walk(value, 0) as T
}

/** Error text that is safe to persist or return to a caller. */
export function safeErrorMessage(error: unknown, fallback = 'Unexpected error'): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback
  return redactString(raw || fallback, 500)
}
