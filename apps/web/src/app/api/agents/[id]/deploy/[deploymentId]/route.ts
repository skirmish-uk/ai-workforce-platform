import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { enqueueDeployment } from '@ai-workforce/queue'
import { UserRole } from '@prisma/client'

async function checkDeploymentAccess(
  session: { user: { id: string; role: string; tenantId: string } },
  agentId: string,
  deploymentId: string
) {
  const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { agent: true } })
  if (!deployment || deployment.agentId !== agentId) throw new Error('NOT_FOUND')

  if (!canAccessTenant(session.user.role as UserRole, session.user.tenantId, deployment.agent.tenantId)) {
    throw new Error('FORBIDDEN')
  }
  return deployment
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; deploymentId: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id, deploymentId } = await params
    const deployment = await checkDeploymentAccess(session, id, deploymentId)

    return NextResponse.json(deployment)
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Deployment not found' }, { status: 404 })
    }
    console.error('Error fetching deployment:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/** Rolls this deployment back: POST /api/agents/[id]/deploy/[deploymentId] */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; deploymentId: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id, deploymentId } = await params
    const deployment = await checkDeploymentAccess(session, id, deploymentId)

    const userRole = session.user.role as UserRole
    if (!hasPermission(userRole, 'agent:deploy')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (deployment.status !== 'running') {
      return NextResponse.json({ error: `Cannot roll back a deployment with status "${deployment.status}"` }, { status: 400 })
    }

    await prisma.auditLog.create({
      data: {
        action: 'AGENT_DEPLOY_ROLLBACK',
        entityType: 'Deployment',
        entityId: deployment.id,
        tenantId: deployment.agent.tenantId,
        userId: session.user.id,
        oldData: { status: deployment.status },
      },
    })

    await enqueueDeployment({ deploymentId: deployment.id, agentId: id, action: 'rollback' })

    return NextResponse.json({ deploymentId: deployment.id, status: 'rolling_back' })
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Deployment not found' }, { status: 404 })
    }
    console.error('Error rolling back deployment:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
