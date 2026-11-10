import { prisma } from '@ai-workforce/db'

const RUN_ACTIONS = ['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_FINISHED', 'AGENT_RUN_ESCALATED', 'AGENT_RUN_BLOCKED_SPEND_CAP']

export interface AgentRunMetrics {
  since: string
  runs: number
  byStatus: Record<string, number>
  completionRate: number | null
  failureRate: number | null
  /** Among runs that reached the Assess phase. */
  dodPassRate: number | null
  escalationRate: number | null
  approvalRequiredRate: number | null
  clarificationRate: number | null
  /** Rejected / decided approvals — how often a human overrode the agent. */
  humanOverrideRate: number | null
  approvalsDecided: number
  latencyMs: { avg: number | null; p95: number | null }
  totalCostUsd: number
  costPerSuccessfulRunUsd: number | null
  fallbackRuns: number
  toolCalls: number
  toolErrorRate: number | null
  permissionDenials: number
  proposals: number
  duplicatesSuppressed: number
  unknownOutcomes: number
  injectionFlaggedRuns: number
  /** Finished runs flagged by quality signals (e.g. promised an action and didn't take it). */
  qualityFlaggedRuns: number
  /** How many runs had each quality signal (quality.ts). */
  qualitySignalCounts: Record<string, number>
}

const rate = (num: number, den: number) => (den > 0 ? num / den : null)

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

/**
 * Brief §13 dashboard metrics, computed from the AuditLog rows every run and
 * tool call already writes (no separate metrics store). Dry-run evaluation
 * runs are excluded so they don't skew production rates. Scoped to one tenant
 * and optionally one agent.
 */
export async function getAgentRunMetrics(params: { tenantId?: string; agentId?: string; since?: Date }): Promise<AgentRunMetrics> {
  const since = params.since ?? new Date(Date.now() - 7 * 86_400_000)
  const where = {
    ...(params.tenantId ? { tenantId: params.tenantId } : {}),
    ...(params.agentId ? { entityType: 'Agent', entityId: params.agentId } : {}),
    createdAt: { gte: since },
  }

  const [runRows, toolRows, approvalRows] = await Promise.all([
    prisma.auditLog.findMany({ where: { ...where, action: { in: RUN_ACTIONS } }, select: { action: true, newData: true }, take: 10_000 }),
    prisma.auditLog.groupBy({ by: ['action'], where: { ...where, action: { startsWith: 'AGENT_TOOL' } }, _count: { _all: true } }),
    prisma.auditLog.groupBy({
      by: ['action'],
      where: {
        ...(params.tenantId ? { tenantId: params.tenantId } : {}),
        // Decision rows carry the requesting agent, so overrides are counted per agent too.
        ...(params.agentId ? { newData: { path: ['agentId'], equals: params.agentId } } : {}),
        createdAt: { gte: since },
        action: { in: ['APPROVAL_GRANTED', 'APPROVAL_REJECTED'] },
      },
      _count: { _all: true },
    }),
  ])

  const byStatus: Record<string, number> = {}
  const latencies: number[] = []
  let totalCost = 0
  let assessed = 0
  let dodPassed = 0
  let fallbackRuns = 0
  let injectionFlagged = 0
  let qualityFlagged = 0
  const qualitySignalCounts: Record<string, number> = {}
  let runs = 0

  for (const row of runRows) {
    const data = (row.newData ?? {}) as Record<string, unknown>
    if (data.dryRun === true) continue
    runs++
    const status = row.action === 'AGENT_RUN_BLOCKED_SPEND_CAP' ? 'blocked' : typeof data.status === 'string' ? data.status : row.action === 'AGENT_RUN_COMPLETED' ? 'completed' : 'failed'
    byStatus[status] = (byStatus[status] ?? 0) + 1
    if (typeof data.durationMs === 'number') latencies.push(data.durationMs)
    if (typeof data.costUsd === 'number') totalCost += data.costUsd
    if (typeof data.dodPassed === 'boolean') {
      assessed++
      if (data.dodPassed) dodPassed++
    }
    if (data.fallbackUsed === true) fallbackRuns++
    if (Array.isArray(data.injectionSignals) && data.injectionSignals.length) injectionFlagged++
    if (Array.isArray(data.qualitySignals) && data.qualitySignals.length) {
      qualityFlagged++
      for (const signal of new Set(data.qualitySignals.filter((x): x is string => typeof x === 'string'))) qualitySignalCounts[signal] = (qualitySignalCounts[signal] ?? 0) + 1
    }
  }

  const toolCount = (action: string) => toolRows.find((r) => r.action === action)?._count._all ?? 0
  const succeeded = toolCount('AGENT_TOOL_CALL')
  const failed = toolCount('AGENT_TOOL_CALL_FAILED') + toolCount('AGENT_TOOL_CALL_UNKNOWN')
  const granted = approvalRows.find((r) => r.action === 'APPROVAL_GRANTED')?._count._all ?? 0
  const rejected = approvalRows.find((r) => r.action === 'APPROVAL_REJECTED')?._count._all ?? 0
  const completed = byStatus.completed ?? 0

  return {
    since: since.toISOString(),
    runs,
    byStatus,
    completionRate: rate(completed, runs),
    failureRate: rate(byStatus.failed ?? 0, runs),
    dodPassRate: rate(dodPassed, assessed),
    escalationRate: rate(byStatus.escalated ?? 0, runs),
    approvalRequiredRate: rate(byStatus.approval_required ?? 0, runs),
    clarificationRate: rate(byStatus.needs_clarification ?? 0, runs),
    humanOverrideRate: rate(rejected, granted + rejected),
    approvalsDecided: granted + rejected,
    latencyMs: { avg: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null, p95: percentile(latencies, 95) },
    totalCostUsd: totalCost,
    costPerSuccessfulRunUsd: completed ? totalCost / completed : null,
    fallbackRuns,
    toolCalls: succeeded + failed,
    toolErrorRate: rate(failed, succeeded + failed),
    permissionDenials: toolCount('AGENT_TOOL_DENIED'),
    proposals: toolCount('AGENT_TOOL_PROPOSED'),
    duplicatesSuppressed: toolCount('AGENT_TOOL_CALL_DUPLICATE_SUPPRESSED'),
    unknownOutcomes: toolCount('AGENT_TOOL_CALL_UNKNOWN') + toolCount('AGENT_TOOL_CALL_BLOCKED_UNKNOWN_PRIOR'),
    injectionFlaggedRuns: injectionFlagged,
    qualityFlaggedRuns: qualityFlagged,
    qualitySignalCounts,
  }
}
