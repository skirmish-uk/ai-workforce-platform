import { z } from 'zod'
import { prisma } from '@ai-workforce/db'
import type { Prisma } from '@prisma/client'
import { safeErrorMessage } from '@ai-workforce/domain'
import { runAgent, type RunAgentDeps, type RunAgentResult, type RunAgentStatus } from './agent'
import { resolveAgentContract } from './contract'

const RUN_STATUSES = ['completed', 'partial', 'needs_clarification', 'escalated', 'approval_required', 'blocked', 'cancelled', 'failed'] as const
const runStatus = z.enum(RUN_STATUSES)

/** Brief §13 categories every agent's suite should cover. */
export const EVAL_CATEGORIES = [
  'normal',
  'edge',
  'ambiguous',
  'missing_input',
  'injection',
  'tool_failure',
  'duplicate',
  'high_risk',
  'regression',
] as const

export const evalCaseSchema = z.object({
  name: z.string().optional(),
  category: z.enum(EVAL_CATEGORIES).default('normal'),
  input: z.union([z.string(), z.record(z.unknown())]),
  /** Deterministic assertions. Cases without `expect` are recorded as unassertable, never as passes. */
  expect: z
    .object({
      status: z.union([runStatus, z.array(runStatus)]).optional(),
      /** The agent must have requested each of these tools (whatever policy then decided). */
      toolsRequested: z.array(z.string()).optional(),
      /** None of these may have actually executed (completed/simulated). */
      toolsNotExecuted: z.array(z.string()).optional(),
      outputContains: z.array(z.string()).optional(),
      outputNotContains: z.array(z.string()).optional(),
      dodPassed: z.boolean().optional(),
    })
    .optional(),
  /** Outputs returned for read tools during the dry run. */
  toolFixtures: z.record(z.unknown()).optional(),
  /** Legacy free-text label from older seed data; informational only. */
  expected: z.string().optional(),
})
export type EvalCase = z.infer<typeof evalCaseSchema>

export interface EvalCaseResult {
  name: string
  category: EvalCase['category']
  assertable: boolean
  passed: boolean
  failures: string[]
  status?: RunAgentStatus
  runId?: string
  costUsd?: number | null
}

/** Pure assertion logic, unit-tested separately from any model. */
export function assertEvalCase(testCase: EvalCase, result: Pick<RunAgentResult, 'status' | 'output' | 'toolCalls' | 'dod'>): string[] {
  const expect = testCase.expect
  if (!expect) return ['no deterministic assertions']
  const failures: string[] = []
  const output = (result.output ?? '').toLowerCase()

  if (expect.status) {
    const allowed = Array.isArray(expect.status) ? expect.status : [expect.status]
    if (!allowed.includes(result.status)) failures.push(`status ${result.status} not in [${allowed.join(', ')}]`)
  } else if (result.status === 'failed' || result.status === 'blocked' || result.status === 'cancelled') {
    // Negative-only assertions ("X was not executed") are trivially true for a run that never ran
    // (model down, budget exhausted…). Unless a case explicitly expects that status, it is not a pass.
    failures.push(`run ended "${result.status}" and the case does not expect that status`)
  }
  for (const tool of expect.toolsRequested ?? []) {
    if (!result.toolCalls.some((c) => c.toolName === tool)) failures.push(`expected ${tool} to be requested`)
  }
  for (const tool of expect.toolsNotExecuted ?? []) {
    if (result.toolCalls.some((c) => c.toolName === tool && (c.status === 'completed' || c.status === 'simulated'))) {
      failures.push(`${tool} executed but must not have`)
    }
  }
  for (const text of expect.outputContains ?? []) {
    if (!output.includes(text.toLowerCase())) failures.push(`output missing "${text}"`)
  }
  for (const text of expect.outputNotContains ?? []) {
    if (output.includes(text.toLowerCase())) failures.push(`output contains forbidden "${text}"`)
  }
  if (expect.dodPassed !== undefined && (result.dod?.passed ?? false) !== expect.dodPassed) {
    failures.push(`dodPassed ${result.dod?.passed ?? false} !== ${expect.dodPassed}`)
  }
  return failures
}

export function parseEvalCases(raw: unknown[]): { cases: EvalCase[]; invalid: string[] } {
  const cases: EvalCase[] = []
  const invalid: string[] = []
  raw.forEach((item, index) => {
    const parsed = evalCaseSchema.safeParse(item)
    if (parsed.success) cases.push(parsed.data)
    else invalid.push(`case ${index}: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  })
  return { cases, invalid }
}

/**
 * Runs an agent's evaluation suite in dry-run mode — real model calls (this
 * costs money), but no tool ever touches an external system and no approval is
 * persisted — and stores the result as an Evaluation pinned to the agent's
 * current version. A passing Evaluation for the current version is the
 * evidence required before limited/expanded autonomy takes effect.
 *
 * Defaults to the evaluation cases of the agent's enabled skills.
 */
export async function runEvaluation(
  agentId: string,
  options: { cases?: unknown[]; name?: string; deps?: RunAgentDeps } = {}
): Promise<{ evaluationId: string; passed: boolean; passRate: number; results: EvalCaseResult[] }> {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
  const { contract } = resolveAgentContract(agent)

  let rawCases = options.cases
  if (!rawCases) {
    const links = await prisma.agentSkill.findMany({ where: { agentId, enabled: true }, include: { skill: true } })
    rawCases = links.flatMap((l) => (Array.isArray(l.skill.evaluationCases) ? (l.skill.evaluationCases as unknown[]) : []))
  }
  const { cases, invalid } = parseEvalCases(rawCases)

  const results: EvalCaseResult[] = []
  let totalCost = 0
  for (const [index, testCase] of cases.entries()) {
    const name = testCase.name ?? `case-${index + 1}`
    if (!testCase.expect) {
      results.push({ name, category: testCase.category, assertable: false, passed: false, failures: ['no deterministic assertions (legacy `expected` label only)'] })
      continue
    }
    try {
      const input = typeof testCase.input === 'string' ? testCase.input : JSON.stringify(testCase.input)
      const result = await runAgent(agentId, input, { dryRun: true, toolFixtures: testCase.toolFixtures, trigger: 'evaluation', deps: options.deps })
      totalCost += result.costUsd ?? 0
      const failures = assertEvalCase(testCase, result)
      results.push({ name, category: testCase.category, assertable: true, passed: failures.length === 0, failures, status: result.status, runId: result.runId, costUsd: result.costUsd })
    } catch (error) {
      results.push({ name, category: testCase.category, assertable: true, passed: false, failures: [safeErrorMessage(error)] })
    }
  }

  const assertable = results.filter((r) => r.assertable)
  const passRate = assertable.length ? assertable.filter((r) => r.passed).length / assertable.length : 0
  const passed = assertable.length > 0 && invalid.length === 0 && passRate >= contract.evaluation.minPassRate

  const evaluation = await prisma.evaluation.create({
    data: {
      name: options.name ?? `${agent.name} v${agent.version} suite`,
      agentId,
      agentVersion: agent.version,
      suite: rawCases as Prisma.InputJsonValue,
      results: { cases: results, invalid, passRate, assertable: assertable.length, unassertable: results.length - assertable.length, minPassRate: contract.evaluation.minPassRate, totalCostUsd: totalCost } as unknown as Prisma.InputJsonValue,
      score: passRate,
      passed,
    },
  })

  await prisma.auditLog.create({
    data: {
      action: 'AGENT_EVALUATION_COMPLETED',
      entityType: 'Agent',
      entityId: agentId,
      tenantId: agent.tenantId,
      newData: { evaluationId: evaluation.id, agentVersion: agent.version, passRate, passed, cases: results.length },
    },
  })

  return { evaluationId: evaluation.id, passed, passRate, results }
}
