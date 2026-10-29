import { prisma } from '@ai-workforce/db'
import { resolveAgentContract } from './contract'

/**
 * What the team did and what it was worth, for the dashboard home (docs/IMPACT.md), from the
 * audit trail. Counted as one task each: a typed request and its run, a team-case task, a
 * scheduled run, a whole voice call (not each turn). Not counted: test runs (evaluations,
 * replays, dry runs) and a manager's delegated sub-tasks (part of the manager's task).
 *
 * Time saved is an estimate: each finished task is worth its agent's manual-effort setting
 * (contract.taskAssessment.manualEffortMinutes, else DEFAULT_TASK_MINUTES), the time a person
 * would have spent on it. A task handed to a person counts for half (the agent did the
 * groundwork). The page says so next to the number.
 */

export const DEFAULT_TASK_MINUTES = 10
const RUN_ACTIONS = ['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_FINISHED', 'AGENT_RUN_ESCALATED']
const NOT_TASKS = new Set(['evaluation', 'replay', 'delegation'])
/** Finished: done, or done and waiting for a person to approve what was prepared. */
const FINISHED = new Set(['completed', 'partial', 'approval_required'])

export interface ImpactActivity {
  at: string
  agentId: string
  agentName: string
  kind: 'voice' | 'case' | 'schedule' | 'task'
  summary: string
  status: string
  runId: string
  caseId?: string
  conversationId?: string
}

export interface Impact {
  days: number
  since: string
  tasks: { total: number; finished: number; toPerson: number; failed: number }
  minutesSaved: number
  /** Median seconds from request to answer for finished tasks other than calls. */
  medianSeconds: number | null
  /** Median seconds for an agent's answer on a call (one turn). */
  callAnswerSeconds: number | null
  costUsd: number
  costPerTaskUsd: number | null
  calls: number
  cases: { total: number; done: number }
  waiting: { approvals: number; handovers: number; memories: number }
  learned: { total: number; byAgents: number; byStaff: number; lessons: number }
  improvements: { promoted: number; rolledBack: number; latest: Array<{ at: string; agentName: string; summary: string }> }
  daily: Array<{ day: string; finished: number; minutesSaved: number }>
  agents: Array<{ id: string; name: string; role: string; tasks: number; finished: number; minutesSaved: number; costUsd: number; minutesPerTask: number }>
  activity: ImpactActivity[]
}

type RunData = {
  status?: string
  trigger?: string
  dryRun?: boolean
  costUsd?: number | null
  durationMs?: number
  input?: string
  message?: string
  conversationId?: string
  caseId?: string
  runId?: string
}

function firstLine(text: string | undefined, max = 140): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function dayOf(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

export async function getImpact(params: { tenantId: string; days: number; now?: Date }): Promise<Impact> {
  const now = params.now ?? new Date()
  const since = new Date(now.getTime() - params.days * 86_400_000)
  const [tenant, agents, rows, cases, approvals, handovers, pendingMemories, memories, revisions] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: params.tenantId }, select: { settings: true } }),
    prisma.agent.findMany({ where: { tenantId: params.tenantId, isCandidate: false }, select: { id: true, name: true, role: true, mission: true, config: true } }),
    prisma.auditLog.findMany({
      where: { tenantId: params.tenantId, entityType: 'Agent', action: { in: RUN_ACTIONS }, createdAt: { gte: since } },
      select: { entityId: true, createdAt: true, newData: true },
      orderBy: { createdAt: 'asc' },
      take: 20_000,
    }),
    prisma.teamCase.groupBy({ by: ['status'], where: { tenantId: params.tenantId, createdAt: { gte: since } }, _count: true }),
    prisma.approval.count({ where: { tenantId: params.tenantId, status: 'PENDING' } }),
    prisma.handover.count({ where: { tenantId: params.tenantId, status: 'OPEN' } }),
    prisma.memory.count({ where: { tenantId: params.tenantId, status: 'PENDING' } }),
    prisma.memory.findMany({ where: { tenantId: params.tenantId, createdAt: { gte: since } }, select: { learnedById: true, agentId: true, category: true } }),
    prisma.auditLog.findMany({
      where: { tenantId: params.tenantId, action: { in: ['AGENT_REVISION_PROMOTED', 'AGENT_REVISION_ROLLED_BACK'] }, createdAt: { gte: since } },
      select: { action: true, entityId: true, createdAt: true, newData: true },
      orderBy: { createdAt: 'desc' },
    }),
  ])
  const settings = (tenant?.settings ?? {}) as { timeZone?: string }
  const timeZone = typeof settings.timeZone === 'string' ? settings.timeZone : 'UTC'

  const info = new Map(agents.map((a) => {
    const contract = resolveAgentContract(a).contract
    return [a.id, { name: a.name, role: a.role, minutes: contract.taskAssessment?.manualEffortMinutes ?? DEFAULT_TASK_MINUTES }]
  }))

  // One task per run, except voice: one per call.
  type Task = { agentId: string; at: Date; status: string; costUsd: number; seconds: number[]; kind: ImpactActivity['kind']; summary: string; runId: string; caseId?: string; conversationId?: string }
  const tasks: Task[] = []
  const calls = new Map<string, Task>()
  let costUsd = 0
  for (const row of rows) {
    const d = (row.newData ?? {}) as RunData
    if (d.dryRun || NOT_TASKS.has(d.trigger ?? '')) {
      // Delegated sub-tasks still cost money: counted in the total, not as tasks.
      if (!d.dryRun && d.trigger === 'delegation') costUsd += d.costUsd ?? 0
      continue
    }
    const cost = d.costUsd ?? 0
    costUsd += cost
    const status = d.status ?? 'failed'
    const seconds = typeof d.durationMs === 'number' ? d.durationMs / 1000 : null
    if (d.trigger === 'voice') {
      const key = `${row.entityId}:${d.conversationId ?? d.runId}`
      const call = calls.get(key)
      if (call) {
        call.costUsd += cost
        if (seconds !== null) call.seconds.push(seconds)
        // A call is finished if any answer was.
        if (FINISHED.has(status)) call.status = 'completed'
        continue
      }
      const task: Task = { agentId: row.entityId, at: row.createdAt, status: FINISHED.has(status) ? 'completed' : status, costUsd: cost, seconds: seconds === null ? [] : [seconds], kind: 'voice', summary: firstLine(d.message ?? d.input), runId: d.runId ?? '', conversationId: d.conversationId }
      calls.set(key, task)
      tasks.push(task)
      continue
    }
    tasks.push({
      agentId: row.entityId, at: row.createdAt, status, costUsd: cost, seconds: seconds === null ? [] : [seconds],
      kind: d.trigger === 'handoff' || d.caseId ? 'case' : d.trigger === 'schedule' ? 'schedule' : 'task',
      summary: firstLine(d.message ?? d.input), runId: d.runId ?? '', caseId: d.caseId, conversationId: d.conversationId,
    })
  }

  const worth = (t: Task) => {
    const minutes = info.get(t.agentId)?.minutes ?? DEFAULT_TASK_MINUTES
    return FINISHED.has(t.status) ? minutes : t.status === 'escalated' ? minutes / 2 : 0
  }
  const finished = tasks.filter((t) => FINISHED.has(t.status))
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10 : null
  }
  const minutesSaved = tasks.reduce((sum, t) => sum + worth(t), 0)

  const daily = new Map<string, { finished: number; minutesSaved: number }>()
  for (let i = params.days - 1; i >= 0; i--) daily.set(dayOf(new Date(now.getTime() - i * 86_400_000), timeZone), { finished: 0, minutesSaved: 0 })
  for (const t of tasks) {
    const bucket = daily.get(dayOf(t.at, timeZone))
    if (!bucket) continue
    if (FINISHED.has(t.status)) bucket.finished++
    bucket.minutesSaved += worth(t)
  }

  const perAgent = new Map<string, { tasks: number; finished: number; minutesSaved: number; costUsd: number }>()
  for (const t of tasks) {
    const a = perAgent.get(t.agentId) ?? { tasks: 0, finished: 0, minutesSaved: 0, costUsd: 0 }
    a.tasks++
    if (FINISHED.has(t.status)) a.finished++
    a.minutesSaved += worth(t)
    a.costUsd += t.costUsd
    perAgent.set(t.agentId, a)
  }

  const names = (id: string) => info.get(id)?.name ?? 'An agent'
  const promoted = revisions.filter((r) => r.action === 'AGENT_REVISION_PROMOTED')
  const rationales = promoted.length
    ? new Map((await prisma.agentRevision.findMany({ where: { id: { in: promoted.slice(0, 5).map((r) => r.entityId) } }, select: { id: true, rationale: true } })).map((r) => [r.id, r.rationale]))
    : new Map<string, string>()
  // A case task's input is the brief plus the case so far: show the brief.
  const recent = tasks.slice(-12).reverse()
  const caseRuns = recent.filter((t) => t.kind === 'case' && t.runId).map((t) => t.runId)
  const briefs = new Map(caseRuns.length ? (await prisma.agentTask.findMany({ where: { runId: { in: caseRuns } }, select: { runId: true, brief: true } })).map((t) => [t.runId ?? '', firstLine(t.brief)]) : [])
  const caseCount = (status?: string) => cases.filter((c) => !status || c.status === status).reduce((n, c) => n + c._count, 0)
  return {
    days: params.days,
    since: since.toISOString(),
    tasks: { total: tasks.length, finished: finished.length, toPerson: tasks.filter((t) => t.status === 'escalated').length, failed: tasks.filter((t) => t.status === 'failed' || t.status === 'blocked').length },
    minutesSaved: Math.round(minutesSaved),
    medianSeconds: median(finished.filter((t) => t.kind !== 'voice').flatMap((t) => t.seconds)),
    callAnswerSeconds: median(finished.filter((t) => t.kind === 'voice').flatMap((t) => t.seconds)),
    costUsd: Math.round(costUsd * 100) / 100,
    costPerTaskUsd: finished.length ? Math.round((costUsd / finished.length) * 1000) / 1000 : null,
    calls: tasks.filter((t) => t.kind === 'voice').length,
    cases: { total: caseCount(), done: caseCount('DONE') },
    waiting: { approvals, handovers, memories: pendingMemories },
    learned: { total: memories.length, byAgents: memories.filter((m) => m.learnedById).length, byStaff: memories.filter((m) => !m.learnedById).length, lessons: memories.filter((m) => m.agentId && m.category === 'correction').length },
    improvements: {
      promoted: promoted.length,
      rolledBack: revisions.filter((r) => r.action === 'AGENT_REVISION_ROLLED_BACK').length,
      latest: promoted.slice(0, 5).map((r) => {
        const d = (r.newData ?? {}) as { agentId?: string; toVersion?: number }
        return { at: r.createdAt.toISOString(), agentName: names(d.agentId ?? ''), summary: firstLine(rationales.get(r.entityId), 120) || `Version ${d.toVersion ?? ''} went live`.trim() }
      }),
    },
    daily: Array.from(daily.entries()).map(([day, v]) => ({ day, finished: v.finished, minutesSaved: Math.round(v.minutesSaved) })),
    agents: Array.from(perAgent.entries())
      .map(([id, a]) => ({ id, name: names(id), role: info.get(id)?.role ?? '', tasks: a.tasks, finished: a.finished, minutesSaved: Math.round(a.minutesSaved), costUsd: Math.round(a.costUsd * 100) / 100, minutesPerTask: info.get(id)?.minutes ?? DEFAULT_TASK_MINUTES }))
      .sort((x, y) => y.minutesSaved - x.minutesSaved),
    activity: recent.map((t) => ({ at: t.at.toISOString(), agentId: t.agentId, agentName: names(t.agentId), kind: t.kind, summary: briefs.get(t.runId) ?? t.summary, status: t.status, runId: t.runId, caseId: t.caseId, conversationId: t.conversationId })),
  }
}
