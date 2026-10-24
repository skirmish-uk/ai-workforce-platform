import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { validateAgentDefinition } from '@ai-workforce/executor'
import { enqueueEvaluation } from '@ai-workforce/queue'
import { UserRole } from '@prisma/client'

async function loadAgent(session: { user: { role: string; tenantId: string } }, id: string, permission: 'agent:read' | 'agent:deploy') {
  const agent = await prisma.agent.findUnique({ where: { id } })
  if (!agent || agent.isCandidate) return { error: NextResponse.json({ error: 'Agent not found' }, { status: 404 }) }
  const role = session.user.role as UserRole
  if (!canAccessTenant(role, session.user.tenantId, agent.tenantId) || !hasPermission(role, permission)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { agent }
}

/** GET /api/agents/[id]/evaluations — evaluation history plus current definition validation. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    const loaded = await loadAgent(session, id, 'agent:read')
    if (loaded.error) return loaded.error

    const [evaluations, skills] = await Promise.all([
      prisma.evaluation.findMany({ where: { agentId: id }, orderBy: { createdAt: 'desc' }, take: 20 }),
      prisma.agentSkill.findMany({ where: { agentId: id, enabled: true }, include: { skill: true } }),
    ])
    const validation = validateAgentDefinition(loaded.agent, skills.map((s) => s.skill), { forDeployment: true })
    return NextResponse.json({
      agentVersion: loaded.agent.version,
      deployable: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
      evaluations,
    })
  } catch (error) {
    console.error('Error listing evaluations:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/agents/[id]/evaluations — queue the agent's evaluation suite (its
 * enabled skills' evaluationCases). Runs in dry-run mode: no external side
 * effects, but it makes real model calls and therefore costs money, so it is
 * limited to roles that can deploy.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    const loaded = await loadAgent(session, id, 'agent:deploy')
    if (loaded.error) return loaded.error

    const job = await enqueueEvaluation({ agentId: id, requestedById: session.user.id })
    await prisma.auditLog.create({
      data: {
        action: 'AGENT_EVALUATION_REQUESTED',
        entityType: 'Agent',
        entityId: id,
        tenantId: loaded.agent.tenantId,
        userId: session.user.id,
        newData: { jobId: job.id, agentVersion: loaded.agent.version },
      },
    })
    return NextResponse.json({ jobId: job.id, agentVersion: loaded.agent.version, status: 'queued' }, { status: 202 })
  } catch (error) {
    console.error('Error queueing evaluation:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
