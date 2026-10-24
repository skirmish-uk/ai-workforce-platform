import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, safeErrorMessage } from '@ai-workforce/domain'
import { answerTask, startCase, taskRunId } from '@ai-workforce/executor'
import { enqueueAgentTask } from '@ai-workforce/queue'
import type { UserRole } from '@prisma/client'
import { z } from 'zod'
import { tenantFor } from '../../../lib/tenant'

export const dynamic = 'force-dynamic'

const RESULT_PREVIEW = 1500

/**
 * GET  /api/cases[?id=] — team cases (docs/TEAMWORK.md), newest first: each agent's part in
 *      order, who handed it over and why, and how it ended. With id: just that case.
 * POST { agentId, brief, title?, subject? } — a person starts a case with one agent; the agents
 *      hand parts of it on from there.
 * PUT  { taskId, answer } — answers a task that stopped to ask something; the agent picks it up again.
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(session.user.role as UserRole, 'agent:read')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const tenantId = tenantFor(session, request)
  const id = request.nextUrl.searchParams.get('id')
  const cases = await prisma.teamCase.findMany({
    where: { tenantId, ...(id ? { id } : {}) },
    orderBy: { updatedAt: 'desc' },
    take: id ? 1 : 30,
    include: { tasks: { orderBy: [{ createdAt: 'asc' }, { depth: 'asc' }] } },
  })
  const agents = await prisma.agent.findMany({ where: { tenantId, isCandidate: false }, select: { id: true, name: true, role: true } })
  const agent = (agentId: string | null) => {
    const a = agentId ? agents.find((x) => x.id === agentId) : null
    return a ? { id: a.id, name: a.name, role: a.role } : null
  }
  return NextResponse.json({
    agents: agents.map((a) => ({ id: a.id, name: a.name, role: a.role })),
    cases: cases.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      source: c.source,
      subject: c.subject,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      tasks: c.tasks.map((t) => ({
        id: t.id,
        status: t.status,
        agent: agent(t.toAgentId),
        from: agent(t.fromAgentId),
        parentTaskId: t.parentTaskId,
        brief: t.brief,
        reason: t.reason,
        result: t.result && t.result.length > RESULT_PREVIEW ? `${t.result.slice(0, RESULT_PREVIEW)}…` : t.result,
        runId: t.runId,
        approvalId: t.approvalId,
        depth: t.depth,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
      })),
    })),
  })
}

const startSchema = z.object({
  agentId: z.string().min(1),
  brief: z.string().trim().min(3).max(4000),
  title: z.string().trim().max(120).optional(),
  subject: z.string().trim().max(120).optional(),
})

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session.user.role as UserRole, 'agent:write')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const tenantId = tenantFor(session, request)
    const parsed = startSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid case' }, { status: 400 })
    const agent = await prisma.agent.findFirst({ where: { id: parsed.data.agentId, tenantId, isCandidate: false, status: { notIn: ['PAUSED', 'ARCHIVED'] } } })
    if (!agent) return NextResponse.json({ error: 'Agent not found or paused' }, { status: 404 })
    const started = await startCase({ tenantId, agentId: agent.id, brief: parsed.data.brief, title: parsed.data.title, subject: parsed.data.subject, userId: session.user.id })
    await enqueueAgentTask({ id: started.taskId, runId: taskRunId(started.taskId), agentId: agent.id })
    return NextResponse.json(started, { status: 201 })
  } catch (error) {
    console.error('Starting a case failed:', safeErrorMessage(error))
    return NextResponse.json({ error: `Could not start the case: ${safeErrorMessage(error)}` }, { status: 500 })
  }
}

const answerSchema = z.object({ taskId: z.string().min(1), answer: z.string().trim().min(1).max(2000) })

export async function PUT(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session.user.role as UserRole, 'agent:write')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const parsed = answerSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid answer' }, { status: 400 })
    const next = await answerTask({ tenantId: tenantFor(session, request), taskId: parsed.data.taskId, answer: parsed.data.answer, userId: session.user.id })
    if (!next) return NextResponse.json({ error: 'That task isn’t waiting for an answer' }, { status: 409 })
    await enqueueAgentTask({ id: next.taskId, runId: next.runId, agentId: next.agentId })
    return NextResponse.json(next)
  } catch (error) {
    console.error('Answering a task failed:', safeErrorMessage(error))
    return NextResponse.json({ error: `Could not send the answer: ${safeErrorMessage(error)}` }, { status: 500 })
  }
}
