import { createHash } from 'node:crypto'
import { prisma } from '@ai-workforce/db'
import type { AutonomyStage } from '@ai-workforce/tools'
import type { AgentContract } from './contract'

// ---------------------------------------------------------------------------
// Kill switches (brief §9 "keep a kill switch and a way to revoke tool access")
// ---------------------------------------------------------------------------

export interface KillSwitchState {
  agentsDisabled: boolean
  disabledTools: string[]
  reason?: string
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())
}

/**
 * Three levels, any of which stops execution without a deploy:
 * - global:  AGENTS_DISABLED=true / DISABLED_TOOLS=gmail__send_email,... in the worker env
 * - tenant:  Tenant.settings.killSwitch = { agentsDisabled, disabledTools, reason }
 * - agent:   Agent.status PAUSED or ARCHIVED (checked in runAgent)
 */
export function readKillSwitch(tenantSettings: unknown, env: Record<string, string | undefined> = process.env): KillSwitchState {
  const tenant =
    tenantSettings && typeof tenantSettings === 'object'
      ? ((tenantSettings as Record<string, unknown>).killSwitch as Record<string, unknown> | undefined)
      : undefined
  const envTools = (env.DISABLED_TOOLS ?? '').split(',').map((t) => t.trim()).filter(Boolean)
  const tenantTools = Array.isArray(tenant?.disabledTools) ? (tenant!.disabledTools as unknown[]).filter((t): t is string => typeof t === 'string') : []

  if (truthy(env.AGENTS_DISABLED)) {
    return { agentsDisabled: true, disabledTools: [...envTools, ...tenantTools], reason: 'All agents are disabled platform-wide (AGENTS_DISABLED).' }
  }
  const tenantDisabled = tenant?.agentsDisabled === true
  return {
    agentsDisabled: tenantDisabled,
    disabledTools: Array.from(new Set([...envTools, ...tenantTools])),
    reason: tenantDisabled
      ? `Agents are disabled for this tenant${typeof tenant?.reason === 'string' ? `: ${tenant.reason}` : ''}.`
      : undefined,
  }
}

// ---------------------------------------------------------------------------
// Progressive trust: limited/expanded autonomy needs evaluation evidence
// ---------------------------------------------------------------------------

export interface EffectiveStage {
  stage: AutonomyStage
  configured: AutonomyStage
  capped: boolean
  reason?: string
}

/**
 * The configured stage only takes effect above approval_gated when a passing
 * Evaluation exists for the agent's *current* version. Any material change
 * bumps Agent.version (PUT /api/agents/[id]), which therefore drops the agent
 * back to approval-gated until it is re-evaluated (brief §9).
 */
export async function resolveEffectiveStage(agent: { id: string; version: number }, contract: AgentContract): Promise<EffectiveStage> {
  const configured = contract.autonomyStage
  if (configured !== 'limited' && configured !== 'expanded') {
    return { stage: configured, configured, capped: false }
  }
  const evidence = await prisma.evaluation.findFirst({
    where: { agentId: agent.id, agentVersion: agent.version, passed: true },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (evidence) return { stage: configured, configured, capped: false }
  return {
    stage: 'approval_gated',
    configured,
    capped: true,
    reason: `No passing evaluation for agent version ${agent.version}; "${configured}" autonomy is capped to approval_gated until one exists.`,
  }
}

// ---------------------------------------------------------------------------
// Idempotency for non-idempotent tool calls
// ---------------------------------------------------------------------------

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

export function toolIdempotencyKey(tenantId: string, agentId: string, toolName: string, input: unknown): string {
  return createHash('sha256').update(`${tenantId}|${agentId}|${toolName}|${canonicalJson(input)}`).digest('hex')
}

export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000

export interface PriorExecution {
  outcome: 'completed' | 'unknown'
  runId?: string
  at: Date
  output?: unknown
}

/**
 * Looks for an earlier execution of the exact same call (same tenant, agent,
 * tool and canonicalised arguments) inside the window. "unknown" means a
 * previous attempt timed out — the side effect may have happened, so it must
 * be verified by a human rather than repeated.
 *
 * Limitation: check-then-act, not a lock. Two runs racing on the identical
 * call within milliseconds could both pass; see docs/AGENT_OPERATING_SYSTEM.md.
 */
export async function findPriorToolExecution(
  tenantId: string,
  idempotencyKey: string,
  now = new Date(),
  windowMs = IDEMPOTENCY_WINDOW_MS
): Promise<PriorExecution | null> {
  const row = await prisma.auditLog.findFirst({
    where: {
      tenantId,
      action: { in: ['AGENT_TOOL_CALL', 'AGENT_TOOL_CALL_UNKNOWN'] },
      createdAt: { gte: new Date(now.getTime() - windowMs) },
      newData: { path: ['idempotencyKey'], equals: idempotencyKey },
    },
    orderBy: { createdAt: 'desc' },
  })
  if (!row) return null
  const data = (row.newData ?? {}) as Record<string, unknown>
  return {
    outcome: row.action === 'AGENT_TOOL_CALL' ? 'completed' : 'unknown',
    runId: typeof data.runId === 'string' ? data.runId : undefined,
    at: row.createdAt,
    output: data.output,
  }
}
