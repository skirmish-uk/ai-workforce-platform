import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'

async function checkAgentAccess(session: { user: { id: string; role: string; tenantId: string } }, agentId: string) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } })
  if (!agent) throw new Error('NOT_FOUND')
  
  if (!canAccessTenant(session.user.role as UserRole, session.user.tenantId, agent.tenantId)) {
    throw new Error('FORBIDDEN')
  }
  return agent
}

export async function POST(
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
    if (!hasPermission(userRole, 'agent:deploy')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (agent.status === 'PRODUCTION') {
      return NextResponse.json({ error: 'Agent is already deployed' }, { status: 400 })
    }

    const deployment = await prisma.deployment.create({
      data: {
        agentId: agent.id,
        version: agent.version,
        config: agent.config as any,
        status: 'deploying',
      },
    })

    await prisma.agent.update({
      where: { id: agent.id },
      data: { status: 'EVALUATING' },
    })

    await prisma.auditLog.create({
      data: {
        action: 'AGENT_DEPLOY_START',
        entityType: 'Deployment',
        entityId: deployment.id,
        tenantId: agent.tenantId,
        userId: session.user.id,
        newData: { agentId: agent.id, version: agent.version },
      },
    })

    return NextResponse.json({ deploymentId: deployment.id, status: 'deploying' }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }
    console.error('Error starting deployment:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}