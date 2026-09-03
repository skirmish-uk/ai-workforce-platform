import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { getTenantById, updateTenant, deleteTenant, updateTenantSchema, getTenantStats } from '@ai-workforce/domain'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'

async function checkTenantAccess(session: { user: { id: string; role: string; tenantId: string } }, tenantId: string) {
  const userRole = session.user.role as UserRole
  if (!canAccessTenant(userRole, session.user.tenantId, tenantId)) {
    throw new Error('FORBIDDEN')
  }
  if (!hasPermission(userRole, 'tenant:read')) {
    throw new Error('FORBIDDEN')
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    await checkTenantAccess(session, id)

    const tenant = await getTenantById(id)
    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 })
    }

    const stats = await getTenantStats(id)
    return NextResponse.json({ ...tenant, stats })
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    console.error('Error fetching tenant:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const userRole = session.user.role as UserRole

    if (!canAccessTenant(userRole, session.user.tenantId, id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (!hasPermission(userRole, 'tenant:write')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const validated = updateTenantSchema.parse(body)

    const tenant = await updateTenant(id, validated, session.user.id)
    return NextResponse.json(tenant)
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json({ error: 'Validation error', details: error.message }, { status: 400 })
    }
    console.error('Error updating tenant:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const userRole = session.user.role as UserRole

    if (!canAccessTenant(userRole, session.user.tenantId, id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (!hasPermission(userRole, 'tenant:delete')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    await deleteTenant(id, session.user.id)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting tenant:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}