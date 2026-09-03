import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'
import { createSkillSchema, paginationSchema } from '@ai-workforce/domain'

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

    if (!hasPermission(userRole, 'skill:read')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const where: Record<string, unknown> = {
      OR: [{ tenantId }, { tenantId: null }],
    }
    if (search) {
      where.AND = [{ name: { contains: search, mode: 'insensitive' } }]
    }
    if (isActive !== null) {
      where.isActive = isActive === 'true'
    }

    const [skills, total] = await Promise.all([
      prisma.skill.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          _count: { select: { agents: true } },
        },
      }),
      prisma.skill.count({ where }),
    ])

    return NextResponse.json({
      data: skills,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    console.error('Error listing skills:', error)
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

    if (!hasPermission(userRole, 'skill:write')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const validated = createSkillSchema.parse(body)

    const tenantId = validated.tenantId || null

    if (tenantId && !canAccessTenant(userRole, session.user.tenantId, tenantId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const existing = await prisma.skill.findFirst({
      where: { name: validated.name, version: validated.version, tenantId },
    })
    if (existing) {
      return NextResponse.json({ error: 'Skill with this name and version already exists' }, { status: 409 })
    }

    const skill = await prisma.skill.create({
      data: {
        ...validated,
        tenantId,
        metadata: validated.metadata as any,
        inputs: validated.inputs as any,
        outputs: validated.outputs as any,
        failureHandling: validated.failureHandling as any,
        evaluationCases: validated.evaluationCases as any,
      },
    })

    await prisma.auditLog.create({
      data: {
        action: 'SKILL_CREATE',
        entityType: 'Skill',
        entityId: skill.id,
        tenantId: tenantId || session.user.tenantId,
        userId: session.user.id,
        newData: skill as any,
      },
    })

    return NextResponse.json(skill, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json({ error: 'Validation error', details: error.message }, { status: 400 })
    }
    console.error('Error creating skill:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}