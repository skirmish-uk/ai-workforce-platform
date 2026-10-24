import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { canAccessTenant, canApprove, hasPermission, redactString } from '@ai-workforce/domain'
import { MEMORY_CATEGORIES, MEMORY_MAX_CHARS } from '@ai-workforce/executor'
import type { UserRole } from '@prisma/client'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  content: z.string().trim().min(3).max(MEMORY_MAX_CHARS).optional(),
  category: z.enum(MEMORY_CATEGORIES).optional(),
  subject: z.string().trim().max(120).nullable().optional(),
  /** ACTIVE: confirm (or restore); ARCHIVED: stop using it. */
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
})

async function load(id: string) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const role = session.user.role as UserRole
  const memory = await prisma.memory.findUnique({ where: { id } })
  if (!memory || !canAccessTenant(role, session.user.tenantId, memory.tenantId)) return { error: NextResponse.json({ error: 'Memory not found' }, { status: 404 }) }
  if (!hasPermission(role, 'agent:write')) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  return { session, role, memory }
}

/**
 * PATCH /api/memory/[id] — edit, confirm (status ACTIVE: a person vouches for it, so it becomes
 * trusted) or archive. Confirming a waiting memory needs an admin (it changes what every agent
 * does). Editing an agent's memory makes it a person's.
 * DELETE — removes it for good.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const loaded = await load(id)
  if (loaded.error) return loaded.error
  const { session, role, memory } = loaded
  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid change' }, { status: 400 })
  const change = parsed.data
  const confirming = change.status === 'ACTIVE' && memory.status === 'PENDING'
  if (confirming && !canApprove(role, 'CUSTOMER_APPROVAL')) return NextResponse.json({ error: 'Only an admin can confirm what the team has learned' }, { status: 403 })
  const edited = change.content !== undefined && change.content !== memory.content

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.memory.update({
      where: { id },
      data: {
        ...(change.content !== undefined ? { content: redactString(change.content, MEMORY_MAX_CHARS) } : {}),
        ...(change.category ? { category: change.category } : {}),
        ...(change.subject !== undefined ? { subject: change.subject || null } : {}),
        ...(change.status ? { status: change.status } : {}),
        ...(confirming || edited ? { trust: 'staff', reviewedById: session.user.id, reviewedAt: new Date() } : {}),
      },
    })
    // A confirmed correction takes over from the memory it replaces.
    if (confirming && memory.replacesId) await tx.memory.updateMany({ where: { id: memory.replacesId, tenantId: memory.tenantId }, data: { status: 'ARCHIVED' } })
    await tx.auditLog.create({
      data: { action: confirming ? 'MEMORY_CONFIRMED' : change.status === 'ARCHIVED' ? 'MEMORY_ARCHIVED' : 'MEMORY_EDITED', entityType: 'Memory', entityId: id, tenantId: memory.tenantId, userId: session.user.id, oldData: { content: memory.content, status: memory.status }, newData: { content: row.content, status: row.status } },
    })
    return row
  })
  return NextResponse.json({ id: updated.id, status: updated.status })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const loaded = await load(id)
  if (loaded.error) return loaded.error
  await prisma.memory.delete({ where: { id } })
  await prisma.auditLog.create({ data: { action: 'MEMORY_DELETED', entityType: 'Memory', entityId: id, tenantId: loaded.memory.tenantId, userId: loaded.session.user.id, oldData: { content: loaded.memory.content } } })
  return NextResponse.json({ deleted: true })
}
