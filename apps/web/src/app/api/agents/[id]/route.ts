import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { updateAgentSchema } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'

async function checkAgentAccess(session: { user: { id: string; role: string; tenantId: string } }, agentId: string) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } })
  if (!agent) throw new Error('NOT_FOUND')
  
  if (!canAccessTenant(session.user.role as UserRole, session.user.tenantId, agent.tenantId)) {
    throw new Error('FORBIDDEN')
  }
  return agent
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
    await checkAgentAccess(session, id)

    const agent = await prisma.agent.findUnique({
      where: { id },
      include: {
        skills: { include: { skill: true } },
        knowledgeSources: { include: { document: true } },
        workflows: true,
        permissions: true,
        approvalPolicies: true,
        escalationRules: true,
        schedules: true,
        evaluations: true,
        deployments: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    })

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    return NextResponse.json(agent)
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }
    console.error('Error fetching agent:', error)
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
    const agent = await checkAgentAccess(session, id)

    const userRole = session.user.role as UserRole
    if (!hasPermission(userRole, 'agent:write')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const validated = updateAgentSchema.parse(body)

    const updatedAgent = await prisma.agent.update({
      where: { id },
      data: {
        ...validated,
        modelConfig: validated.modelConfig as any,
        config: validated.config as any,
        skills: validated.skills ? {
          deleteMany: {},
          create: validated.skills.map((skillId: string) => ({ skillId, enabled: true }))
        } : undefined,
      },
      include: { skills: { include: { skill: true } } },
    })

    await prisma.auditLog.create({
      data: {
        action: 'AGENT_UPDATE',
        entityType: 'Agent',
        entityId: id,
        tenantId: agent.tenantId,
        userId: session.user.id,
        newData: updatedAgent as any,
      },
    })

    return NextResponse.json(updatedAgent)
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json({ error: 'Validation error', details: error.message }, { status: 400 })
    }
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }
    console.error('Error updating agent:', error)
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
    const agent = await checkAgentAccess(session, id)

    const userRole = session.user.role as UserRole
    if (!hasPermission(userRole, 'agent:delete')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    await prisma.agent.delete({ where: { id } })

    await prisma.auditLog.create({
      data: {
        action: 'AGENT_DELETE',
        entityType: 'Agent',
        entityId: id,
        tenantId: agent.tenantId,
        userId: session.user.id,
        oldData: agent as any,
      },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }
    console.error('Error deleting agent:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}