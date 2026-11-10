import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { resolveAgentContract, validateNewAgentVoice } from '@ai-workforce/executor'
import { UserRole } from '@prisma/client'
import { createAgentSchema, paginationSchema } from '@ai-workforce/domain'

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
    const status = searchParams.get('status') || undefined
    const tenantId = session.user.tenantId

    const userRole = session.user.role as UserRole

    if (!hasPermission(userRole, 'agent:read')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const where: Record<string, unknown> = { tenantId, isCandidate: false }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { role: { contains: search, mode: 'insensitive' } },
      ]
    }
    if (status) {
      where.status = status
    }

    const [agents, total] = await Promise.all([
      prisma.agent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          skills: { include: { skill: true } },
          _count: { select: { workflows: true, knowledgeSources: true } },
        },
      }),
      prisma.agent.count({ where }),
    ])

    return NextResponse.json({
      data: agents,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    console.error('Error listing agents:', error)
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

    if (!hasPermission(userRole, 'agent:write')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const validated = createAgentSchema.parse(body)

    const contractCheck = resolveAgentContract({ config: validated.config as any, mission: validated.mission })
    if (contractCheck.errors.length) {
      return NextResponse.json({ error: 'Invalid agent contract', details: contractCheck.errors }, { status: 400 })
    }
    const voiceError = validateNewAgentVoice(validated.config)
    if (voiceError) return NextResponse.json({ error: `Invalid voice settings: ${voiceError}` }, { status: 400 })
    if (validated.status === 'PRODUCTION' || validated.status === 'EVALUATING') {
      return NextResponse.json({ error: 'New agents start as DRAFT; deploy them via POST /api/agents/[id]/deploy' }, { status: 400 })
    }

    if (!canAccessTenant(userRole, session.user.tenantId, validated.tenantId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { skills, ...agentData } = validated

    const agent = await prisma.agent.create({
      data: {
        ...agentData,
        modelConfig: agentData.modelConfig as any,
        config: agentData.config as any,
        skills: skills ? {
          create: skills.map((skillId: string) => ({ skillId, enabled: true }))
        } : undefined,
      },
      include: { skills: { include: { skill: true } } },
    })

    await prisma.auditLog.create({
      data: {
        action: 'AGENT_CREATE',
        entityType: 'Agent',
        entityId: agent.id,
        tenantId: validated.tenantId,
        userId: session.user.id,
        newData: agent as any,
      },
    })

    return NextResponse.json(agent, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json({ error: 'Validation error', details: error.message }, { status: 400 })
    }
    console.error('Error creating agent:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}