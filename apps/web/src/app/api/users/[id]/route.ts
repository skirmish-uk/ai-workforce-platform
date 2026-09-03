import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { updateUserSchema } from '@ai-workforce/domain'
import { hash } from 'bcryptjs'
import { UserRole } from '@prisma/client'

async function checkUserAccess(session: { user: { id: string; role: string; tenantId: string } }, targetUserId: string) {
  const targetUser = await prisma.user.findUnique({ where: { id: targetUserId } })
  if (!targetUser) throw new Error('NOT_FOUND')
  
  if (!canAccessTenant(session.user.role as UserRole, session.user.tenantId, targetUser.tenantId)) {
    throw new Error('FORBIDDEN')
  }
  return targetUser
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
    await checkUserAccess(session, id)

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        image: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
        tenant: {
          select: { id: true, name: true, slug: true },
        },
      },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    return NextResponse.json(user)
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }
    console.error('Error fetching user:', error)
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
    const targetUser = await checkUserAccess(session, id)

    const userRole = session.user.role as UserRole
    if (!hasPermission(userRole, 'user:write')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const validated = updateUserSchema.parse(body)

    if (validated.tenantId && !canAccessTenant(userRole, session.user.tenantId, validated.tenantId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const updateData: Record<string, unknown> = {}
    if (validated.name !== undefined) updateData.name = validated.name
    if (validated.role !== undefined) updateData.role = validated.role
    if (validated.password !== undefined) {
      updateData.passwordHash = await hash(validated.password, 12)
    }
    if (validated.tenantId !== undefined) updateData.tenantId = validated.tenantId

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
    })

    await prisma.auditLog.create({
      data: {
        action: 'USER_UPDATE',
        entityType: 'User',
        entityId: id,
        tenantId: targetUser.tenantId,
        userId: session.user.id,
        newData: user,
      },
    })

    return NextResponse.json(user)
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json({ error: 'Validation error', details: error.message }, { status: 400 })
    }
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }
    console.error('Error updating user:', error)
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
    const targetUser = await checkUserAccess(session, id)

    const userRole = session.user.role as UserRole
    if (!hasPermission(userRole, 'user:delete')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (id === session.user.id) {
      return NextResponse.json({ error: 'Cannot delete yourself' }, { status: 400 })
    }

    await prisma.user.delete({ where: { id } })

    await prisma.auditLog.create({
      data: {
        action: 'USER_DELETE',
        entityType: 'User',
        entityId: id,
        tenantId: targetUser.tenantId,
        userId: session.user.id,
        oldData: targetUser,
      },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }
    console.error('Error deleting user:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}