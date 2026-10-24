import { prisma } from '@ai-workforce/db'
import { ApprovalLevel } from '@prisma/client'
import type { RegisteredTool } from './registry'
import { checkPermission } from './permissions'
import { decideToolAction, type AutonomyStage, type ToolDecision } from './policy'
import { getToolRiskProfile, type ToolRiskProfile } from './risk'
import { sandboxExecute } from './sandbox'
import { decryptCredentials } from './credentials'

export class ToolPermissionDeniedError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly level: ApprovalLevel,
    public readonly reason = 'Action is prohibited for this agent'
  ) {
    super(`Tool "${toolName}" denied: ${reason}`)
    this.name = 'ToolPermissionDeniedError'
  }
}

export class ToolApprovalRequiredError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly level: ApprovalLevel,
    public readonly reason = 'Approval required'
  ) {
    super(`Tool "${toolName}" requires approval before it can run (level: ${level})`)
    this.name = 'ToolApprovalRequiredError'
  }
}

/** The agent's autonomy stage only allows proposing this action; it was recorded, not executed. */
export class ToolProposalRecordedError extends Error {
  constructor(public readonly toolName: string, public readonly reason: string) {
    super(`Tool "${toolName}" was not executed: ${reason}`)
    this.name = 'ToolProposalRecordedError'
  }
}

export class ToolInputValidationError extends Error {
  constructor(public readonly toolName: string, public readonly issues: string) {
    super(`Invalid arguments for tool "${toolName}": ${issues}`)
    this.name = 'ToolInputValidationError'
  }
}

/**
 * The tool did not answer within its timeout. Its side effect may or may not
 * have happened, so callers must not blindly retry a non-idempotent call.
 */
export class ToolTimeoutError extends Error {
  constructor(public readonly toolName: string, public readonly timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms; outcome unknown`)
    this.name = 'ToolTimeoutError'
  }
}

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000

/**
 * The tenant's active connection for an adapter. `sandbox` connections
 * (Integration.config.sandbox = true) run against fictional data (./sandbox.ts).
 */
export async function getIntegrationForAdapter(
  tenantId: string,
  adapterName: string
): Promise<{ credentials: Record<string, unknown>; sandbox: boolean }> {
  const integration = await prisma.integration.findFirst({ where: { tenantId, name: adapterName, isActive: true } })
  if (!integration) throw new Error(`No active "${adapterName}" integration is configured for this tenant.`)
  const config = (integration.config ?? {}) as Record<string, unknown>
  return { credentials: decryptCredentials(integration.credentials, tenantId), sandbox: config.sandbox === true }
}

/** Runs a tool on a tenant's connection: the real service, or the sandbox dataset for sandbox connections. */
export async function executeOnTenantConnection(
  registered: RegisteredTool,
  input: unknown,
  tenantId: string,
  timeoutMs = DEFAULT_TOOL_TIMEOUT_MS
): Promise<unknown> {
  const connection = await getIntegrationForAdapter(tenantId, registered.adapter.name)
  if (connection.sandbox) return sandboxExecute(registered.toolName, validateToolInput(registered, input))
  return executeToolCall(registered, input, connection.credentials, timeoutMs)
}

export async function getCredentialsForAdapter(
  tenantId: string,
  adapterName: string
): Promise<Record<string, unknown>> {
  const integration = await prisma.integration.findFirst({
    where: { tenantId, name: adapterName, isActive: true },
  })
  if (!integration) {
    throw new Error(`No active "${adapterName}" integration is configured for this tenant.`)
  }
  return decryptCredentials(integration.credentials, tenantId)
}

export function validateToolInput(registered: RegisteredTool, input: unknown): unknown {
  const parsed = registered.action.inputSchema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new ToolInputValidationError(registered.toolName, issues)
  }
  return parsed.data
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ToolTimeoutError(toolName, timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Validates input against the action's Zod schema, executes it against the
 * adapter, then best-effort validates the output (falling back to the raw
 * result if the live API response doesn't exactly match outputSchema — the
 * executor treats every tool result as untrusted data either way).
 */
export async function executeToolCall(
  registered: RegisteredTool,
  input: unknown,
  credentials: Record<string, unknown>,
  timeoutMs = DEFAULT_TOOL_TIMEOUT_MS
): Promise<unknown> {
  const parsedInput = validateToolInput(registered, input)
  const rawOutput = await withTimeout(registered.action.execute(parsedInput, credentials), timeoutMs, registered.toolName)
  const parsedOutput = registered.action.outputSchema.safeParse(rawOutput)
  return parsedOutput.success ? parsedOutput.data : rawOutput
}

export interface ToolPolicyContext {
  /**
   * Defaults to 'expanded' — i.e. AgentPermission alone decides, which was the
   * behaviour before autonomy stages existed. runAgent() always passes the
   * agent's effective stage explicitly.
   */
  stage?: AutonomyStage
  /** null/undefined = no contract allowlist; every resolved skill tool is allowed. */
  allowedTools?: string[] | null
  /** Tools revoked by a tenant/global kill switch. */
  disabledTools?: string[]
  /** Execute a call a human already approved (still subject to deny rules). */
  preApproved?: boolean
}

export interface AuthorizedToolCall {
  decision: ToolDecision
  profile: ToolRiskProfile
  input: unknown
}

/** Permission + policy check only (no execution). Validates arguments first so approvers never see malformed calls. */
export async function authorizeToolCall(
  params: { agentId: string; registered: RegisteredTool; input: unknown } & ToolPolicyContext
): Promise<AuthorizedToolCall> {
  const toolName = params.registered.toolName
  const input = validateToolInput(params.registered, params.input)
  const permission = await checkPermission(params.agentId, toolName)
  const profile = getToolRiskProfile(toolName)
  const decision = decideToolAction({
    toolName,
    stage: params.stage ?? 'expanded',
    risk: profile.risk,
    permissionLevel: permission.level,
    allowlisted: !params.allowedTools || params.allowedTools.includes(toolName),
    disabled: params.disabledTools?.includes(toolName) ?? false,
    preApproved: params.preApproved,
  })
  return { decision, profile, input }
}

/**
 * The full permission-checked path from a tool call name to a result:
 * denies prohibited/out-of-scope actions, throws ToolApprovalRequiredError for
 * anything needing sign-off (caller is expected to create an Approval and
 * pause), throws ToolProposalRecordedError when the autonomy stage only allows
 * proposals, and otherwise loads tenant credentials and executes.
 */
export async function checkAndExecuteToolCall(
  params: {
    agentId: string
    tenantId: string
    registered: RegisteredTool
    input: unknown
    timeoutMs?: number
  } & ToolPolicyContext
): Promise<unknown> {
  const { decision, input } = await authorizeToolCall(params)
  const toolName = params.registered.toolName

  switch (decision.kind) {
    case 'deny':
      throw new ToolPermissionDeniedError(toolName, decision.level, decision.reason)
    case 'approval':
      throw new ToolApprovalRequiredError(toolName, decision.level, decision.reason)
    case 'propose':
      throw new ToolProposalRecordedError(toolName, decision.reason)
    case 'execute': {
      return executeOnTenantConnection(params.registered, input, params.tenantId, params.timeoutMs)
    }
  }
}
