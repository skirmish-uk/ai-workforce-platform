import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { canAccessTenant, hasPermission } from '@ai-workforce/domain'
import { RevisionError, rollbackRevision } from '@ai-workforce/executor'
import { UserRole } from '@prisma/client'
import { z } from 'zod'

const rollbackSchema = z.object({ reason: z.string().min(3).max(1000) })

/**
 * POST /api/revisions/[id]/rollback { reason } — undo a promoted revision: the
 * previous definition is re-applied as a new agent version (a created agent is
 * paused; a retired agent is restored). Refused if the agent changed again since.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const role = session.user.role as UserRole
    const { id } = await params
    const revision = await prisma.agentRevision.findUnique({ where: { id }, select: { tenantId: true } })
    if (!revision || !canAccessTenant(role, session.user.tenantId, revision.tenantId)) {
      return NextResponse.json({ error: 'Revision not found' }, { status: 404 })
    }
    if (!hasPermission(role, 'agent:deploy')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const parsed = rollbackSchema.safeParse(await request.json())
    if (!parsed.success) return NextResponse.json({ error: 'Validation error', details: parsed.error.issues }, { status: 400 })

    const outcome = await rollbackRevision(id, { reason: parsed.data.reason, userId: session.user.id })
    return NextResponse.json(outcome)
  } catch (error) {
    if (error instanceof RevisionError) {
      return NextResponse.json({ error: error.message }, { status: error.code === 'NOT_FOUND' ? 404 : 409 })
    }
    console.error('Error rolling back revision:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
