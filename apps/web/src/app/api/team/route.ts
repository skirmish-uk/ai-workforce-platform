import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission } from '@ai-workforce/domain'
import { getAgentRunMetrics, readSelfManagementPolicy, resolveAgentContract } from '@ai-workforce/executor'
import { UserRole } from '@prisma/client'

export const dynamic = 'force-dynamic'

const RUN_ACTIONS = ['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_FINISHED', 'AGENT_RUN_ESCALATED']
const ACTIVITY_ACTIONS = [
  'MANAGER_REVIEW_TRIGGERED',
  'AGENT_REVISION_PROPOSED',
  'AGENT_REVISION_PROMOTED',
  'AGENT_REVISION_FAILED',
  'AGENT_REVISION_AWAITING_APPROVAL',
  'AGENT_REVISION_ROLLED_BACK',
  'AGENT_REVISION_REJECTED',
]

const round = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100)

/**
 * GET /api/team — the team at a glance for the caller's tenant: the manager and its
 * latest report, every agent's 7-day health, what is waiting for a person, and recent
 * manager activity (automatic reviews, proposals, promotions, rollbacks).
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const role = session.user.role as UserRole
    if (!hasPermission(role, 'agent:read')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const params = new URL(request.url).searchParams
    const isPlatform = role === 'PLATFORM_ADMIN' || role === 'PLATFORM_OPERATOR'
    const tenantId = isPlatform && params.get('tenantId') ? params.get('tenantId')! : session.user.tenantId
    const since = new Date(Date.now() - 7 * 86_400_000)

    const [tenant, agents, pendingApprovals, openRevisions, activity] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }),
      prisma.agent.findMany({
        where: { tenantId, isCandidate: false, status: { not: 'ARCHIVED' } },
        orderBy: { createdAt: 'asc' },
        include: { schedules: { select: { cron: true, timezone: true, isActive: true } } },
      }),
      prisma.approval.findMany({ where: { tenantId, status: 'PENDING' }, select: { input: true } }),
      prisma.agentRevision.findMany({ where: { tenantId, status: { in: ['PROPOSED', 'EVALUATING', 'AWAITING_APPROVAL', 'PROMOTING'] } }, select: { id: true, agentId: true, status: true } }),
      prisma.auditLog.findMany({ where: { tenantId, action: { in: ACTIVITY_ACTIONS } }, orderBy: { createdAt: 'desc' }, take: 20, select: { action: true, entityId: true, createdAt: true, newData: true } }),
    ])
    if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 })

    const names = new Map(agents.map((a) => [a.id, a.name]))
    const policy = readSelfManagementPolicy(tenant.settings).policy
    // "Needs attention" uses the same thresholds that start an automatic manager review.
    const t = policy.autoReview
    const managerRow = agents.find((a) => resolveAgentContract(a).contract.management.enabled)

    let manager = null
    if (managerRow) {
      const last = await prisma.auditLog.findFirst({
        where: { tenantId, entityType: 'Agent', entityId: managerRow.id, action: { in: RUN_ACTIONS } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, newData: true },
      })
      const data = (last?.newData ?? {}) as Record<string, unknown>
      manager = {
        id: managerRow.id,
        name: managerRow.name,
        status: managerRow.status,
        model: managerRow.modelName,
        schedule: managerRow.schedules[0] ?? null,
        lastRun: last
          ? { at: last.createdAt, status: data.status, trigger: data.trigger, input: String(data.input ?? '').slice(0, 300), output: String(data.output ?? '').slice(0, 4000), costUsd: data.costUsd, runId: data.runId }
          : null,
      }
    }

    const team = await Promise.all(
      agents
        .filter((a) => a.id !== managerRow?.id)
        .map(async (a) => {
          const { contract } = resolveAgentContract(a)
          const m = await getAgentRunMetrics({ tenantId, agentId: a.id, since })
          const lastChange = await prisma.agentRevision.findFirst({ where: { agentId: a.id, status: 'PROMOTED' }, orderBy: { promotedAt: 'desc' }, select: { promotedAt: true, promotedVersion: true, proposedByAgentId: true } })
          const reasons: string[] = []
          if (m.runs >= t.minRuns && (m.failureRate ?? 0) >= t.failureRate) reasons.push(`${Math.round((m.failureRate ?? 0) * 100)}% of runs failed`)
          if (m.qualityFlaggedRuns >= t.qualityFlaggedRuns) reasons.push(`${m.qualityFlaggedRuns} runs promised actions or asked questions in text`)
          if (m.approvalsDecided >= 3 && (m.humanOverrideRate ?? 0) >= t.rejectionRate) reasons.push(`${Math.round((m.humanOverrideRate ?? 0) * 100)}% of approvals rejected`)
          if (m.toolCalls >= 5 && (m.toolErrorRate ?? 0) >= t.toolErrorRate) reasons.push(`${Math.round((m.toolErrorRate ?? 0) * 100)}% of tool calls errored`)
          return {
            id: a.id,
            name: a.name,
            role: a.role,
            status: a.status,
            version: a.version,
            stage: contract.autonomyStage,
            model: a.modelName,
            health: a.status === 'PAUSED' ? 'paused' : reasons.length ? 'attention' : m.runs === 0 ? 'idle' : 'healthy',
            reasons,
            metrics: {
              runs: m.runs,
              completionRate: round(m.completionRate),
              escalationRate: round(m.escalationRate),
              qualityFlaggedRuns: m.qualityFlaggedRuns,
              rejectionRate: round(m.humanOverrideRate),
              costUsd: Math.round(m.totalCostUsd * 10000) / 10000,
            },
            openRevision: openRevisions.find((r) => r.agentId === a.id) ?? null,
            lastChange: lastChange ? { at: lastChange.promotedAt, version: lastChange.promotedVersion, by: lastChange.proposedByAgentId ? names.get(lastChange.proposedByAgentId) ?? 'manager' : 'a person' } : null,
          }
        })
    )

    // Revision events don't all carry the agent; look it up from the revision.
    const revisionIds = activity.filter((e) => e.action.startsWith('AGENT_REVISION')).map((e) => e.entityId)
    const revisionAgents = new Map(
      (revisionIds.length ? await prisma.agentRevision.findMany({ where: { id: { in: revisionIds }, tenantId }, select: { id: true, agentId: true } }) : []).map((r) => [r.id, r.agentId])
    )
    const kinds = pendingApprovals.map((a) => (a.input as { kind?: string } | null)?.kind)
    return NextResponse.json({
      selfManagement: policy,
      manager,
      team,
      waiting: {
        actions: kinds.filter((k) => k !== 'agent_revision').length,
        changes: kinds.filter((k) => k === 'agent_revision').length,
        revisionsInProgress: openRevisions.filter((r) => r.status !== 'AWAITING_APPROVAL').length,
      },
      activity: activity.map((e) => {
        const d = (e.newData ?? {}) as Record<string, unknown>
        const agentId = (d.agentId as string | undefined) ?? (e.action === 'MANAGER_REVIEW_TRIGGERED' ? e.entityId : revisionAgents.get(e.entityId) ?? null)
        return { action: e.action, at: e.createdAt, agentId, agentName: agentId ? names.get(agentId) ?? null : null, revisionId: e.action.startsWith('AGENT_REVISION') ? e.entityId : null, detail: d.detail ?? d.error ?? d.reason ?? null, kind: d.kind ?? d.changeType ?? null }
      }),
    })
  } catch (error) {
    console.error('Error loading team:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
