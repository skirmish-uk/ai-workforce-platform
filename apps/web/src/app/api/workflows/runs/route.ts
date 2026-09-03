import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const page = parseInt(searchParams.get('page') || '1')
    const pageSize = parseInt(searchParams.get('pageSize') || '20')
    const workflowId = searchParams.get('workflowId')
    const status = searchParams.get('status')
    const tenantId = session.user.tenantId

    const userRole = session.user.role as UserRole

    if (!hasPermission(userRole, 'workflow:read')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const where: Record<string, unknown> = { tenantId }
    if (workflowId) where.workflowId = workflowId
    if (status) where.status = status

    const [runs, total] = await Promise.all([
      prisma.workflowRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          workflow: { select: { id: true, name: true } },
          approvals: true,
        },
      }),
      prisma.workflowRun.count({ where }),
    ])

    return NextResponse.json({
      data: runs,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    console.error('Error listing workflow runs:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}