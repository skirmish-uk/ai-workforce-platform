import { prisma } from '@ai-workforce/db'
import type { Prisma } from '@prisma/client'
import { safeErrorMessage } from '@ai-workforce/domain'
import { resolveAgentContract } from '../contract'
import { getAgentRunMetrics, type AgentRunMetrics } from '../metrics'
import { readKillSwitch } from '../safety'
import { readSelfManagementPolicy, type SelfManagementPolicy } from './policy'

/**
 * Automatic repair reviews (docs/WORKFORCE_MANAGER.md §4): instead of waiting for the
 * weekly review, the manager is started as soon as an agent shows a problem. Detection
 * is pure (detectManagerTriggers); dispatch (findDueManagerReviews) reserves each
 * trigger in the audit log, so the same problem never fires twice in 24 h.
 */

export type TriggerKind = 'failures' | 'quality' | 'rejections' | 'tool_errors' | 'rollback'

export interface ManagerTrigger {
  kind: TriggerKind
  agentId: string
  agentName: string
  /** Plain-language evidence handed to the manager. */
  detail: string
  /** Dedup key: one trigger per kind and agent per 24 h. */
  key: string
}

const pct = (v: number | null) => `${Math.round((v ?? 0) * 100)}%`

export function detectManagerTriggers(
  input: {
    agents: Array<{ id: string; name: string; metrics: Pick<AgentRunMetrics, 'runs' | 'failureRate' | 'qualityFlaggedRuns' | 'approvalsDecided' | 'humanOverrideRate' | 'toolCalls' | 'toolErrorRate'> }>
    rollbacks: Array<{ revisionId: string; agentId: string; agentName: string; reason: string }>
    alreadyFired: ReadonlySet<string>
  },
  thresholds: SelfManagementPolicy['autoReview']
): ManagerTrigger[] {
  const out: ManagerTrigger[] = []
  const push = (kind: TriggerKind, agentId: string, agentName: string, detail: string) => {
    const key = `${kind}:${agentId}`
    if (!input.alreadyFired.has(key) && !out.some((t) => t.key === key)) out.push({ kind, agentId, agentName, detail, key })
  }
  for (const a of input.agents) {
    const m = a.metrics
    if (m.runs >= thresholds.minRuns && (m.failureRate ?? 0) >= thresholds.failureRate) {
      push('failures', a.id, a.name, `${pct(m.failureRate)} of ${m.runs} runs in the last 24 hours failed.`)
    }
    if (m.qualityFlaggedRuns >= thresholds.qualityFlaggedRuns) {
      push('quality', a.id, a.name, `${m.qualityFlaggedRuns} runs in the last 24 hours promised actions they did not take or asked questions in their answer instead of with the clarification tool.`)
    }
    if (m.approvalsDecided >= 3 && (m.humanOverrideRate ?? 0) >= thresholds.rejectionRate) {
      push('rejections', a.id, a.name, `People rejected ${pct(m.humanOverrideRate)} of its ${m.approvalsDecided} approval requests in the last 24 hours.`)
    }
    if (m.toolCalls >= 5 && (m.toolErrorRate ?? 0) >= thresholds.toolErrorRate) {
      push('tool_errors', a.id, a.name, `${pct(m.toolErrorRate)} of its ${m.toolCalls} tool calls in the last 24 hours errored. If this is a broken or disconnected integration, a person has to fix it: escalate rather than change the agent.`)
    }
  }
  for (const r of input.rollbacks) {
    push('rollback', r.agentId, r.agentName, `A promoted change (revision ${r.revisionId}) was rolled back automatically: ${r.reason}`)
  }
  return out
}

export interface DueManagerReview {
  tenantId: string
  managerId: string
  triggers: ManagerTrigger[]
  /** Input for the manager's run. */
  input: string
}

export function managerReviewInput(triggers: ManagerTrigger[]): string {
  return [
    'Automatic repair review. The platform detected these problems in the last 24 hours:',
    ...triggers.map((t, i) => `${i + 1}. ${t.agentName} (${t.agentId}): ${t.detail}`),
    '',
    'For each one, inspect the agent and its problem runs. Propose a fix only if the evidence supports it, with an evaluation case that reproduces the problem. If the cause is a connection, a policy decision or anything you cannot fix with a revision, it needs a person.',
    'Work through every item before handing anything over: platform__escalate ends your run, so call it at most once, last, naming every item a person must handle. If nothing needs a person, finish with a short report of what you found and did for each item.',
  ].join('\n')
}

/**
 * Scheduler tick: for each tenant with self-management and automatic reviews on, an
 * active manager, and no kill switch, returns at most one due review (all new triggers
 * combined) and records each trigger as fired. The caller enqueues the manager run.
 */
export async function findDueManagerReviews(now = new Date()): Promise<DueManagerReview[]> {
  const since = new Date(now.getTime() - 86_400_000)
  const tenants = await prisma.tenant.findMany({ select: { id: true, settings: true } })
  const due: DueManagerReview[] = []

  for (const tenant of tenants) {
    try {
      const { policy } = readSelfManagementPolicy(tenant.settings)
      if (!policy.enabled || !policy.autoReview.enabled || policy.autoReview.maxPerDay === 0) continue
      if (readKillSwitch(tenant.settings).agentsDisabled) continue

      const agents = await prisma.agent.findMany({
        where: { tenantId: tenant.id, isCandidate: false, status: { notIn: ['PAUSED', 'ARCHIVED'] } },
        select: { id: true, name: true, config: true, mission: true },
      })
      const isManager = (a: (typeof agents)[number]) => resolveAgentContract(a).contract.management.enabled
      const manager = agents.find(isManager)
      if (!manager) continue

      const fired = await prisma.auditLog.findMany({
        where: { tenantId: tenant.id, action: 'MANAGER_REVIEW_TRIGGERED', createdAt: { gte: since } },
        select: { newData: true },
      })
      const firedKeys = new Set(fired.map((f) => String((f.newData as { key?: string } | null)?.key ?? '')))
      const reviewsToday = new Set(fired.map((f) => String((f.newData as { reviewId?: string } | null)?.reviewId ?? ''))).size
      if (reviewsToday >= policy.autoReview.maxPerDay) continue

      const workers = agents.filter((a) => !isManager(a))
      const withMetrics = await Promise.all(workers.map(async (a) => ({ id: a.id, name: a.name, metrics: await getAgentRunMetrics({ tenantId: tenant.id, agentId: a.id, since }) })))
      const rolledBack = await prisma.agentRevision.findMany({
        where: { tenantId: tenant.id, status: 'ROLLED_BACK', updatedAt: { gte: since }, agentId: { not: null } },
        select: { id: true, agentId: true, results: true },
      })
      const names = new Map(agents.map((a) => [a.id, a.name]))
      const rollbacks = rolledBack
        .map((r) => ({ revisionId: r.id, agentId: r.agentId!, agentName: names.get(r.agentId!) ?? r.agentId!, rollback: (r.results as { rollback?: { automatic?: boolean; reason?: string } } | null)?.rollback }))
        .filter((r) => r.rollback?.automatic)
        .map((r) => ({ revisionId: r.revisionId, agentId: r.agentId, agentName: r.agentName, reason: r.rollback?.reason ?? 'metrics degraded' }))

      const triggers = detectManagerTriggers({ agents: withMetrics, rollbacks, alreadyFired: firedKeys }, policy.autoReview)
      if (!triggers.length) continue

      const reviewId = `review-${tenant.id}-${Math.floor(now.getTime() / 60_000)}`
      await prisma.auditLog.createMany({
        data: triggers.map((t) => ({
          action: 'MANAGER_REVIEW_TRIGGERED',
          entityType: 'Agent',
          entityId: t.agentId,
          tenantId: tenant.id,
          newData: { key: t.key, kind: t.kind, detail: t.detail, reviewId, managerId: manager.id } as Prisma.InputJsonValue,
        })),
      })
      due.push({ tenantId: tenant.id, managerId: manager.id, triggers, input: managerReviewInput(triggers) })
    } catch (error) {
      console.error(`Manager trigger check failed for tenant ${tenant.id}:`, safeErrorMessage(error))
    }
  }
  return due
}
