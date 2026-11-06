import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'

export const dynamic = 'force-dynamic'

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTING', 'EXECUTED', 'EXECUTION_FAILED']

/**
 * GET /api/approvals?status=PENDING — approval requests for the caller's tenant
 * (platform roles may pass ?tenantId=). Each item carries the approver summary:
 * action, target, risk class, side effects, redacted material content, rationale
 * and evidence (run id, agent version).
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const role = session.user.role as UserRole
    if (!hasPermission(role, 'workflow:read')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const params = new URL(request.url).searchParams
    const isPlatform = role === 'PLATFORM_ADMIN' || role === 'PLATFORM_OPERATOR'
    const tenantId = isPlatform && params.get('tenantId') ? params.get('tenantId')! : session.user.tenantId
    const status = params.get('status')?.toUpperCase()
    if (status && !STATUSES.includes(status)) {
      return NextResponse.json({ error: `status must be one of ${STATUSES.join(', ')}` }, { status: 400 })
    }

    const approvals = await prisma.approval.findMany({
      where: { tenantId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        action: true,
        level: true,
        status: true,
        expiresAt: true,
        agentId: true,
        runId: true,
        workflowRunId: true,
        decidedById: true,
        decidedAt: true,
        reason: true,
        createdAt: true,
        input: true,
      },
    })

    const agentIds = Array.from(new Set(approvals.map((a) => a.agentId).filter((id): id is string => Boolean(id))))
    const agents = agentIds.length
      ? await prisma.agent.findMany({ where: { id: { in: agentIds }, tenantId }, select: { id: true, name: true } })
      : []
    const agentName = new Map(agents.map((a) => [a.id, a.name]))
    const sandboxConnections = new Set(
      (await prisma.integration.findMany({ where: { tenantId, isActive: true }, select: { name: true, config: true } }))
        .filter((i) => (i.config as Record<string, unknown> | null)?.sandbox === true)
        .map((i) => i.name)
    )

    // Only the redacted summary is returned; the exact arguments stay server-side for execution.
    const data = approvals.map(({ input, ...rest }) => {
      const payload = (input ?? {}) as { kind?: string; summary?: unknown; workflowStepId?: string; revisionId?: string }
      return {
        ...rest,
        agentName: rest.agentId ? agentName.get(rest.agentId) ?? null : null,
        kind: payload.kind ?? 'unknown',
        workflowStepId: payload.workflowStepId,
        revisionId: payload.revisionId,
        summary: payload.summary ?? null,
        // The action runs against a sandbox connection: fictional data, nothing real is sent.
        sandbox: sandboxConnections.has(String((payload.summary as { target?: unknown } | undefined)?.target ?? '')),
      }
    })
    return NextResponse.json({ data })
  } catch (error) {
    console.error('Error listing approvals:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
