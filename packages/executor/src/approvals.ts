import { prisma } from '@ai-workforce/db'
import type { ApprovalLevel, Prisma, UserRole } from '@prisma/client'
import { canAccessTenant, canApprove, redact, redactString, safeErrorMessage } from '@ai-workforce/domain'
import { authorizeToolCall, toolRegistry, type ToolRiskProfile } from '@ai-workforce/tools'
import { resolveAgentContract } from './contract'
import { readKillSwitch, resolveEffectiveStage } from './safety'
import { auditToolEvent, runAuthorizedTool, type ToolExecutorFn } from './tool-runner'
// Import cycle (revisions → evaluation → agent → approvals) is safe: only used inside functions.
import { closeRevisionApproval, promoteRevision } from './workforce/revisions'

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'EXECUTING' | 'EXECUTED' | 'EXECUTION_FAILED'

/** Shape of Approval.input for approvals created by this package. */
export type ApprovalPayload =
  | {
      kind: 'tool_call'
      toolName: string
      /** Exact arguments that will run if approved — approval covers this call only. */
      arguments: unknown
      workflowStepId?: string
      summary: ApprovalSummary
    }
  | {
      kind: 'workflow_step'
      workflowStepId: string
      summary: ApprovalSummary
    }
  | {
      /** A risk-increasing agent revision (packages/executor/src/workforce/revisions.ts). */
      kind: 'agent_revision'
      revisionId: string
      summary: ApprovalSummary
    }

export interface ApprovalSummary {
  action: string
  target: string
  riskClass: string
  sideEffects: string
  /** Redacted copy of the material content, for display. */
  material: unknown
  rationale?: string
  policyReason: string
  evidence: Record<string, unknown>
}

export class ApprovalError extends Error {
  constructor(message: string, public readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'EXPIRED' | 'INVALID') {
    super(message)
    this.name = 'ApprovalError'
  }
}

export function approvalExpiry(ttlHours: number, now = new Date()): Date {
  return new Date(now.getTime() + ttlHours * 3_600_000)
}

export async function createToolApproval(params: {
  tenantId: string
  agentId: string
  agentVersion: number
  runId: string
  workflowRunId?: string
  workflowStepId?: string
  toolName: string
  adapterName: string
  input: unknown
  level: ApprovalLevel
  profile: ToolRiskProfile
  rationale?: string | null
  policyReason: string
  ttlHours: number
  userId?: string
}): Promise<string> {
  const payload: ApprovalPayload = {
    kind: 'tool_call',
    toolName: params.toolName,
    arguments: params.input,
    workflowStepId: params.workflowStepId,
    summary: {
      action: params.toolName,
      target: params.adapterName,
      riskClass: params.profile.risk,
      sideEffects: params.profile.sideEffects,
      material: redact(params.input, { maxStringLength: 2000 }),
      rationale: params.rationale ? redactString(params.rationale, 1000) : undefined,
      policyReason: params.policyReason,
      evidence: { runId: params.runId, agentId: params.agentId, agentVersion: params.agentVersion },
    },
  }

  const approval = await prisma.approval.create({
    data: {
      action: params.toolName,
      level: params.level,
      input: payload as unknown as Prisma.InputJsonValue,
      status: 'PENDING',
      expiresAt: approvalExpiry(params.ttlHours),
      agentId: params.agentId,
      runId: params.runId,
      tenantId: params.tenantId,
      workflowRunId: params.workflowRunId,
    },
  })

  if (params.workflowRunId) {
    await prisma.workflowRun.update({ where: { id: params.workflowRunId }, data: { status: 'APPROVAL_REQUIRED' } })
  }

  await auditToolEvent(
    { tenantId: params.tenantId, agentId: params.agentId, userId: params.userId, workflowRunId: params.workflowRunId },
    'APPROVAL_REQUESTED',
    { approvalId: approval.id, runId: params.runId, tool: params.toolName, level: params.level, risk: params.profile.risk }
  )
  return approval.id
}

export interface ApprovalActor {
  id: string
  role: UserRole
  tenantId: string
}

/**
 * Records a human decision. Checks tenant access, that the actor's role can
 * approve at the required level (domain canApprove), that it is still
 * pending, and that it hasn't expired. Approval of one action never implies
 * approval of any other: the payload pins the exact arguments.
 * Execution of an approved tool call happens separately, in the worker
 * (executeApprovedAction), never inline in the API route.
 */
export async function decideApproval(params: {
  approvalId: string
  decision: 'approve' | 'reject'
  actor: ApprovalActor
  reason?: string
  now?: Date
}): Promise<{ status: ApprovalStatus; workflowRunId: string | null; kind: ApprovalPayload['kind'] | 'unknown' }> {
  const now = params.now ?? new Date()
  const approval = await prisma.approval.findUnique({ where: { id: params.approvalId } })
  if (!approval) throw new ApprovalError('Approval not found', 'NOT_FOUND')
  if (!canAccessTenant(params.actor.role, params.actor.tenantId, approval.tenantId)) throw new ApprovalError('Approval not found', 'NOT_FOUND')
  if (!canApprove(params.actor.role, approval.level)) {
    throw new ApprovalError(`Your role cannot decide ${approval.level} approvals`, 'FORBIDDEN')
  }
  if (approval.status !== 'PENDING') throw new ApprovalError(`Approval is already ${approval.status}`, 'CONFLICT')

  if (approval.expiresAt && approval.expiresAt <= now) {
    await expireApproval(approval.id, approval.tenantId, approval.workflowRunId, approval.agentId)
    throw new ApprovalError('Approval has expired; the agent must request it again', 'EXPIRED')
  }

  const status: ApprovalStatus = params.decision === 'approve' ? 'APPROVED' : 'REJECTED'
  // Conditional update so two concurrent decisions can't both succeed.
  const updated = await prisma.approval.updateMany({
    where: { id: approval.id, status: 'PENDING' },
    data: {
      status,
      decision: params.decision === 'approve' ? approval.level : 'PROHIBITED',
      decidedById: params.actor.id,
      userId: params.actor.id,
      decidedAt: now,
      reason: params.reason ? redactString(params.reason, 1000) : null,
    },
  })
  if (updated.count !== 1) throw new ApprovalError('Approval was decided concurrently', 'CONFLICT')

  const payloadKind = ((approval.input ?? {}) as { kind?: string; revisionId?: string })
  if (status === 'REJECTED' && payloadKind.kind === 'agent_revision' && payloadKind.revisionId) {
    await closeRevisionApproval(payloadKind.revisionId, 'REJECTED', params.reason)
  }

  if (status === 'REJECTED' && approval.workflowRunId) {
    await prisma.workflowRun.update({
      where: { id: approval.workflowRunId },
      data: { status: 'CANCELLED', error: `Approval ${approval.id} rejected${params.reason ? `: ${redactString(params.reason, 300)}` : ''}`, completedAt: now },
    })
  }

  await prisma.auditLog.create({
    data: {
      action: status === 'APPROVED' ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED',
      entityType: 'Approval',
      entityId: approval.id,
      tenantId: approval.tenantId,
      userId: params.actor.id,
      workflowRunId: approval.workflowRunId,
      newData: redact({ action: approval.action, level: approval.level, agentId: approval.agentId, runId: approval.runId, reason: params.reason }) as never,
    },
  })

  const kind = ((approval.input ?? {}) as { kind?: ApprovalPayload['kind'] }).kind ?? 'unknown'
  return { status, workflowRunId: approval.workflowRunId, kind }
}

async function expireApproval(id: string, tenantId: string, workflowRunId: string | null, agentId: string | null): Promise<void> {
  const res = await prisma.approval.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'EXPIRED' } })
  if (res.count !== 1) return
  const row = await prisma.approval.findUnique({ where: { id }, select: { input: true } })
  const payload = (row?.input ?? {}) as { kind?: string; revisionId?: string }
  if (payload.kind === 'agent_revision' && payload.revisionId) {
    await closeRevisionApproval(payload.revisionId, 'EXPIRED')
  }
  if (workflowRunId) {
    await prisma.workflowRun.updateMany({
      where: { id: workflowRunId, status: 'APPROVAL_REQUIRED' },
      data: { status: 'FAILED', error: `Approval ${id} expired without a decision`, completedAt: new Date() },
    })
  }
  await prisma.auditLog.create({
    data: { action: 'APPROVAL_EXPIRED', entityType: 'Approval', entityId: id, tenantId, workflowRunId, newData: { agentId } },
  })
}

/** Marks every pending approval past its expiry as EXPIRED (called from the scheduler tick). */
export async function expireStaleApprovals(now = new Date()): Promise<number> {
  const stale = await prisma.approval.findMany({
    where: { status: 'PENDING', expiresAt: { lte: now } },
    select: { id: true, tenantId: true, workflowRunId: true, agentId: true },
    take: 500,
  })
  for (const approval of stale) {
    await expireApproval(approval.id, approval.tenantId, approval.workflowRunId, approval.agentId)
  }
  return stale.length
}

export interface ApprovedActionResult {
  approvalId: string
  status: ApprovalStatus
  workflowRunId: string | null
  workflowStepId?: string
  output?: unknown
  error?: string
}

/**
 * Executes exactly the approved call, exactly once. The APPROVED -> EXECUTING
 * transition is a conditional update, so a duplicate job can't run it twice.
 * Current policy still applies at execution time: if the tool was since
 * prohibited, the tenant kill switch fired, or the agent was paused, it does
 * not run even though it was approved.
 */
export async function executeApprovedAction(
  approvalId: string,
  deps: { executeTool?: ToolExecutorFn } = {}
): Promise<ApprovedActionResult> {
  const approval = await prisma.approval.findUnique({ where: { id: approvalId } })
  if (!approval) throw new ApprovalError('Approval not found', 'NOT_FOUND')
  const payload = (approval.input ?? {}) as Partial<ApprovalPayload> & { revisionId?: string; workflowStepId?: string }

  if (payload.kind === 'agent_revision') {
    return executeApprovedRevision(approval.id, approval.status as ApprovalStatus, payload.revisionId, approval.decidedById)
  }

  if (payload.kind !== 'tool_call') {
    return { approvalId, status: approval.status as ApprovalStatus, workflowRunId: approval.workflowRunId, workflowStepId: payload.workflowStepId }
  }

  const claimed = await prisma.approval.updateMany({ where: { id: approvalId, status: 'APPROVED' }, data: { status: 'EXECUTING' } })
  if (claimed.count !== 1) {
    return { approvalId, status: approval.status as ApprovalStatus, workflowRunId: approval.workflowRunId, workflowStepId: payload.workflowStepId, error: `Approval is ${approval.status}, not APPROVED` }
  }

  const finish = async (status: ApprovalStatus, output: unknown, error?: string): Promise<ApprovedActionResult> => {
    await prisma.approval.update({
      where: { id: approvalId },
      data: { status, output: redact({ output, error }) as unknown as Prisma.InputJsonValue },
    })
    return { approvalId, status, workflowRunId: approval.workflowRunId, workflowStepId: payload.workflowStepId, output, error }
  }

  try {
    if (!approval.agentId) return await finish('EXECUTION_FAILED', null, 'Approval has no agentId; cannot execute')
    const agent = await prisma.agent.findUnique({ where: { id: approval.agentId }, include: { tenant: { select: { settings: true } } } })
    if (!agent || agent.tenantId !== approval.tenantId) return await finish('EXECUTION_FAILED', null, 'Agent not found for this tenant')
    if (agent.status === 'PAUSED' || agent.status === 'ARCHIVED') return await finish('EXECUTION_FAILED', null, `Agent is ${agent.status}; approved action not executed`)

    const killSwitch = readKillSwitch(agent.tenant.settings)
    if (killSwitch.agentsDisabled) return await finish('EXECUTION_FAILED', null, killSwitch.reason ?? 'Agents disabled')

    const registered = toolRegistry.get(payload.toolName ?? '')
    if (!registered) return await finish('EXECUTION_FAILED', null, `Unknown tool ${payload.toolName}`)

    const { contract } = resolveAgentContract(agent)
    const effective = await resolveEffectiveStage(agent, contract)
    const authorized = await authorizeToolCall({
      agentId: agent.id,
      registered,
      input: payload.arguments,
      stage: effective.stage,
      allowedTools: contract.allowedTools ?? null,
      disabledTools: killSwitch.disabledTools,
      preApproved: true,
    })
    if (authorized.decision.kind !== 'execute') {
      return await finish('EXECUTION_FAILED', null, `Policy no longer permits this action: ${authorized.decision.reason}`)
    }

    const outcome = await runAuthorizedTool(registered, authorized.input, authorized.profile, {
      tenantId: agent.tenantId,
      agentId: agent.id,
      runId: approval.runId ?? `approval-${approvalId}`,
      userId: approval.decidedById ?? undefined,
      workflowRunId: approval.workflowRunId ?? undefined,
      timeoutMs: contract.limits.toolTimeoutMs,
      executeTool: deps.executeTool,
      approvalId,
    })
    switch (outcome.kind) {
      case 'completed':
        return await finish('EXECUTED', outcome.output)
      case 'duplicate_suppressed':
        return await finish('EXECUTED', { duplicateSuppressed: true, priorRunId: outcome.prior.runId, priorAt: outcome.prior.at })
      case 'simulated':
        return await finish('EXECUTED', outcome.output)
      case 'unknown_outcome':
        return await finish('EXECUTION_FAILED', null, outcome.reason)
      case 'error':
        return await finish('EXECUTION_FAILED', null, outcome.message)
    }
  } catch (error) {
    return finish('EXECUTION_FAILED', null, safeErrorMessage(error))
  }
}

/** Approved risk-increasing revision: promote it, exactly once (both the approval and the revision are claimed). */
async function executeApprovedRevision(
  approvalId: string,
  status: ApprovalStatus,
  revisionId: string | undefined,
  decidedById: string | null
): Promise<ApprovedActionResult> {
  const claimed = await prisma.approval.updateMany({ where: { id: approvalId, status: 'APPROVED' }, data: { status: 'EXECUTING' } })
  if (claimed.count !== 1) return { approvalId, status, workflowRunId: null, error: `Approval is ${status}, not APPROVED` }
  let finalStatus: ApprovalStatus = 'EXECUTION_FAILED'
  let output: unknown = null
  let error: string | undefined
  try {
    if (!revisionId) throw new Error('Approval has no revisionId')
    const outcome = await promoteRevision(revisionId, { approvedByUserId: decidedById ?? undefined })
    output = outcome
    if (outcome.status === 'PROMOTED') finalStatus = 'EXECUTED'
    else error = outcome.error ?? `Revision ended ${outcome.status}`
  } catch (e) {
    error = safeErrorMessage(e)
  }
  await prisma.approval.update({ where: { id: approvalId }, data: { status: finalStatus, output: redact({ output, error }) as unknown as Prisma.InputJsonValue } })
  return { approvalId, status: finalStatus, workflowRunId: null, output, error }
}
