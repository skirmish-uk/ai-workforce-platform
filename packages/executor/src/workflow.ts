import { prisma } from '@ai-workforce/db'
import type { Prisma } from '@prisma/client'
import { AgentExecutionError, redact, safeErrorMessage } from '@ai-workforce/domain'
import { runAgent, type RunAgentDeps } from './agent'
import { approvalExpiry, type ApprovalPayload } from './approvals'
import { evaluateCondition, interpolate, parseSteps, type WorkflowStep } from './steps'

export type WorkflowExecutionStatus = 'completed' | 'failed' | 'approval_required' | 'cancelled'

export interface WorkflowExecutionResult {
  status: WorkflowExecutionStatus
  output?: Record<string, unknown>
  error?: string
  approvalId?: string
}

interface RetryPolicy {
  maxRetries?: number
  backoffMs?: number
}

interface ExecutionMeta {
  tenantId: string
  workflowRunId: string
  deadline: number
  retryPolicy: RetryPolicy
  deps?: RunAgentDeps
}

/** Decisions recorded against this run's Approval rows, keyed by workflow step id. */
interface StepApprovalState {
  approvalId: string
  kind: ApprovalPayload['kind'] | 'unknown'
  status: string
  toolName?: string
  output?: unknown
}

/** Approval-step approvals expire after this long unless the workflow config says otherwise. */
const DEFAULT_STEP_APPROVAL_TTL_HOURS = 72

class WorkflowPausedError extends Error {
  constructor(public readonly approvalId?: string) {
    super('Workflow paused for approval')
    this.name = 'WorkflowPausedError'
  }
}

class WorkflowCancelledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowCancelledError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function assertNotTimedOut(meta: ExecutionMeta): void {
  if (Date.now() > meta.deadline) {
    throw new AgentExecutionError('Workflow timed out', { workflowRunId: meta.workflowRunId })
  }
}

function stepsOf(context: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return context.steps as Record<string, Record<string, unknown>>
}

function approvalsOf(context: Record<string, unknown>): Record<string, StepApprovalState> {
  return (context.approvals ?? {}) as Record<string, StepApprovalState>
}

function isDone(step: WorkflowStep, context: Record<string, unknown>): boolean {
  return stepsOf(context)[step.id]?.done === true
}

async function executeStep(step: WorkflowStep, context: Record<string, unknown>, meta: ExecutionMeta): Promise<void> {
  assertNotTimedOut(meta)
  // Checkpoint: a resumed run skips leaf steps that already completed, so nothing runs twice.
  if (isDone(step, context)) return
  const steps = stepsOf(context)
  const approval = approvalsOf(context)[step.id]

  switch (step.type) {
    case 'agent_task': {
      if (approval?.status === 'PENDING') throw new WorkflowPausedError(approval.approvalId)
      if (approval?.status === 'REJECTED') throw new WorkflowCancelledError(`Approval ${approval.approvalId} was rejected`)
      if (approval?.status === 'EXPIRED') throw new AgentExecutionError(`Approval ${approval.approvalId} expired`, { stepId: step.id })
      if (approval?.status === 'EXECUTION_FAILED') {
        throw new AgentExecutionError(`Approved action ${approval.toolName} failed: ${JSON.stringify(redact(approval.output))}`, { stepId: step.id })
      }

      let input = interpolate(step.input, context)
      if (approval?.status === 'EXECUTED' && approval.toolName) {
        // Resume after approval: tell the agent what already happened so it continues rather
        // than re-requesting. The idempotency guard also suppresses an identical repeat.
        input += `\n\n[Platform note] A human approved ${approval.toolName} and it was executed. Result: ${JSON.stringify(redact(approval.output, { maxStringLength: 1500 }))}. Do not repeat that action; continue from here.`
      }

      const maxRetries = meta.retryPolicy.maxRetries ?? 0
      const backoffMs = meta.retryPolicy.backoffMs ?? 1000
      const run = () =>
        runAgent(step.agentId, input, { workflowRunId: meta.workflowRunId, workflowStepId: step.id, trigger: 'workflow', deps: meta.deps })

      let result = await run()
      // Only plain failures are retried; the executor's idempotency guard prevents a retry from
      // duplicating a non-idempotent side effect that already happened.
      for (let attempt = 1; result.status === 'failed' && attempt <= maxRetries; attempt++) {
        await sleep(backoffMs * 2 ** (attempt - 1))
        result = await run()
      }

      if (result.status === 'approval_required') throw new WorkflowPausedError(result.approvalId)
      if (result.status === 'cancelled') throw new WorkflowCancelledError('Agent run was cancelled')
      if (result.status !== 'completed') {
        const detail = result.error ?? result.escalation?.reason ?? result.clarificationQuestions?.join(' ') ?? ''
        throw new AgentExecutionError(`Agent task step ended with status "${result.status}"${detail ? `: ${detail}` : ''}`, { stepId: step.id })
      }

      steps[step.id] = { done: true, output: result.output, runId: result.runId, toolCalls: result.toolCalls }
      if (step.outputKey) context[step.outputKey] = result.output
      return
    }

    case 'condition': {
      const matched = evaluateCondition(step.condition, context)
      const branch = (matched ? step.onTrue : step.onFalse) ?? []
      await runSteps(branch, context, meta)
      return
    }

    case 'approval': {
      if (approval) {
        if (approval.status === 'APPROVED' || approval.status === 'EXECUTED') {
          steps[step.id] = { done: true, approvalId: approval.approvalId }
          return
        }
        if (approval.status === 'REJECTED') throw new WorkflowCancelledError(`Approval ${approval.approvalId} was rejected`)
        if (approval.status === 'EXPIRED') throw new AgentExecutionError(`Approval ${approval.approvalId} expired`, { stepId: step.id })
        throw new WorkflowPausedError(approval.approvalId)
      }

      const payload: ApprovalPayload = {
        kind: 'workflow_step',
        workflowStepId: step.id,
        summary: {
          action: step.action,
          target: `workflow step ${step.name ?? step.id}`,
          riskClass: 'workflow_gate',
          sideEffects: 'Allows the workflow to continue past this step.',
          material: redact({ input: context.input, steps: context.steps }, { maxStringLength: 1000 }),
          policyReason: 'Workflow approval step',
          evidence: { workflowRunId: meta.workflowRunId, stepId: step.id },
        },
      }
      const created = await prisma.approval.create({
        data: {
          action: step.action,
          level: step.level ?? 'CUSTOMER_APPROVAL',
          input: payload as unknown as Prisma.InputJsonValue,
          status: 'PENDING',
          expiresAt: approvalExpiry(DEFAULT_STEP_APPROVAL_TTL_HOURS),
          tenantId: meta.tenantId,
          workflowRunId: meta.workflowRunId,
        },
      })
      await prisma.workflowRun.update({
        where: { id: meta.workflowRunId },
        data: { status: 'APPROVAL_REQUIRED' },
      })
      throw new WorkflowPausedError(created.id)
    }

    case 'delay': {
      await sleep(Math.min(step.durationMs, meta.deadline - Date.now()))
      steps[step.id] = { done: true }
      return
    }

    case 'transform': {
      context[step.outputKey] = interpolate(step.template, context)
      steps[step.id] = { done: true }
      return
    }

    case 'parallel': {
      await Promise.all(step.steps.map((sub) => executeStep(sub, context, meta)))
      return
    }
  }
}

async function runSteps(steps: WorkflowStep[], context: Record<string, unknown>, meta: ExecutionMeta): Promise<void> {
  for (const step of steps) {
    await executeStep(step, context, meta)
  }
}

async function loadStepApprovals(workflowRunId: string): Promise<Record<string, StepApprovalState>> {
  const rows = await prisma.approval.findMany({ where: { workflowRunId }, orderBy: { createdAt: 'asc' } })
  const byStep: Record<string, StepApprovalState> = {}
  for (const row of rows) {
    const payload = (row.input ?? {}) as Partial<ApprovalPayload> & { workflowStepId?: string; toolName?: string }
    if (!payload.workflowStepId) continue
    const output = (row.output ?? null) as { output?: unknown } | null
    // Later approvals for the same step supersede earlier ones.
    byStep[payload.workflowStepId] = {
      approvalId: row.id,
      kind: payload.kind ?? 'unknown',
      status: row.status,
      toolName: payload.kind === 'tool_call' ? payload.toolName : undefined,
      output: output?.output ?? output,
    }
  }
  return byStep
}

/**
 * Drives a WorkflowRun through PENDING -> RUNNING -> COMPLETED/FAILED/CANCELLED,
 * pausing at APPROVAL_REQUIRED. Calling it again on a paused run resumes from
 * the persisted checkpoint (completed leaf steps are skipped) once its
 * approvals are decided; calling it on a finished run is a no-op, so duplicate
 * queue jobs are harmless.
 */
export async function executeWorkflow(workflowRunId: string, options: { deps?: RunAgentDeps } = {}): Promise<WorkflowExecutionResult> {
  const run = await prisma.workflowRun.findUnique({
    where: { id: workflowRunId },
    include: { workflow: true },
  })
  if (!run) {
    throw new AgentExecutionError(`WorkflowRun ${workflowRunId} not found`, { workflowRunId })
  }

  const terminal: Record<string, WorkflowExecutionStatus> = { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' }
  if (terminal[run.status]) {
    return { status: terminal[run.status], output: (run.output ?? undefined) as Record<string, unknown> | undefined, error: run.error ?? undefined }
  }

  const approvals = await loadStepApprovals(workflowRunId)
  const stillPending = Object.values(approvals).find(
    (a) => a.status === 'PENDING' || (a.kind === 'tool_call' && (a.status === 'APPROVED' || a.status === 'EXECUTING'))
  )
  if (run.status === 'APPROVAL_REQUIRED' && stillPending) {
    // APPROVED-but-not-yet-EXECUTED tool calls are still in flight in the approval worker.
    return { status: 'approval_required', output: (run.output ?? undefined) as Record<string, unknown> | undefined, approvalId: stillPending.approvalId }
  }

  const checkpoint = run.status === 'APPROVAL_REQUIRED' && run.output && typeof run.output === 'object' ? (run.output as Record<string, unknown>) : null
  const context: Record<string, unknown> = checkpoint
    ? { ...checkpoint, steps: { ...((checkpoint.steps as object) ?? {}) }, approvals }
    : { input: run.input, steps: {}, approvals }

  await prisma.workflowRun.update({
    where: { id: workflowRunId },
    data: { status: 'RUNNING', startedAt: run.startedAt ?? new Date() },
  })

  const steps = parseSteps(run.workflow.steps)
  const retryPolicy = (run.workflow.retryPolicy ?? {}) as RetryPolicy
  const meta: ExecutionMeta = {
    tenantId: run.tenantId,
    workflowRunId,
    deadline: Date.now() + run.workflow.timeout * 1000,
    retryPolicy,
    deps: options.deps,
  }

  try {
    await runSteps(steps, context, meta)

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status: 'COMPLETED', output: context as never, completedAt: new Date() },
    })

    return { status: 'completed', output: context }
  } catch (error) {
    if (error instanceof WorkflowPausedError) {
      // Persist the checkpoint so the resume path continues from here.
      await prisma.workflowRun.update({
        where: { id: workflowRunId },
        data: { status: 'APPROVAL_REQUIRED', output: context as never },
      })
      return { status: 'approval_required', output: context, approvalId: error.approvalId }
    }

    const message = safeErrorMessage(error, 'Workflow execution failed')
    const status = error instanceof WorkflowCancelledError ? 'CANCELLED' : 'FAILED'
    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status, error: message, output: context as never, completedAt: new Date() },
    })
    return { status: status === 'CANCELLED' ? 'cancelled' : 'failed', output: context, error: message }
  }
}
