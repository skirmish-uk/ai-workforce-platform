import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'

async function checkRunAccess(session: { user: { id: string; role: string; tenantId: string } }, runId: string) {
  const run = await prisma.workflowRun.findUnique({ where: { id: runId }, include: { workflow: true } })
  if (!run) throw new Error('NOT_FOUND')
  
  if (!canAccessTenant(session.user.role as UserRole, session.user.tenantId, run.tenantId)) {
    throw new Error('FORBIDDEN')
  }
  return run
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
    await checkRunAccess(session, id)

    const run = await prisma.workflowRun.findUnique({
      where: { id },
      include: {
        workflow: { select: { id: true, name: true } },
        approvals: { include: { user: { select: { id: true, name: true, email: true } } } },
      },
    })

    if (!run) {
      return NextResponse.json({ error: 'Workflow run not found' }, { status: 404 })
    }

    return NextResponse.json(run)
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Workflow run not found' }, { status: 404 })
    }
    console.error('Error fetching workflow run:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}