import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { agentRunQueue, enqueueAgentRun, requestAgentRunCancel } from '@ai-workforce/queue'
import { followUpInput, isConversationId, runMessage, FOLLOW_UP_HISTORY_EXCHANGES } from '@ai-workforce/executor'
import { UserRole } from '@prisma/client'
import { randomUUID } from 'crypto'

type Session = { user: { id: string; role: string; tenantId: string } }

/** Loads the agent and checks the caller may act on it. */
async function authorize(session: Session, agentId: string, permission: 'agent:read' | 'agent:write') {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } })
  if (!agent || agent.isCandidate) return { error: NextResponse.json({ error: 'Agent not found' }, { status: 404 }) }
  const role = session.user.role as UserRole
  if (!canAccessTenant(role, session.user.tenantId, agent.tenantId) || !hasPermission(role, permission)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { agent }
}

/** Looks up a job only if it belongs to this agent, so a jobId can't be used to read another tenant's run. */
async function jobForAgent(request: NextRequest, agentId: string) {
  const jobId = new URL(request.url).searchParams.get('jobId')
  if (!jobId) return { error: NextResponse.json({ error: 'jobId query param is required' }, { status: 400 }) }
  const job = await agentRunQueue.getJob(jobId)
  if (!job || job.data.agentId !== agentId) return { error: NextResponse.json({ error: 'Job not found' }, { status: 404 }) }
  return { job }
}

const RUN_ACTIONS = ['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_FINISHED', 'AGENT_RUN_ESCALATED', 'AGENT_RUN_BLOCKED_SPEND_CAP']

/** The exchanges so far in a typed conversation, read from the runs' own audit rows (not trusted from the browser). */
async function conversationHistory(agentId: string, tenantId: string, conversationId: string) {
  const rows = await prisma.auditLog.findMany({
    where: { tenantId, entityType: 'Agent', entityId: agentId, action: { in: RUN_ACTIONS }, newData: { path: ['conversationId'], equals: conversationId } },
    orderBy: { createdAt: 'desc' },
    take: FOLLOW_UP_HISTORY_EXCHANGES,
    select: { newData: true },
  })
  return rows.reverse().map((row) => {
    const d = (row.newData ?? {}) as Record<string, unknown>
    const message = runMessage({ message: typeof d.message === 'string' ? d.message : undefined, input: typeof d.input === 'string' ? d.input : undefined })
    const answer = typeof d.output === 'string' && d.output
      ? d.output
      : `(no answer: the run ended as ${typeof d.status === 'string' ? d.status.replace(/_/g, ' ') : 'unknown'})`
    return { message, answer }
  })
}

/**
 * Enqueues an ad-hoc agent invocation (Diagnose → Assemble → Act → Assess).
 * Body: { input, conversationId? }. Without a conversation id this starts a new conversation;
 * with one, the agent gets that conversation's recent exchanges with the new message.
 */
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
    const auth = await authorize(session, id, 'agent:write')
    if (auth.error) return auth.error

    const body = await request.json()
    const input = typeof body.input === 'string' ? body.input : ''
    if (!input.trim()) {
      return NextResponse.json({ error: 'input is required' }, { status: 400 })
    }

    if (body.conversationId !== undefined && !isConversationId(body.conversationId)) {
      return NextResponse.json({ error: 'Invalid conversationId' }, { status: 400 })
    }
    const conversationId: string = body.conversationId ?? randomUUID()
    const history = body.conversationId ? await conversationHistory(auth.agent.id, auth.agent.tenantId, conversationId) : []
    const job = await enqueueAgentRun({
      agentId: auth.agent.id,
      input: followUpInput(history, input, auth.agent.name),
      userId: session.user.id,
      trigger: 'api',
      conversation: { id: conversationId, message: input },
    })

    // runId == jobId: use it to find the run's AuditLog rows and approvals.
    return NextResponse.json({ jobId: job.id, runId: job.id, conversationId, status: 'queued' }, { status: 201 })
  } catch (error) {
    console.error('Error enqueueing agent run:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/** Polls the result of a job enqueued above: GET /api/agents/[id]/run?jobId=... */
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
    const auth = await authorize(session, id, 'agent:read')
    if (auth.error) return auth.error
    const found = await jobForAgent(request, id)
    if (found.error) return found.error

    const state = await found.job.getState()
    return NextResponse.json({
      jobId: found.job.id,
      state,
      result: found.job.returnvalue ?? null,
      failedReason: found.job.failedReason ?? null,
    })
  } catch (error) {
    console.error('Error fetching agent run job:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * Cancels a run: DELETE /api/agents/[id]/run?jobId=...
 * A queued run is removed; an active run stops at its next safe point (between
 * iterations or before the next tool call) with status "cancelled".
 */
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
    const auth = await authorize(session, id, 'agent:write')
    if (auth.error) return auth.error
    const found = await jobForAgent(request, id)
    if (found.error) return found.error

    const outcome = await requestAgentRunCancel(found.job.id!)
    await prisma.auditLog.create({
      data: {
        action: 'AGENT_RUN_CANCEL_REQUESTED',
        entityType: 'Agent',
        entityId: id,
        tenantId: auth.agent.tenantId,
        userId: session.user.id,
        newData: { runId: found.job.id, outcome },
      },
    })
    return NextResponse.json({ jobId: found.job.id, outcome })
  } catch (error) {
    console.error('Error cancelling agent run:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
