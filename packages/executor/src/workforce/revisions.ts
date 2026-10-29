import { prisma } from '@ai-workforce/db'
import type { AgentRevision, Prisma } from '@prisma/client'
import { redact, redactString, safeErrorMessage } from '@ai-workforce/domain'
import { runAgent, type RunAgentDeps, type RunAgentStatus } from '../agent'
import { validateAgentDefinition } from '../contract'
import { parseEvalCases, runEvaluation } from '../evaluation'
import { getAgentRunMetrics, type AgentRunMetrics } from '../metrics'
import { readKillSwitch } from '../safety'
import { checkRevisionInvariants, type InvariantResult } from './invariants'
import { readSelfManagementPolicy, type SelfManagementPolicy } from './policy'
import {
  agentChangesSchema,
  agentSpecSchema,
  applySpec,
  carryOverCases,
  loadSkillInfos,
  newestPlaybooks,
  materializeSkills,
  mergeSpec,
  readAgentSpec,
  skillInfoFromRow,
  SpecError,
  suiteOf,
  type AgentSpec,
  type SkillInfo,
} from './spec'

/**
 * The revision pipeline (docs/WORKFORCE_MANAGER.md):
 *
 *   proposeRevision  → invariant check, rate limit, one open revision per agent
 *   processRevision  → sandbox candidate agent → validation → evaluation suite
 *                      → baseline parity → replay of recent real inputs
 *                      → risk-increasing? human approval : promote
 *   promoteRevision  → apply the spec to the live agent as a new version
 *   watchPromotedRevisions → automatic rollback if live metrics degrade
 *   rollbackRevision → re-apply the previous spec as a new version
 *
 * A change never edits the live agent until it has passed every gate.
 */

export type ChangeType = 'create' | 'update' | 'retire'
export type RevisionStatus =
  | 'PROPOSED'
  | 'EVALUATING'
  | 'AWAITING_APPROVAL'
  | 'PROMOTING'
  | 'PROMOTED'
  | 'ROLLING_BACK'
  | 'ROLLED_BACK'
  | 'FAILED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'SUPERSEDED'
  | 'BLOCKED'

export const OPEN_REVISION_STATUSES: RevisionStatus[] = ['PROPOSED', 'EVALUATING', 'AWAITING_APPROVAL', 'PROMOTING']

const DEFAULT_MODEL = { modelProvider: 'anthropic', modelName: 'claude-haiku-4-5-20251001' }
const RUN_ACTIONS = ['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_FINISHED', 'AGENT_RUN_ESCALATED']

export class RevisionError extends Error {
  constructor(
    message: string,
    public readonly code: 'DISABLED' | 'NOT_FOUND' | 'INVALID' | 'CONFLICT' | 'RATE_LIMITED',
    public readonly issues: string[] = []
  ) {
    super(issues.length ? `${message}: ${issues.join(' | ')}` : message)
    this.name = 'RevisionError'
  }
}

export interface RevisionOutcome {
  revisionId: string
  status: RevisionStatus
  agentId?: string | null
  /** Set when a newly created agent was promoted: the caller (queue worker) starts its deployment. */
  deployAgentId?: string
  approvalId?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Shared state loaders
// ---------------------------------------------------------------------------

interface TenantState {
  policy: SelfManagementPolicy
  policyError?: string
  agentsDisabled: boolean
  killReason?: string
  disabledTools: string[]
  enabledAdapters: Set<string>
  tenantAgentIds: Set<string>
}

async function loadTenantState(tenantId: string): Promise<TenantState> {
  const [tenant, integrations, agents] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } }),
    prisma.integration.findMany({ where: { tenantId, isActive: true }, select: { name: true } }),
    prisma.agent.findMany({ where: { tenantId, isCandidate: false, status: { not: 'ARCHIVED' } }, select: { id: true } }),
  ])
  const { policy, error } = readSelfManagementPolicy(tenant.settings)
  const kill = readKillSwitch(tenant.settings)
  return {
    policy: error ? { ...policy, enabled: false } : policy,
    policyError: error,
    agentsDisabled: kill.agentsDisabled,
    killReason: kill.reason,
    disabledTools: kill.disabledTools,
    enabledAdapters: new Set(integrations.map((i) => i.name)),
    tenantAgentIds: new Set(agents.map((a) => a.id)),
  }
}

function assertEnabled(state: TenantState): void {
  if (state.policyError) throw new RevisionError(state.policyError, 'DISABLED')
  if (!state.policy.enabled) throw new RevisionError('Self-management is disabled for this tenant (Tenant.settings.selfManagement.enabled)', 'DISABLED')
  if (state.agentsDisabled) throw new RevisionError(state.killReason ?? 'Agents are disabled (kill switch)', 'DISABLED')
}

async function currentAgentState(agentId: string) {
  const { agent, spec } = await readAgentSpec(agentId)
  const skillRows = await prisma.skill.findMany({ where: { id: { in: spec.skills.flatMap((s) => ('skillId' in s ? [s.skillId] : [])) } } })
  return { agent, spec, skills: skillRows.map(skillInfoFromRow) }
}

async function audit(tenantId: string, revisionId: string, action: string, data: Record<string, unknown>, userId?: string): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: { action, entityType: 'AgentRevision', entityId: revisionId, tenantId, userId, newData: redact(data) as Prisma.InputJsonValue },
    })
  } catch (error) {
    console.error('Failed to record revision audit log:', safeErrorMessage(error))
  }
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

function readSpec(value: Prisma.JsonValue | null): AgentSpec {
  return agentSpecSchema.parse(value)
}

function mergeResults(rev: Pick<AgentRevision, 'results'>, patch: Record<string, unknown>): Prisma.InputJsonValue {
  const base = (rev.results && typeof rev.results === 'object' ? rev.results : {}) as Record<string, unknown>
  return json({ ...base, ...patch })
}

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

export interface ProposeRevisionParams {
  tenantId: string
  changeType: ChangeType
  /** Target agent (update/retire). */
  agentId?: string
  rationale: string
  changes?: unknown
  addEvaluationCases?: unknown[]
  proposedBy: { agentId?: string; userId?: string; runId?: string }
  now?: Date
}

/** JSON with sorted keys, so two specs built in different orders compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** True when two specs differ at most in their evaluation cases. */
export function sameBehaviour(a: AgentSpec, b: AgentSpec): boolean {
  return canonical({ ...a, evaluationCases: undefined }) === canonical({ ...b, evaluationCases: undefined })
}

export async function proposeRevision(params: ProposeRevisionParams): Promise<{ revisionId: string; riskIncreases: string[]; tools: string[] }> {
  const now = params.now ?? new Date()
  const state = await loadTenantState(params.tenantId)
  assertEnabled(state)

  const rationale = params.rationale?.trim() ?? ''
  if (rationale.length < 10) throw new RevisionError('A rationale of at least 10 characters is required', 'INVALID')

  const recent = await prisma.agentRevision.count({ where: { tenantId: params.tenantId, createdAt: { gte: new Date(now.getTime() - 86_400_000) } } })
  if (recent >= state.policy.maxRevisionsPerDay) {
    throw new RevisionError(`Daily revision limit reached (${state.policy.maxRevisionsPerDay} per 24 h)`, 'RATE_LIMITED')
  }

  let current: Awaited<ReturnType<typeof currentAgentState>> | null = null
  if (params.changeType !== 'create') {
    if (!params.agentId) throw new RevisionError(`${params.changeType} needs an agentId`, 'INVALID')
    const target = await prisma.agent.findUnique({ where: { id: params.agentId }, select: { tenantId: true, isCandidate: true, status: true } })
    if (!target || target.tenantId !== params.tenantId || target.isCandidate || target.status === 'ARCHIVED') {
      throw new RevisionError('Agent not found in this tenant', 'NOT_FOUND')
    }
    if (params.proposedBy.agentId && params.proposedBy.agentId === params.agentId) {
      throw new RevisionError('An agent cannot propose changes to itself', 'INVALID')
    }
    const open = await prisma.agentRevision.findFirst({ where: { agentId: params.agentId, status: { in: OPEN_REVISION_STATUSES } }, select: { id: true } })
    if (open) throw new RevisionError(`Agent already has an open revision (${open.id}); wait for it to finish`, 'CONFLICT')
    current = await currentAgentState(params.agentId)
  }

  let candidate: { spec: AgentSpec; skills: SkillInfo[] } | null = null
  if (params.changeType !== 'retire') {
    const changes = agentChangesSchema.safeParse(params.changes ?? {})
    if (!changes.success) {
      throw new RevisionError('Invalid changes', 'INVALID', changes.error.issues.map((i) => `changes.${i.path.join('.')}: ${i.message}`))
    }
    const { cases, invalid } = parseEvalCases(params.addEvaluationCases ?? [])
    const unassertable = cases.filter((c) => !c.expect).length
    if (invalid.length || unassertable) {
      throw new RevisionError('Invalid evaluation cases', 'INVALID', [...invalid, ...(unassertable ? [`${unassertable} case(s) have no "expect" assertions`] : [])])
    }

    let defaults = DEFAULT_MODEL
    if (params.proposedBy.agentId) {
      const proposer = await prisma.agent.findUnique({ where: { id: params.proposedBy.agentId }, select: { modelProvider: true, modelName: true } })
      if (proposer) defaults = proposer
    }
    try {
      let spec = mergeSpec(current?.spec ?? null, changes.data, params.addEvaluationCases ?? [], defaults)
      const loaded = await loadSkillInfos(params.tenantId, spec.skills)
      if (loaded.errors.length) throw new RevisionError('Invalid playbooks', 'INVALID', loaded.errors)
      const newest = newestPlaybooks(spec, loaded.skills)
      spec = newest.spec
      if (current) spec = carryOverCases(spec, newest.skills, suiteOf(current.spec, current.skills))
      candidate = { spec, skills: newest.skills }
    } catch (error) {
      if (error instanceof SpecError) throw new RevisionError(error.message, 'INVALID', error.issues)
      throw error
    }
  }

  // An update that only adds test cases can't fix anything: the candidate behaves exactly like the
  // live agent (on 18 Oct the manager described a playbook fix but sent only the new case, so the
  // unchanged agent failed it). Refuse it with how to change a playbook, so the manager can correct it.
  if (params.changeType === 'update' && current && candidate && sameBehaviour(current.spec, candidate.spec)) {
    throw new RevisionError('Proposal changes nothing about how the agent behaves', 'INVALID', [
      'Only evaluation cases were added; the agent, its prompt and its playbooks are unchanged, so the new case would fail on the candidate exactly as it does live.',
      'To change a playbook\'s instructions, put a new version in changes.skills: [{"create": {"name": "<same name>", "version": "<higher, e.g. 1.1.0>", "description", "purpose", "instructions": "<the full new text>", "requiredTools", "constraints", "evaluationCases"}}], and keep the agent\'s other playbooks as {"skillId"}.',
    ])
  }

  const check = checkRevisionInvariants({
    changeType: params.changeType,
    current: current ? { spec: current.spec, skills: current.skills, status: current.agent.status } : null,
    candidate,
    policy: state.policy,
    enabledAdapters: state.enabledAdapters,
    disabledTools: state.disabledTools,
    tenantAgentIds: state.tenantAgentIds,
  })
  if (check.violations.length) throw new RevisionError('Proposal violates self-management limits', 'INVALID', check.violations)

  const revision = await prisma.agentRevision.create({
    data: {
      tenantId: params.tenantId,
      agentId: params.agentId ?? null,
      changeType: params.changeType,
      status: 'PROPOSED',
      rationale: redactString(rationale, 4000),
      changes: json(redact({ changes: params.changes ?? {}, addEvaluationCases: params.addEvaluationCases ?? [] })),
      spec: candidate ? json(candidate.spec) : undefined,
      previousSpec: current ? json(current.spec) : undefined,
      risk: json({ violations: [], riskIncreases: check.riskIncreases, tools: check.tools }),
      results: json(current && params.changeType === 'retire' ? { previousStatus: current.agent.status } : {}),
      baseVersion: current?.agent.version ?? null,
      proposedByAgentId: params.proposedBy.agentId,
      proposedByUserId: params.proposedBy.userId,
      proposedByRunId: params.proposedBy.runId,
    },
  })
  await audit(params.tenantId, revision.id, 'AGENT_REVISION_PROPOSED', {
    changeType: params.changeType,
    agentId: params.agentId,
    riskIncreases: check.riskIncreases,
    proposedBy: params.proposedBy,
  }, params.proposedBy.userId)
  return { revisionId: revision.id, riskIncreases: check.riskIncreases, tools: check.tools }
}

// ---------------------------------------------------------------------------
// Process: sandbox → validate → evaluate → parity → replay → approve/promote
// ---------------------------------------------------------------------------

async function finishRevision(rev: Pick<AgentRevision, 'id' | 'tenantId' | 'results'>, status: RevisionStatus, error: string, results: Record<string, unknown> = {}): Promise<RevisionOutcome> {
  await prisma.agentRevision.update({ where: { id: rev.id }, data: { status, error: redactString(error, 4000), results: mergeResults(rev, results) } })
  await discardCandidate(rev.id)
  await audit(rev.tenantId, rev.id, `AGENT_REVISION_${status}`, { error, ...results })
  return { revisionId: rev.id, status, error }
}

/** Deletes the sandbox agent and any playbooks this revision created that nothing else uses. */
export async function discardCandidate(revisionId: string): Promise<void> {
  const rev = await prisma.agentRevision.findUnique({ where: { id: revisionId }, select: { candidateAgentId: true, createdSkillIds: true } })
  if (!rev) return
  if (rev.candidateAgentId) await prisma.agent.deleteMany({ where: { id: rev.candidateAgentId, isCandidate: true } })
  for (const skillId of rev.createdSkillIds) {
    const inUse = await prisma.agentSkill.count({ where: { skillId } })
    if (!inUse) await prisma.skill.deleteMany({ where: { id: skillId } })
  }
}

function isBadOutcome(status: unknown, dodPassed?: unknown): boolean {
  return status === 'failed' || status === 'blocked' || status === 'cancelled' || status === 'partial' || dodPassed === false
}

export interface ReplayResult {
  runs: number
  liveBad: number
  candidateBad: number
  cases: Array<{ live: string; candidate: RunAgentStatus; costUsd: number | null }>
}

/**
 * Shadow test: re-runs the target's most recent real inputs against the
 * candidate in dry-run mode. Read-only tools run for real (no side effects) so
 * the candidate sees real data; every other tool is simulated.
 */
async function replayRecentInputs(targetId: string, candidateId: string, count: number, deps?: RunAgentDeps): Promise<ReplayResult> {
  const result: ReplayResult = { runs: 0, liveBad: 0, candidateBad: 0, cases: [] }
  if (count <= 0) return result
  const rows = await prisma.auditLog.findMany({
    where: { entityType: 'Agent', entityId: targetId, action: { in: RUN_ACTIONS } },
    orderBy: { createdAt: 'desc' },
    take: count * 5,
    select: { newData: true },
  })
  const seen = new Set<string>()
  for (const row of rows) {
    if (result.runs >= count) break
    const data = (row.newData ?? {}) as Record<string, unknown>
    if (data.dryRun === true || typeof data.input !== 'string' || !data.input.trim()) continue
    if (data.trigger === 'evaluation' || data.trigger === 'replay' || data.trigger === 'delegation') continue
    if (seen.has(data.input)) continue
    seen.add(data.input)

    const run = await runAgent(candidateId, data.input, { dryRun: true, liveReads: true, trigger: 'replay', deps })
    result.runs++
    if (isBadOutcome(data.status, data.dodPassed)) result.liveBad++
    if (isBadOutcome(run.status, run.dod?.passed)) result.candidateBad++
    result.cases.push({ live: String(data.status), candidate: run.status, costUsd: run.costUsd })
  }
  return result
}

async function requestRevisionApproval(rev: AgentRevision, risk: string[], policy: SelfManagementPolicy): Promise<string> {
  const approval = await prisma.approval.create({
    data: {
      action: 'agent_revision',
      level: 'CUSTOMER_APPROVAL',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + policy.approvalTtlHours * 3_600_000),
      agentId: rev.agentId,
      runId: rev.proposedByRunId,
      tenantId: rev.tenantId,
      input: json({
        kind: 'agent_revision',
        revisionId: rev.id,
        summary: {
          action: `${rev.changeType} agent`,
          target: rev.agentId ?? 'new agent',
          riskClass: 'agent_revision',
          sideEffects: 'Changes what an AI agent is allowed to do. Passed its evaluation suite and replay; a human must accept the added risk.',
          material: { riskIncreases: risk, rationale: rev.rationale },
          rationale: rev.rationale,
          policyReason: 'Risk-increasing revisions need human approval (self-management policy)',
          evidence: { revisionId: rev.id, results: rev.results },
        },
      }),
    },
  })
  await audit(rev.tenantId, rev.id, 'APPROVAL_REQUESTED', { approvalId: approval.id, riskIncreases: risk })
  return approval.id
}

export async function processRevision(revisionId: string, options: { deps?: RunAgentDeps } = {}): Promise<RevisionOutcome> {
  const claimed = await prisma.agentRevision.updateMany({ where: { id: revisionId, status: 'PROPOSED' }, data: { status: 'EVALUATING' } })
  const rev = await prisma.agentRevision.findUnique({ where: { id: revisionId } })
  if (!rev) throw new RevisionError('Revision not found', 'NOT_FOUND')
  if (claimed.count !== 1) return { revisionId, status: rev.status as RevisionStatus, agentId: rev.agentId, error: `Revision is ${rev.status}, not PROPOSED` }

  try {
    const state = await loadTenantState(rev.tenantId)
    try {
      assertEnabled(state)
    } catch (error) {
      return finishRevision(rev, 'BLOCKED', safeErrorMessage(error))
    }

    const changeType = rev.changeType as ChangeType
    let current: Awaited<ReturnType<typeof currentAgentState>> | null = null
    if (changeType !== 'create') {
      if (!rev.agentId) return finishRevision(rev, 'FAILED', 'Target agent no longer exists')
      current = await currentAgentState(rev.agentId)
      if (current.agent.version !== rev.baseVersion) {
        return finishRevision(rev, 'SUPERSEDED', `Agent changed since the proposal (version ${rev.baseVersion} → ${current.agent.version}); propose again against the current version.`)
      }
    }

    // Re-check the hard limits against the tenant as it is now (integrations, kill switch, ceiling may have changed).
    let candidateSpec: AgentSpec | null = rev.spec ? readSpec(rev.spec) : null
    let candidateSkills: SkillInfo[] = []
    if (candidateSpec) {
      const loaded = await loadSkillInfos(rev.tenantId, candidateSpec.skills)
      if (loaded.errors.length) return finishRevision(rev, 'FAILED', loaded.errors.join('; '))
      candidateSkills = loaded.skills
    }
    const check: InvariantResult = checkRevisionInvariants({
      changeType,
      current: current ? { spec: current.spec, skills: current.skills, status: current.agent.status } : null,
      candidate: candidateSpec ? { spec: candidateSpec, skills: candidateSkills } : null,
      policy: state.policy,
      enabledAdapters: state.enabledAdapters,
      disabledTools: state.disabledTools,
      tenantAgentIds: state.tenantAgentIds,
    })
    await prisma.agentRevision.update({ where: { id: rev.id }, data: { risk: json({ violations: check.violations, riskIncreases: check.riskIncreases, tools: check.tools }) } })
    if (check.violations.length) return finishRevision(rev, 'FAILED', `Violates self-management limits: ${check.violations.join(' | ')}`)

    if (changeType === 'retire') {
      return decide(rev, check.riskIncreases, state.policy)
    }

    // ---- sandbox candidate
    const owner = rev.proposedByAgentId ? `Workforce Manager (${rev.proposedByAgentId})` : rev.proposedByUserId ? `user ${rev.proposedByUserId}` : 'self-management'
    const sandbox = await prisma.$transaction(async (tx) => {
      const materialized = await materializeSkills(tx, rev.tenantId, candidateSpec!, { revisionId: rev.id, owner })
      const agent = await tx.agent.create({
        data: {
          name: materialized.spec.name,
          role: materialized.spec.role,
          mission: materialized.spec.mission,
          systemPrompt: materialized.spec.systemPrompt,
          modelProvider: materialized.spec.modelProvider,
          modelName: materialized.spec.modelName,
          status: 'DRAFT',
          isCandidate: true,
          tenantId: rev.tenantId,
        },
      })
      if (rev.agentId) {
        // The candidate must know what the live agent knows: its knowledge documents and the
        // settings outside the spec (voice, for example). Without them an agent that answers
        // from documents is tested blind and fails (seen 18 Oct: "the price list isn't in my
        // reference knowledge"). applySpec below then sets everything the revision changes.
        const live = await tx.agent.findUnique({ where: { id: rev.agentId }, select: { config: true, knowledgeSources: { select: { documentId: true, priority: true } } } })
        if (live?.knowledgeSources.length) {
          await tx.agentKnowledgeSource.createMany({ data: live.knowledgeSources.map((k) => ({ agentId: agent.id, documentId: k.documentId, priority: k.priority })) })
        }
        if (live?.config && typeof live.config === 'object') await tx.agent.update({ where: { id: agent.id }, data: { config: live.config as Prisma.InputJsonValue } })
      }
      await applySpec(tx, agent.id, materialized.spec, { incrementVersion: false })
      return { candidateId: agent.id, spec: materialized.spec, createdSkillIds: materialized.createdSkillIds }
    })
    candidateSpec = sandbox.spec
    await prisma.agentRevision.update({
      where: { id: rev.id },
      data: { candidateAgentId: sandbox.candidateId, createdSkillIds: sandbox.createdSkillIds, spec: json(sandbox.spec) },
    })

    // ---- deployability
    const candidateAgent = await prisma.agent.findUniqueOrThrow({ where: { id: sandbox.candidateId } })
    const skillRows = await prisma.skill.findMany({ where: { id: { in: sandbox.spec.skills.flatMap((s) => ('skillId' in s ? [s.skillId] : [])) } } })
    const validation = validateAgentDefinition(candidateAgent, skillRows, { forDeployment: true })
    if (!validation.ok) return finishRevision(rev, 'FAILED', `Candidate is not deployable: ${validation.errors.join(' | ')}`)

    // ---- evaluation suite (dry run; real model calls)
    const suite = suiteOf(sandbox.spec, skillRows.map(skillInfoFromRow))
    const evaluation = await runEvaluation(sandbox.candidateId, { cases: suite, name: `revision ${rev.id} candidate`, deps: options.deps })
    const evaluationSummary = {
      evaluationId: evaluation.evaluationId,
      passed: evaluation.passed,
      passRate: evaluation.passRate,
      failures: evaluation.results.filter((r) => !r.passed).map((r) => ({ name: r.name, failures: r.failures })),
    }
    if (!evaluation.passed) return finishRevision(rev, 'FAILED', `Candidate failed its evaluation suite (pass rate ${evaluation.passRate.toFixed(2)})`, { evaluation: evaluationSummary })

    // ---- baseline parity: never promote something that scores worse than what is live
    let baseline: { evaluationId: string; score: number | null } | null = null
    if (current) {
      const row = await prisma.evaluation.findFirst({ where: { agentId: current.agent.id, agentVersion: current.agent.version }, orderBy: { createdAt: 'desc' } })
      if (row) baseline = { evaluationId: row.id, score: row.score }
      if (row?.score != null && evaluation.passRate < row.score) {
        return finishRevision(rev, 'FAILED', `Candidate pass rate ${evaluation.passRate.toFixed(2)} is below the live version's ${row.score.toFixed(2)}`, { evaluation: evaluationSummary, baseline })
      }
    }

    // ---- replay recent real inputs
    let replay: ReplayResult | null = null
    if (current) {
      replay = await replayRecentInputs(current.agent.id, sandbox.candidateId, state.policy.replayRuns, options.deps)
      if (replay.candidateBad > replay.liveBad) {
        return finishRevision(rev, 'FAILED', `Replay: candidate did worse than the live agent on recent real inputs (${replay.candidateBad} vs ${replay.liveBad} bad outcomes of ${replay.runs})`, { evaluation: evaluationSummary, baseline, replay })
      }
    }

    const updated = await prisma.agentRevision.update({
      where: { id: rev.id },
      data: { results: mergeResults(rev, { evaluation: evaluationSummary, baseline, replay }) },
    })
    return decide(updated, check.riskIncreases, state.policy)
  } catch (error) {
    return finishRevision(rev, 'FAILED', safeErrorMessage(error, 'Revision processing failed'))
  }
}

async function decide(rev: AgentRevision, riskIncreases: string[], policy: SelfManagementPolicy): Promise<RevisionOutcome> {
  if (riskIncreases.length) {
    const approvalId = await requestRevisionApproval(rev, riskIncreases, policy)
    await prisma.agentRevision.update({ where: { id: rev.id }, data: { status: 'AWAITING_APPROVAL', approvalId } })
    await audit(rev.tenantId, rev.id, 'AGENT_REVISION_AWAITING_APPROVAL', { approvalId, riskIncreases })
    return { revisionId: rev.id, status: 'AWAITING_APPROVAL', agentId: rev.agentId, approvalId }
  }
  return promoteRevision(rev.id)
}

// ---------------------------------------------------------------------------
// Promote / reject / rollback
// ---------------------------------------------------------------------------

async function copyEvaluation(fromAgentId: string, fromVersion: number | null, toAgentId: string, toVersion: number, note: string): Promise<void> {
  const source = await prisma.evaluation.findFirst({
    where: { agentId: fromAgentId, ...(fromVersion !== null ? { agentVersion: fromVersion } : {}), passed: true },
    orderBy: { createdAt: 'desc' },
  })
  if (!source) return
  await prisma.evaluation.create({
    data: {
      name: `${source.name} (${note})`,
      agentId: toAgentId,
      agentVersion: toVersion,
      suite: source.suite as Prisma.InputJsonValue,
      results: json({ ...((source.results ?? {}) as Record<string, unknown>), copiedFromEvaluationId: source.id, note }),
      score: source.score,
      passed: source.passed,
    },
  })
}

/**
 * Applies an evaluated (and, if needed, approved) revision. Called by
 * processRevision for low-risk changes and by executeApprovedAction after a
 * human approves a risk-increasing one. Exactly once: claimed by a conditional update.
 */
export async function promoteRevision(revisionId: string, options: { approvedByUserId?: string; now?: Date } = {}): Promise<RevisionOutcome> {
  const now = options.now ?? new Date()
  const claimed = await prisma.agentRevision.updateMany({ where: { id: revisionId, status: { in: ['EVALUATING', 'AWAITING_APPROVAL'] } }, data: { status: 'PROMOTING' } })
  const rev = await prisma.agentRevision.findUnique({ where: { id: revisionId } })
  if (!rev) throw new RevisionError('Revision not found', 'NOT_FOUND')
  if (claimed.count !== 1) return { revisionId, status: rev.status as RevisionStatus, agentId: rev.agentId, error: `Revision is ${rev.status}; cannot promote` }

  try {
    const state = await loadTenantState(rev.tenantId)
    if (state.agentsDisabled) return finishRevision(rev, 'BLOCKED', state.killReason ?? 'Agents are disabled (kill switch)')
    const policy = state.policy
    const watchUntil = new Date(now.getTime() + policy.watch.hours * 3_600_000)

    if (rev.changeType === 'retire') {
      await prisma.agent.update({ where: { id: rev.agentId! }, data: { status: 'PAUSED' } })
      await prisma.agentRevision.update({ where: { id: rev.id }, data: { status: 'PROMOTED', promotedAt: now } })
      await audit(rev.tenantId, rev.id, 'AGENT_REVISION_PROMOTED', { changeType: 'retire', agentId: rev.agentId }, options.approvedByUserId)
      return { revisionId: rev.id, status: 'PROMOTED', agentId: rev.agentId }
    }

    if (rev.changeType === 'create') {
      const agentId = rev.candidateAgentId!
      await prisma.agent.update({ where: { id: agentId }, data: { isCandidate: false, status: 'DRAFT' } })
      await prisma.agentRevision.update({
        where: { id: rev.id },
        data: { status: 'PROMOTED', agentId, promotedVersion: 1, promotedAt: now, watchUntil, candidateAgentId: null },
      })
      await audit(rev.tenantId, rev.id, 'AGENT_REVISION_PROMOTED', { changeType: 'create', agentId }, options.approvedByUserId)
      return { revisionId: rev.id, status: 'PROMOTED', agentId, deployAgentId: agentId }
    }

    // update
    const target = await currentAgentState(rev.agentId!)
    if (target.agent.version !== rev.baseVersion) {
      return finishRevision(rev, 'SUPERSEDED', `Agent changed while the revision was pending (version ${rev.baseVersion} → ${target.agent.version})`)
    }
    const baselineMetrics = await getAgentRunMetrics({ tenantId: rev.tenantId, agentId: target.agent.id, since: new Date(now.getTime() - 7 * 86_400_000) })
    const spec = readSpec(rev.spec)
    const promoted = await prisma.$transaction(async (tx) => applySpec(tx, target.agent.id, spec, { incrementVersion: true }))
    if (rev.candidateAgentId) await copyEvaluation(rev.candidateAgentId, null, target.agent.id, promoted.version, `evaluated as revision ${rev.id}`)
    await prisma.agentRevision.update({
      where: { id: rev.id },
      data: {
        status: 'PROMOTED',
        promotedVersion: promoted.version,
        promotedAt: now,
        watchUntil,
        previousSpec: json(target.spec),
        baselineMetrics: json(baselineMetrics),
      },
    })
    await discardCandidate(rev.id)
    await audit(rev.tenantId, rev.id, 'AGENT_REVISION_PROMOTED', { changeType: 'update', agentId: target.agent.id, fromVersion: rev.baseVersion, toVersion: promoted.version }, options.approvedByUserId)
    return { revisionId: rev.id, status: 'PROMOTED', agentId: target.agent.id }
  } catch (error) {
    return finishRevision(rev, 'FAILED', safeErrorMessage(error, 'Promotion failed'))
  }
}

/** Called when the approval for a risk-increasing revision is rejected or expires. */
export async function closeRevisionApproval(revisionId: string, outcome: 'REJECTED' | 'EXPIRED', reason?: string): Promise<void> {
  const rev = await prisma.agentRevision.findUnique({ where: { id: revisionId } })
  if (!rev || rev.status !== 'AWAITING_APPROVAL') return
  await finishRevision(rev, outcome, reason ?? (outcome === 'REJECTED' ? 'Rejected by a human approver' : 'Approval expired without a decision'))
}

/**
 * Reverts a promoted revision by applying the previous definition as a new
 * version (history is never rewritten). Refuses if the agent has changed
 * again since, because the "previous" definition would no longer be the one
 * this revision replaced.
 */
export async function rollbackRevision(
  revisionId: string,
  options: { reason: string; userId?: string; automatic?: boolean; now?: Date }
): Promise<RevisionOutcome> {
  const now = options.now ?? new Date()
  const claimed = await prisma.agentRevision.updateMany({ where: { id: revisionId, status: 'PROMOTED' }, data: { status: 'ROLLING_BACK' } })
  const rev = await prisma.agentRevision.findUnique({ where: { id: revisionId } })
  if (!rev) throw new RevisionError('Revision not found', 'NOT_FOUND')
  if (claimed.count !== 1) throw new RevisionError(`Revision is ${rev.status}; only PROMOTED revisions can be rolled back`, 'CONFLICT')
  const restore = async (message: string) => {
    await prisma.agentRevision.update({ where: { id: rev.id }, data: { status: 'PROMOTED' } })
    throw new RevisionError(message, 'CONFLICT')
  }

  const agent = rev.agentId ? await prisma.agent.findUnique({ where: { id: rev.agentId } }) : null
  if (!agent) return restore('Agent no longer exists')

  if (rev.changeType === 'retire') {
    const previous = ((rev.results ?? {}) as Record<string, unknown>).previousStatus
    await prisma.agent.update({ where: { id: agent.id }, data: { status: previous === 'PRODUCTION' || previous === 'EVALUATING' || previous === 'DRAFT' ? previous : 'DRAFT' } })
  } else if (rev.changeType === 'create') {
    await prisma.agent.update({ where: { id: agent.id }, data: { status: 'PAUSED' } })
  } else {
    if (agent.version !== rev.promotedVersion) return restore(`Agent has changed since this revision (now version ${agent.version}); roll back manually`)
    const previous = readSpec(rev.previousSpec)
    const restored = await prisma.$transaction(async (tx) => applySpec(tx, agent.id, previous, { incrementVersion: true }))
    await copyEvaluation(agent.id, rev.baseVersion, agent.id, restored.version, `restored by rollback of revision ${rev.id}`)
  }

  const rollback = { reason: redactString(options.reason, 1000), automatic: options.automatic === true, at: now.toISOString(), by: options.userId ?? null }
  await prisma.agentRevision.update({ where: { id: rev.id }, data: { status: 'ROLLED_BACK', watchUntil: null, results: mergeResults(rev, { rollback }) } })
  await audit(rev.tenantId, rev.id, 'AGENT_REVISION_ROLLED_BACK', { agentId: agent.id, ...rollback }, options.userId)
  return { revisionId: rev.id, status: 'ROLLED_BACK', agentId: agent.id }
}

// ---------------------------------------------------------------------------
// Post-promotion watch
// ---------------------------------------------------------------------------

export type WatchVerdict = { verdict: 'insufficient_data'; runs: number } | { verdict: 'healthy'; runs: number } | { verdict: 'degraded'; runs: number; reasons: string[] }

/** Pure: compares live metrics since promotion with the pre-promotion baseline (or absolute floors). */
export function judgeWatch(
  after: Pick<AgentRunMetrics, 'runs' | 'dodPassRate' | 'failureRate'>,
  baseline: Pick<AgentRunMetrics, 'runs' | 'dodPassRate' | 'failureRate'> | null,
  watch: SelfManagementPolicy['watch']
): WatchVerdict {
  if (after.runs < watch.minRuns) return { verdict: 'insufficient_data', runs: after.runs }
  const reasons: string[] = []
  const hasBaseline = baseline !== null && baseline.runs >= watch.minRuns
  const failure = after.failureRate ?? 0
  if (hasBaseline) {
    const baseFailure = baseline!.failureRate ?? 0
    if (failure - baseFailure > watch.maxFailureRateIncrease) reasons.push(`failure rate rose from ${baseFailure.toFixed(2)} to ${failure.toFixed(2)}`)
    if (after.dodPassRate !== null && baseline!.dodPassRate !== null && baseline!.dodPassRate - after.dodPassRate > watch.maxDodPassRateDrop) {
      reasons.push(`Definition-of-Done pass rate fell from ${baseline!.dodPassRate.toFixed(2)} to ${after.dodPassRate.toFixed(2)}`)
    }
  } else {
    if (failure > watch.maxFailureRate) reasons.push(`failure rate ${failure.toFixed(2)} is above ${watch.maxFailureRate}`)
    if (after.dodPassRate !== null && after.dodPassRate < watch.minDodPassRate) reasons.push(`Definition-of-Done pass rate ${after.dodPassRate.toFixed(2)} is below ${watch.minDodPassRate}`)
  }
  return reasons.length ? { verdict: 'degraded', runs: after.runs, reasons } : { verdict: 'healthy', runs: after.runs }
}

/** Scheduler tick: roll back degraded promotions; close the watch window on healthy ones. */
export async function watchPromotedRevisions(now = new Date()): Promise<Array<{ revisionId: string; verdict: WatchVerdict['verdict'] | 'rolled_back' | 'watch_completed' }>> {
  const revisions = await prisma.agentRevision.findMany({
    where: { status: 'PROMOTED', watchUntil: { not: null }, changeType: { in: ['create', 'update'] }, agentId: { not: null } },
    take: 200,
  })
  const outcomes: Array<{ revisionId: string; verdict: WatchVerdict['verdict'] | 'rolled_back' | 'watch_completed' }> = []
  for (const rev of revisions) {
    try {
      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: rev.tenantId }, select: { settings: true } })
      const { policy } = readSelfManagementPolicy(tenant.settings)
      const after = await getAgentRunMetrics({ tenantId: rev.tenantId, agentId: rev.agentId!, since: rev.promotedAt ?? rev.updatedAt })
      const verdict = judgeWatch(after, (rev.baselineMetrics as unknown as AgentRunMetrics | null) ?? null, policy.watch)
      if (verdict.verdict === 'degraded') {
        try {
          await rollbackRevision(rev.id, { reason: `Automatic rollback: ${verdict.reasons.join('; ')}`, automatic: true, now })
          outcomes.push({ revisionId: rev.id, verdict: 'rolled_back' })
        } catch (error) {
          // The agent changed again since; stop watching and leave a trail for a human.
          await prisma.agentRevision.update({ where: { id: rev.id }, data: { watchUntil: null, results: mergeResults(rev, { watch: { degraded: verdict.reasons, rollbackFailed: safeErrorMessage(error) } }) } })
          await audit(rev.tenantId, rev.id, 'AGENT_REVISION_ROLLBACK_FAILED', { reasons: verdict.reasons, error: safeErrorMessage(error) })
          outcomes.push({ revisionId: rev.id, verdict: 'degraded' })
        }
        continue
      }
      if (rev.watchUntil && now >= rev.watchUntil) {
        await prisma.agentRevision.update({ where: { id: rev.id }, data: { watchUntil: null, results: mergeResults(rev, { watch: { verdict: verdict.verdict, runs: verdict.runs, completedAt: now.toISOString() } }) } })
        outcomes.push({ revisionId: rev.id, verdict: 'watch_completed' })
        continue
      }
      outcomes.push({ revisionId: rev.id, verdict: verdict.verdict })
    } catch (error) {
      console.error(`Revision watch failed for ${rev.id}:`, safeErrorMessage(error))
    }
  }
  return outcomes
}

/** Scheduler tick: PROPOSED revisions waiting to be processed (the queue worker processes them). */
export async function findPendingRevisionIds(limit = 50): Promise<string[]> {
  const rows = await prisma.agentRevision.findMany({ where: { status: 'PROPOSED' }, orderBy: { createdAt: 'asc' }, take: limit, select: { id: true } })
  return rows.map((r) => r.id)
}
