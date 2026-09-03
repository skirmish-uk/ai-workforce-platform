import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { updateWorkflowSchema } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'

async function checkWorkflowAccess(session: { user: { id: string; role: string; tenantId: string } }, workflowId: string) {
  const workflow = await prisma.workflow.findUnique({ where: { id: workflowId } })
  if (!workflow) throw new Error('NOT_FOUND')
  
  if (!canAccessTenant(session.user.role as UserRole, session.user.tenantId, workflow.tenantId)) {
    throw new Error('FORBIDDEN')
  }
  return workflow
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
    await checkWorkflowAccess(session, id)

    const workflow = await prisma.workflow.findUnique({
      where: { id },
      include: {
        agent: { select: { id: true, name: true } },
        runs: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { approvals: true },
        },
      },
    })

    if (!workflow) {
      return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
    }

    return NextResponse.json(workflow)
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
    }
    console.error('Error fetching workflow:', error)
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
    const workflow = await checkWorkflowAccess(session, id)

    const userRole = session.user.role as UserRole
    if (!hasPermission(userRole, 'workflow:write')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const validated = updateWorkflowSchema.parse(body)

    const updatedWorkflow = await prisma.workflow.update({
      where: { id },
      data: {
        ...validated,
        trigger: validated.trigger as any,
        steps: validated.steps as any,
        config: validated.config as any,
        retryPolicy: validated.retryPolicy as any,
      },
    })

    await prisma.auditLog.create({
      data: {
        action: 'WORKFLOW_UPDATE',
        entityType: 'Workflow',
        entityId: id,
        tenantId: workflow.tenantId,
        userId: session.user.id,
        newData: updatedWorkflow as any,
      },
    })

    return NextResponse.json(updatedWorkflow)
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json({ error: 'Validation error', details: error.message }, { status: 400 })
    }
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
    }
    console.error('Error updating workflow:', error)
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
    const workflow = await checkWorkflowAccess(session, id)

    const userRole = session.user.role as UserRole
    if (!hasPermission(userRole, 'workflow:delete')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    await prisma.workflow.delete({ where: { id } })

    await prisma.auditLog.create({
      data: {
        action: 'WORKFLOW_DELETE',
        entityType: 'Workflow',
        entityId: id,
        tenantId: workflow.tenantId,
        userId: session.user.id,
        oldData: workflow as any,
      },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
    }
    console.error('Error deleting workflow:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}