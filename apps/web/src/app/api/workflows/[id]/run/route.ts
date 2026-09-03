import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'

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
    const workflow = await prisma.workflow.findUnique({ where: { id } })
    if (!workflow) {
      return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
    }

    const userRole = session.user.role as UserRole
    if (!canAccessTenant(userRole, session.user.tenantId, workflow.tenantId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (!hasPermission(userRole, 'workflow:execute')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const input = body.input || {}

    const run = await prisma.workflowRun.create({
      data: {
        workflowId: workflow.id,
        tenantId: workflow.tenantId,
        input,
        status: 'PENDING',
      },
    })

    await prisma.auditLog.create({
      data: {
        action: 'WORKFLOW_RUN_START',
        entityType: 'WorkflowRun',
        entityId: run.id,
        tenantId: workflow.tenantId,
        userId: session.user.id,
        newData: { workflowId: workflow.id, input },
      },
    })

    return NextResponse.json({ runId: run.id, status: 'PENDING' }, { status: 201 })
  } catch (error) {
    console.error('Error starting workflow run:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}