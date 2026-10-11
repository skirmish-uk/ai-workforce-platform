import { z } from 'zod'

/**
 * Deterministic Definition-of-Done checks, evaluated in the Assess phase of
 * every run against what actually happened (tool results recorded by the
 * executor), never against what the model claims happened.
 */
export const DOD_CHECK_SCHEMA = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output_present') }),
  z.object({ type: z.literal('output_contains'), value: z.string().min(1), caseSensitive: z.boolean().default(false) }),
  z.object({ type: z.literal('output_not_contains'), value: z.string().min(1), caseSensitive: z.boolean().default(false) }),
  z.object({ type: z.literal('output_is_json') }),
  z.object({ type: z.literal('output_json_fields'), fields: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal('tool_succeeded'), tool: z.string().min(1) }),
  z.object({ type: z.literal('no_tool_errors') }),
  z.object({ type: z.literal('max_cost_usd'), value: z.number().nonnegative() }),
])
export type DodCheck = z.infer<typeof DOD_CHECK_SCHEMA>

export interface DodToolRecord {
  toolName: string
  status: string
}

export interface DodEvidence {
  output: string | null
  toolCalls: DodToolRecord[]
  costUsd: number | null
}

export interface DodCheckResult {
  check: DodCheck
  passed: boolean
  detail: string
}

export interface DodAssessment {
  passed: boolean
  results: DodCheckResult[]
}

/** Extracts a JSON object from a model answer, tolerating a ```json fenced block. */
export function extractJsonObject(output: string | null): Record<string, unknown> | null {
  if (!output) return null
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced ? fenced[1] : output).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function contains(haystack: string, needle: string, caseSensitive: boolean): boolean {
  return caseSensitive ? haystack.includes(needle) : haystack.toLowerCase().includes(needle.toLowerCase())
}

export function evaluateDodCheck(check: DodCheck, evidence: DodEvidence): DodCheckResult {
  const output = evidence.output ?? ''
  switch (check.type) {
    case 'output_present':
      return { check, passed: output.trim().length > 0, detail: output.trim() ? 'final answer present' : 'no final answer' }
    case 'output_contains': {
      const passed = contains(output, check.value, check.caseSensitive)
      return { check, passed, detail: passed ? `contains "${check.value}"` : `missing "${check.value}"` }
    }
    case 'output_not_contains': {
      const passed = !contains(output, check.value, check.caseSensitive)
      return { check, passed, detail: passed ? `does not contain "${check.value}"` : `contains forbidden "${check.value}"` }
    }
    case 'output_is_json': {
      const passed = extractJsonObject(evidence.output) !== null
      return { check, passed, detail: passed ? 'output is a JSON object' : 'output is not a JSON object' }
    }
    case 'output_json_fields': {
      const json = extractJsonObject(evidence.output)
      if (!json) return { check, passed: false, detail: 'output is not a JSON object' }
      const missing = check.fields.filter((field) => !(field in json))
      return { check, passed: missing.length === 0, detail: missing.length ? `missing fields: ${missing.join(', ')}` : 'all fields present' }
    }
    case 'tool_succeeded': {
      const passed = evidence.toolCalls.some((call) => call.toolName === check.tool && call.status === 'completed')
      return { check, passed, detail: passed ? `${check.tool} completed` : `no successful ${check.tool} call` }
    }
    case 'no_tool_errors': {
      const failed = evidence.toolCalls.filter((call) => call.status === 'error')
      return { check, passed: failed.length === 0, detail: failed.length ? `${failed.length} tool error(s)` : 'no tool errors' }
    }
    case 'max_cost_usd': {
      const cost = evidence.costUsd ?? 0
      return { check, passed: cost <= check.value, detail: `cost $${cost.toFixed(6)} (limit $${check.value})` }
    }
  }
}

/**
 * Runs the contract's checks plus the implicit ones every run gets: a final
 * answer must exist, and a JSON output contract implies an output_json_fields
 * check on its required fields.
 */
export function assessDefinitionOfDone(
  checks: DodCheck[],
  evidence: DodEvidence,
  outputContract: { format: 'text' | 'json'; requiredFields: string[] } = { format: 'text', requiredFields: [] }
): DodAssessment {
  const all: DodCheck[] = [{ type: 'output_present' }]
  if (outputContract.format === 'json') {
    all.push(
      outputContract.requiredFields.length
        ? { type: 'output_json_fields', fields: outputContract.requiredFields }
        : { type: 'output_is_json' }
    )
  }
  for (const check of checks) {
    if (check.type !== 'output_present') all.push(check)
  }
  const results = all.map((check) => evaluateDodCheck(check, evidence))
  return { passed: results.every((r) => r.passed), results }
}
