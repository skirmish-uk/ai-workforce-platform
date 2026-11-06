import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { canAccessTenant, hasPermission, redactString } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  action: z.enum(['resolve', 'reopen']),
  /** What the person did about it, kept with the handover. */
  note: z.string().max(4000).optional(),
})

/** POST /api/handovers/[id] {"action":"resolve","note":"Called Maria back, sent the proposal"} or {"action":"reopen"} */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const role = session.user.role as UserRole
    if (!hasPermission(role, 'agent:write')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const { id } = await params
    const handover = await prisma.handover.findUnique({ where: { id } })
    if (!handover || !canAccessTenant(role, session.user.tenantId, handover.tenantId)) return NextResponse.json({ error: 'Handover not found' }, { status: 404 })

    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success) return NextResponse.json({ error: 'Send {"action":"resolve","note":"..."} or {"action":"reopen"}' }, { status: 400 })
    const { action, note } = parsed.data

    // Conditional update: two people resolving at once don't overwrite each other's note.
    const { count } = await prisma.handover.updateMany({
      where: { id, status: action === 'resolve' ? 'OPEN' : 'RESOLVED' },
      data: action === 'resolve'
        ? { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: session.user.id, resolutionNote: note?.trim() ? redactString(note.trim(), 4000) : null }
        : { status: 'OPEN', resolvedAt: null, resolvedById: null },
    })
    if (!count) return NextResponse.json({ error: action === 'resolve' ? 'Someone has already marked this handled' : 'This handover is already open' }, { status: 409 })

    await prisma.auditLog.create({
      data: {
        action: action === 'resolve' ? 'HANDOVER_RESOLVED' : 'HANDOVER_REOPENED',
        entityType: 'Handover',
        entityId: id,
        tenantId: handover.tenantId,
        userId: session.user.id,
        newData: { handoverId: id, runId: handover.runId, agentId: handover.agentId, note: note?.trim() || null },
      },
    })
    return NextResponse.json(await prisma.handover.findUnique({ where: { id } }))
  } catch (error) {
    console.error('Error updating handover:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
