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

    // Only the redacted summary is returned; the exact arguments stay server-side for execution.
    const data = approvals.map(({ input, ...rest }) => {
      const payload = (input ?? {}) as { kind?: string; summary?: unknown; workflowStepId?: string }
      return { ...rest, kind: payload.kind ?? 'unknown', workflowStepId: payload.workflowStepId, summary: payload.summary ?? null }
    })
    return NextResponse.json({ data })
  } catch (error) {
    console.error('Error listing approvals:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
