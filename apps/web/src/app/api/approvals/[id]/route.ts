import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { ApprovalError, decideApproval } from '@ai-workforce/executor'
import { enqueueApprovalExecution } from '@ai-workforce/queue'
import { UserRole } from '@prisma/client'
import { z } from 'zod'

const decisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().max(1000).optional(),
})

const STATUS_BY_CODE: Record<ApprovalError['code'], number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  EXPIRED: 410,
  INVALID: 400,
}

/**
 * POST /api/approvals/[id] { decision: "approve" | "reject", reason? }
 *
 * Approval covers exactly the stored action and arguments, nothing else. The
 * decision is recorded here (role/level, tenant and expiry checks in
 * decideApproval); execution of an approved tool call and the workflow resume
 * happen in the worker, never inline in this route.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const parsed = decisionSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation error', details: parsed.error.issues }, { status: 400 })
    }

    const { id } = await params
    const result = await decideApproval({
      approvalId: id,
      decision: parsed.data.decision,
      reason: parsed.data.reason,
      actor: { id: session.user.id, role: session.user.role as UserRole, tenantId: session.user.tenantId },
    })

    if (result.status === 'APPROVED') {
      await enqueueApprovalExecution({ approvalId: id })
    }
    return NextResponse.json({ approvalId: id, status: result.status, queuedExecution: result.status === 'APPROVED' })
  } catch (error) {
    if (error instanceof ApprovalError) {
      return NextResponse.json({ error: error.message }, { status: STATUS_BY_CODE[error.code] })
    }
    console.error('Error deciding approval:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
