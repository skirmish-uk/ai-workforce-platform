import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { canAccessTenant, hasPermission } from '@ai-workforce/domain'
import { groupConversations, isConversationId, runMessage } from '@ai-workforce/executor'
import { UserRole } from '@prisma/client'

const RUN_ACTIONS = ['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_FINISHED', 'AGENT_RUN_ESCALATED', 'AGENT_RUN_BLOCKED_SPEND_CAP']

/**
 * GET /api/agents/[id]/runs?limit=20&includeDryRuns=1 — the agent's recent runs with
 * their full trace (phases, tool calls, Definition-of-Done results, cost), read from
 * the redacted AuditLog rows runAgent writes. Newest first. `?run=<runId>` returns one.
 * Runs removed from the list (DELETE below) are left out.
 *
 * `?view=conversations` groups them instead: each item is one conversation (a typed task and its
 * follow-ups, or one voice call) with its runs oldest first, the `limit` most recent conversations.
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
    const conversations = search.get('view') === 'conversations' && !runId

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
      take: runId ? 1 : conversations ? Math.min(limit * 12, 400) : limit * 3,
      select: { id: true, action: true, createdAt: true, newData: true, hiddenAt: true },
    })

    const all = rows
      .map((row) => {
        const data = (row.newData ?? {}) as Record<string, unknown>
        return {
          ...data,
          runId: String(data.runId ?? row.id),
          at: row.createdAt,
          action: row.action,
          trigger: typeof data.trigger === 'string' ? data.trigger : undefined,
          input: typeof data.input === 'string' ? data.input : undefined,
          costUsd: typeof data.costUsd === 'number' ? data.costUsd : null,
          conversationId: isConversationId(data.conversationId) ? data.conversationId : undefined,
          message: runMessage({ message: typeof data.message === 'string' ? data.message : undefined, input: typeof data.input === 'string' ? data.input : undefined }),
          hidden: row.hiddenAt !== null,
        }
      })
      .filter((run) => runId || includeDryRuns || (run as { dryRun?: unknown }).dryRun !== true)
    const grouped = conversations ? groupConversations(all).slice(0, limit) : null
    const runs = grouped ? grouped.flatMap((c) => c.runs) : all.slice(0, limit)
    // Runs that handed work to a person carry where that hand-off stands.
    const runIds = runs.map((r) => r.runId)
    const handovers = runIds.length
      ? await prisma.handover.findMany({ where: { runId: { in: runIds }, tenantId: agent.tenantId }, select: { id: true, runId: true, status: true, resolutionNote: true, resolvedAt: true } })
      : []
    const handoverByRun = new Map(handovers.map((h) => [h.runId, h]))
    // Runs that paused for a decision carry what they proposed (the same redacted summary the
    // Approvals inbox shows), so a conversation shows the draft, not just "waiting for approval".
    const approvals = runIds.length
      ? await prisma.approval.findMany({ where: { runId: { in: runIds }, tenantId: agent.tenantId }, orderBy: { createdAt: 'asc' }, select: { id: true, runId: true, status: true, action: true, input: true } })
      : []
    const approvalByRun = new Map(approvals.map(({ input, ...a }) => [a.runId, { ...a, material: ((input ?? {}) as { summary?: { material?: unknown } }).summary?.material ?? null }]))
    const withHandover = <R extends { runId: string }>(r: R) => ({ ...r, handover: handoverByRun.get(r.runId) ?? null, approval: approvalByRun.get(r.runId) ?? null })
    if (grouped) return NextResponse.json({ data: grouped.map((c) => ({ ...c, runs: c.runs.map(withHandover) })) })
    return NextResponse.json({ data: runs.map(withHandover) })
  } catch (error) {
    console.error('Error listing agent runs:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/agents/[id]/runs?run=<runId> (one run), ?conversation=<id> (every run in a
 * conversation), ?runs=<id>,<id> (several, e.g. an older call grouped by time) or ?all=1
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
    const conversationId = search.get('conversation')
    const runIds = (search.get('runs') ?? '').split(',').map((r) => r.trim()).filter(Boolean).slice(0, 100)
    const all = search.get('all') === '1'
    if (conversationId !== null && !isConversationId(conversationId)) return NextResponse.json({ error: 'Invalid conversation id' }, { status: 400 })
    if (!runId && !conversationId && !runIds.length && !all) {
      return NextResponse.json({ error: 'Pass ?run=<runId>, ?conversation=<id>, ?runs=<ids> or ?all=1' }, { status: 400 })
    }

    const where = {
      tenantId: agent.tenantId,
      entityType: 'Agent',
      entityId: id,
      action: { in: RUN_ACTIONS },
      hiddenAt: null,
      ...(runId
        ? { newData: { path: ['runId'], equals: runId } }
        : conversationId
          ? { newData: { path: ['conversationId'], equals: conversationId } }
          : runIds.length
            ? { OR: runIds.map((r) => ({ newData: { path: ['runId'], equals: r } })) }
            : {}),
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
          newData: { runId: runId ?? null, conversationId: conversationId ?? null, runIds: runIds.length ? runIds : undefined, all, count },
        },
      })
    }
    return NextResponse.json({ hidden: count })
  } catch (error) {
    console.error('Error hiding agent runs:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
