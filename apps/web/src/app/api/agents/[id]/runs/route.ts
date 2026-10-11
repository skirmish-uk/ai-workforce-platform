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
        ...(runId ? { newData: { path: ['runId'], equals: runId } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: runId ? 1 : limit * 3,
      select: { id: true, action: true, createdAt: true, newData: true },
    })

    const runs = rows
      .map((row) => ({ at: row.createdAt, action: row.action, ...((row.newData ?? {}) as Record<string, unknown>) }))
      .filter((run) => runId || includeDryRuns || (run as { dryRun?: unknown }).dryRun !== true)
      .slice(0, limit)
    return NextResponse.json({ data: runs })
  } catch (error) {
    console.error('Error listing agent runs:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
