import { prisma } from '@ai-workforce/db'
import { redact, safeErrorMessage } from '@ai-workforce/domain'
import {
  executeToolCall,
  getCredentialsForAdapter,
  ToolTimeoutError,
  type RegisteredTool,
  type ToolRiskProfile,
} from '@ai-workforce/tools'
import { findPriorToolExecution, toolIdempotencyKey, type PriorExecution } from './safety'

/** Replaces credential lookup + adapter execution (tests, sandboxes). Must honour timeoutMs itself if it cares. */
export type ToolExecutorFn = (registered: RegisteredTool, input: unknown, ctx: { tenantId: string; timeoutMs: number }) => Promise<unknown>

export interface ToolRunContext {
  tenantId: string
  agentId: string
  runId: string
  userId?: string
  workflowRunId?: string
  timeoutMs: number
  /** Never touch the real adapter: return fixtures/simulated results instead. */
  dryRun?: boolean
  /** With dryRun: read-only tools (risk "read") still execute for real. Used by revision replays. */
  liveReads?: boolean
  toolFixtures?: Record<string, unknown>
  executeTool?: ToolExecutorFn
  /** Approval that authorised this exact call, for the audit trail. */
  approvalId?: string
}

export type ToolRunOutcome =
  | { kind: 'completed'; output: unknown; idempotencyKey: string }
  | { kind: 'simulated'; output: unknown; idempotencyKey: string }
  | { kind: 'duplicate_suppressed'; prior: PriorExecution; idempotencyKey: string }
  | { kind: 'unknown_outcome'; reason: string; idempotencyKey: string }
  | { kind: 'error'; message: string; idempotencyKey: string }

export async function auditToolEvent(
  ctx: Pick<ToolRunContext, 'tenantId' | 'agentId' | 'userId' | 'workflowRunId'>,
  action: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        entityType: 'Agent',
        entityId: ctx.agentId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        workflowRunId: ctx.workflowRunId,
        newData: redact(data) as never,
      },
    })
  } catch (error) {
    console.error('Failed to record tool audit log:', safeErrorMessage(error))
  }
}

async function defaultExecutor(registered: RegisteredTool, input: unknown, ctx: { tenantId: string; timeoutMs: number }): Promise<unknown> {
  const credentials = await getCredentialsForAdapter(ctx.tenantId, registered.adapter.name)
  return executeToolCall(registered, input, credentials, ctx.timeoutMs)
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ToolTimeoutError(toolName, timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Executes a call that policy has ALREADY authorised. Adds the operational
 * safety the policy layer doesn't cover: dry-run, duplicate suppression for
 * non-idempotent tools, timeouts with "unknown outcome" handling, and an
 * audit row (with redacted arguments) for every attempt.
 */
export async function runAuthorizedTool(
  registered: RegisteredTool,
  input: unknown,
  profile: ToolRiskProfile,
  ctx: ToolRunContext
): Promise<ToolRunOutcome> {
  const toolName = registered.toolName
  const idempotencyKey = toolIdempotencyKey(ctx.tenantId, ctx.agentId, toolName, input)
  const base = { runId: ctx.runId, tool: toolName, input, idempotencyKey, approvalId: ctx.approvalId, risk: profile.risk }

  const liveRead = ctx.dryRun && ctx.liveReads && profile.risk === 'read' && !(ctx.toolFixtures && toolName in ctx.toolFixtures)
  if (ctx.dryRun && !liveRead) {
    const output = ctx.toolFixtures && toolName in ctx.toolFixtures
      ? ctx.toolFixtures[toolName]
      : { simulated: true, note: `Dry run: ${toolName} was not executed.` }
    await auditToolEvent(ctx, 'AGENT_TOOL_CALL_SIMULATED', { ...base })
    return { kind: 'simulated', output, idempotencyKey }
  }

  if (!profile.idempotent) {
    const prior = await findPriorToolExecution(ctx.tenantId, idempotencyKey)
    if (prior?.outcome === 'completed') {
      await auditToolEvent(ctx, 'AGENT_TOOL_CALL_DUPLICATE_SUPPRESSED', { ...base, priorRunId: prior.runId, priorAt: prior.at })
      return { kind: 'duplicate_suppressed', prior, idempotencyKey }
    }
    if (prior?.outcome === 'unknown') {
      const reason = `An identical ${toolName} call at ${prior.at.toISOString()} timed out with an unknown outcome; a human must verify before it is repeated.`
      await auditToolEvent(ctx, 'AGENT_TOOL_CALL_BLOCKED_UNKNOWN_PRIOR', { ...base, priorRunId: prior.runId })
      return { kind: 'unknown_outcome', reason, idempotencyKey }
    }
  }

  const executor = ctx.executeTool ?? defaultExecutor
  try {
    const output = await withTimeout(executor(registered, input, { tenantId: ctx.tenantId, timeoutMs: ctx.timeoutMs }), ctx.timeoutMs, toolName)
    await auditToolEvent(ctx, 'AGENT_TOOL_CALL', { ...base, output })
    return { kind: 'completed', output, idempotencyKey }
  } catch (error) {
    if (error instanceof ToolTimeoutError) {
      await auditToolEvent(ctx, 'AGENT_TOOL_CALL_UNKNOWN', { ...base, error: error.message })
      if (!profile.idempotent) {
        return { kind: 'unknown_outcome', reason: `${error.message}. It is not idempotent, so it will not be retried automatically.`, idempotencyKey }
      }
      return { kind: 'error', message: error.message, idempotencyKey }
    }
    const message = safeErrorMessage(error, 'Tool execution failed')
    await auditToolEvent(ctx, 'AGENT_TOOL_CALL_FAILED', { ...base, error: message })
    return { kind: 'error', message, idempotencyKey }
  }
}
