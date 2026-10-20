import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { canAccessTenant, hasPermission } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'

const RUN_ACTIONS = ['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_FINISHED', 'AGENT_RUN_ESCALATED', 'AGENT_RUN_BLOCKED_SPEND_CAP']

/**
 * GET /api/agents/[id]/runs?limit=20&includeDryRuns=1 — the agent's recent runs with
 * their full trace (phases, tool calls, Definition-of-Done results, cost), read from
 * the redacted AuditLog rows runAgent writes. Newest first. `?run=<runId>` returns one.
 * Runs removed from the list (DELETE below) are left out.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const role = session.user.role as UserRole
    const { id } = await params
    const agent = await prisma.agent.findUnique({ where: { id }, select: { tenantId: true, isCandidate: true } })
    if (!agent || agent.isCandidate || !canAccessTenant(role, session.user.tenantId, agent.tenantId)) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }
    if (!hasPermission(role, 'agent:read')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const search = new URL(request.url).searchParams
    const limit = Math.min(Math.max(parseInt(search.get('limit') ?? '20', 10) || 20, 1), 100)
    const includeDryRuns = search.get('includeDryRuns') === '1'
    const runId = search.get('run')

    const rows = await prisma.auditLog.findMany({
      where: {
        tenantId: agent.tenantId,
        entityType: 'Agent',
        entityId: id,
        action: { in: RUN_ACTIONS },
        // A run someone removed from the list stays reachable by its id (links from approvals etc.).
        ...(runId ? { newData: { path: ['runId'], equals: runId } } : { hiddenAt: null }),
      },
      orderBy: { createdAt: 'desc' },
      take: runId ? 1 : limit * 3,
      select: { id: true, action: true, createdAt: true, newData: true },
    })

    const runs = rows
      .map((row) => ({ at: row.createdAt, action: row.action, ...((row.newData ?? {}) as Record<string, unknown>) }))
      .filter((run) => runId || includeDryRuns || (run as { dryRun?: unknown }).dryRun !== true)
      .slice(0, limit)
    // Runs that handed work to a person carry where that hand-off stands.
    const runIds = runs.map((r) => (r as { runId?: unknown }).runId).filter((x): x is string => typeof x === 'string')
    const handovers = runIds.length
      ? await prisma.handover.findMany({ where: { runId: { in: runIds }, tenantId: agent.tenantId }, select: { id: true, runId: true, status: true, resolutionNote: true, resolvedAt: true } })
      : []
    const handoverByRun = new Map(handovers.map((h) => [h.runId, h]))
    return NextResponse.json({ data: runs.map((r) => ({ ...r, handover: handoverByRun.get((r as { runId?: string }).runId ?? '') ?? null })) })
  } catch (error) {
    console.error('Error listing agent runs:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/agents/[id]/runs?run=<runId> (one run) or ?all=1 (every run listed)
 *
 * Removes runs from the agent's "Recent runs" list. The audit rows are kept and only marked
 * hidden: spend caps, metrics and the Workforce Manager's evidence still count them, so hiding
 * a run can't be used to get round a spending limit or hide a problem. An AGENT_RUNS_HIDDEN
 * row records who removed what.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const role = session.user.role as UserRole
    const { id } = await params
    const agent = await prisma.agent.findUnique({ where: { id }, select: { tenantId: true, isCandidate: true } })
    if (!agent || agent.isCandidate || !canAccessTenant(role, session.user.tenantId, agent.tenantId)) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }
    if (!hasPermission(role, 'agent:write')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const search = new URL(request.url).searchParams
    const runId = search.get('run')
    const all = search.get('all') === '1'
    if (!runId && !all) return NextResponse.json({ error: 'Pass ?run=<runId> or ?all=1' }, { status: 400 })

    const where = {
      tenantId: agent.tenantId,
      entityType: 'Agent',
      entityId: id,
      action: { in: RUN_ACTIONS },
      hiddenAt: null,
      ...(runId ? { newData: { path: ['runId'], equals: runId } } : {}),
    }
    const now = new Date()
    const { count } = await prisma.auditLog.updateMany({ where, data: { hiddenAt: now } })
    if (count) {
      await prisma.auditLog.create({
        data: {
          action: 'AGENT_RUNS_HIDDEN',
          entityType: 'Agent',
          entityId: id,
          tenantId: agent.tenantId,
          userId: session.user.id,
          newData: { runId: runId ?? null, all, count },
        },
      })
    }
    return NextResponse.json({ hidden: count })
  } catch (error) {
    console.error('Error hiding agent runs:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
