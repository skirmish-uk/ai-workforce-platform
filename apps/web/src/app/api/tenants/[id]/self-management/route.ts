import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { canAccessTenant, hasPermission } from '@ai-workforce/domain'
import { readSelfManagementPolicy, selfManagementPolicySchema } from '@ai-workforce/executor'
import { Prisma, UserRole } from '@prisma/client'

function authorized(session: { user: { role: string; tenantId: string } }, tenantId: string, write: boolean): boolean {
  const role = session.user.role as UserRole
  if (!canAccessTenant(role, session.user.tenantId, tenantId)) return false
  return write ? hasPermission(role, 'tenant:write') || hasPermission(role, 'settings:write') : hasPermission(role, 'settings:read') || hasPermission(role, 'tenant:read')
}

/** GET /api/tenants/[id]/self-management — effective policy (defaults applied). */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  if (!authorized(session, id, false)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const tenant = await prisma.tenant.findUnique({ where: { id }, select: { settings: true } })
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 })
  return NextResponse.json(readSelfManagementPolicy(tenant.settings))
}

/**
 * PUT /api/tenants/[id]/self-management { enabled?, maxAutonomyStage?, ... }
 *
 * Human-only switch for the Workforce Manager and the revision pipeline. Merges
 * into Tenant.settings.selfManagement; no agent tool can call this.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    if (!authorized(session, id, true)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const tenant = await prisma.tenant.findUnique({ where: { id }, select: { settings: true } })
    if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 })
    const settings = (tenant.settings && typeof tenant.settings === 'object' ? tenant.settings : {}) as Record<string, unknown>
    const previous = (settings.selfManagement ?? {}) as Record<string, unknown>
    const body = (await request.json()) as Record<string, unknown>
    const parsed = selfManagementPolicySchema.safeParse({ ...previous, ...body })
    if (!parsed.success) return NextResponse.json({ error: 'Validation error', details: parsed.error.issues }, { status: 400 })

    await prisma.tenant.update({ where: { id }, data: { settings: { ...settings, selfManagement: parsed.data } as Prisma.InputJsonValue } })
    await prisma.auditLog.create({
      data: {
        action: 'SELF_MANAGEMENT_UPDATED',
        entityType: 'Tenant',
        entityId: id,
        tenantId: id,
        userId: session.user.id,
        oldData: previous as Prisma.InputJsonValue,
        newData: parsed.data as unknown as Prisma.InputJsonValue,
      },
    })
    return NextResponse.json({ policy: parsed.data })
  } catch (error) {
    console.error('Error updating self-management policy:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
