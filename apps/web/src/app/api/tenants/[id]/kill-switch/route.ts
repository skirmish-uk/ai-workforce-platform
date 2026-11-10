import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { canAccessTenant, hasPermission } from '@ai-workforce/domain'
import { readKillSwitch } from '@ai-workforce/executor'
import { toolRegistry } from '@ai-workforce/tools'
import { Prisma, UserRole } from '@prisma/client'
import { z } from 'zod'

const killSwitchSchema = z
  .object({
    agentsDisabled: z.boolean().optional(),
    disabledTools: z.array(z.string()).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict()

function authorized(session: { user: { role: string; tenantId: string } }, tenantId: string): boolean {
  const role = session.user.role as UserRole
  if (!canAccessTenant(role, session.user.tenantId, tenantId)) return false
  return hasPermission(role, 'tenant:write') || hasPermission(role, 'settings:write')
}

/** GET /api/tenants/[id]/kill-switch — current tenant + platform-wide state. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  if (!authorized(session, id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const tenant = await prisma.tenant.findUnique({ where: { id }, select: { settings: true } })
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 })
  return NextResponse.json(readKillSwitch(tenant.settings))
}

/**
 * PUT /api/tenants/[id]/kill-switch { agentsDisabled?, disabledTools?, reason? }
 *
 * Emergency stop for one tenant without a deploy: agentsDisabled blocks every
 * new run and every pending approved action; disabledTools revokes specific
 * tools immediately. Merges into Tenant.settings (unlike PUT /api/tenants/[id],
 * which replaces settings wholesale). Takes effect on the next run/tool call.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    if (!authorized(session, id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const parsed = killSwitchSchema.safeParse(await request.json())
    if (!parsed.success) return NextResponse.json({ error: 'Validation error', details: parsed.error.issues }, { status: 400 })
    const unknown = (parsed.data.disabledTools ?? []).filter((t) => !toolRegistry.has(t))
    if (unknown.length) return NextResponse.json({ error: `Unknown tools: ${unknown.join(', ')}` }, { status: 400 })

    const tenant = await prisma.tenant.findUnique({ where: { id }, select: { settings: true } })
    if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 })
    const settings = (tenant.settings && typeof tenant.settings === 'object' ? tenant.settings : {}) as Record<string, unknown>
    const previous = (settings.killSwitch ?? {}) as Record<string, unknown>
    const next = { ...previous, ...parsed.data, updatedAt: new Date().toISOString(), updatedBy: session.user.id }

    await prisma.tenant.update({ where: { id }, data: { settings: { ...settings, killSwitch: next } as Prisma.InputJsonValue } })
    await prisma.auditLog.create({
      data: {
        action: 'KILL_SWITCH_UPDATED',
        entityType: 'Tenant',
        entityId: id,
        tenantId: id,
        userId: session.user.id,
        oldData: previous as Prisma.InputJsonValue,
        newData: next as Prisma.InputJsonValue,
      },
    })
    return NextResponse.json(readKillSwitch({ killSwitch: next }))
  } catch (error) {
    console.error('Error updating kill switch:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
