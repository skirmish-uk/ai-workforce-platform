import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission } from '@ai-workforce/domain'
import { proposeRevision, RevisionError } from '@ai-workforce/executor'
import { enqueueRevision } from '@ai-workforce/queue'
import { UserRole } from '@prisma/client'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const STATUS_BY_CODE: Record<RevisionError['code'], number> = {
  DISABLED: 409,
  NOT_FOUND: 404,
  INVALID: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
}

/**
 * GET /api/revisions?status=&agentId= — agent revisions for the caller's tenant
 * (platform roles may pass ?tenantId=): what the Workforce Manager (or a human)
 * proposed, and how far each got through evaluation, replay, approval and the watch.
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
    const status = params.get('status')?.toUpperCase()
    const agentId = params.get('agentId')

    const revisions = await prisma.agentRevision.findMany({
      where: { tenantId, ...(status ? { status } : {}), ...(agentId ? { agentId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        changeType: true,
        status: true,
        agentId: true,
        rationale: true,
        risk: true,
        error: true,
        baseVersion: true,
        promotedVersion: true,
        approvalId: true,
        proposedByAgentId: true,
        proposedByUserId: true,
        promotedAt: true,
        watchUntil: true,
        createdAt: true,
      },
    })
    const ids = Array.from(new Set(revisions.flatMap((r) => [r.agentId, r.proposedByAgentId]).filter((v): v is string => Boolean(v))))
    const agents = ids.length ? await prisma.agent.findMany({ where: { id: { in: ids }, tenantId }, select: { id: true, name: true } }) : []
    const name = new Map(agents.map((a) => [a.id, a.name]))
    return NextResponse.json({
      data: revisions.map((r) => ({
        ...r,
        agentName: r.agentId ? name.get(r.agentId) ?? null : null,
        proposedByName: r.proposedByAgentId ? name.get(r.proposedByAgentId) ?? null : null,
      })),
    })
  } catch (error) {
    console.error('Error listing revisions:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const proposeSchema = z.object({
  changeType: z.enum(['create', 'update', 'retire']),
  agentId: z.string().optional(),
  rationale: z.string().min(10).max(4000),
  changes: z.record(z.unknown()).optional(),
  addEvaluationCases: z.array(z.unknown()).max(50).optional(),
})

/**
 * POST /api/revisions — a human proposes a change through the same pipeline the
 * manager uses (same limits, evaluation, replay and approval rules). Useful for
 * testing a change safely instead of editing a live agent with PUT /api/agents/[id].
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const role = session.user.role as UserRole
    if (!hasPermission(role, 'agent:write')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const parsed = proposeSchema.safeParse(await request.json())
    if (!parsed.success) return NextResponse.json({ error: 'Validation error', details: parsed.error.issues }, { status: 400 })

    const result = await proposeRevision({ ...parsed.data, tenantId: session.user.tenantId, proposedBy: { userId: session.user.id } })
    await enqueueRevision({ revisionId: result.revisionId })
    return NextResponse.json({ ...result, status: 'PROPOSED' }, { status: 201 })
  } catch (error) {
    if (error instanceof RevisionError) {
      return NextResponse.json({ error: error.message, code: error.code, issues: error.issues }, { status: STATUS_BY_CODE[error.code] })
    }
    console.error('Error proposing revision:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
