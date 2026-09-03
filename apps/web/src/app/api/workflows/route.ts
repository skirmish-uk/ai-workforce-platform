import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'
import { createWorkflowSchema, paginationSchema } from '@ai-workforce/domain'

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const page = parseInt(searchParams.get('page') || '1')
    const pageSize = parseInt(searchParams.get('pageSize') || '20')
    const search = searchParams.get('search') || undefined
    const isActive = searchParams.get('isActive')
    const tenantId = session.user.tenantId

    const userRole = session.user.role as UserRole

    if (!hasPermission(userRole, 'workflow:read')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const where: Record<string, unknown> = { tenantId }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ]
    }
    if (isActive !== null) {
      where.isActive = isActive === 'true'
    }

    const [workflows, total] = await Promise.all([
      prisma.workflow.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          agent: { select: { id: true, name: true } },
          _count: { select: { runs: true } },
        },
      }),
      prisma.workflow.count({ where }),
    ])

    return NextResponse.json({
      data: workflows,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    console.error('Error listing workflows:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userRole = session.user.role as UserRole

    if (!hasPermission(userRole, 'workflow:write')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const validated = createWorkflowSchema.parse(body)

    if (!canAccessTenant(userRole, session.user.tenantId, validated.tenantId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const workflow = await prisma.workflow.create({
      data: {
        ...validated,
        description: validated.description || '',
        trigger: validated.trigger as any,
        steps: validated.steps as any,
        config: validated.config as any,
        retryPolicy: validated.retryPolicy as any,
      },
    })

    await prisma.auditLog.create({
      data: {
        action: 'WORKFLOW_CREATE',
        entityType: 'Workflow',
        entityId: workflow.id,
        tenantId: validated.tenantId,
        userId: session.user.id,
        newData: workflow as any,
      },
    })

    return NextResponse.json(workflow, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json({ error: 'Validation error', details: error.message }, { status: 400 })
    }
    console.error('Error creating workflow:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}