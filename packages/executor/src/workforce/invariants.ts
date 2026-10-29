import type { ApprovalLevel } from '@prisma/client'
import { defaultPermissionLevel, getToolRiskProfile, isHighRisk, stageRank, toolRegistry } from '@ai-workforce/tools'
import { agentContractSchema, type AgentContract } from '../contract'
import { canonicalJson } from '../safety'
import type { SelfManagementPolicy } from './policy'
import { suiteOf, type AgentSpec, type SkillInfo } from './spec'

/**
 * The hard limits of self-management, enforced in code on every proposal and
 * again just before evaluation. Pure (no I/O) so every rule is unit-tested.
 *
 * - violations: the proposal is refused outright, whoever approves it.
 * - riskIncreases: allowed only after a human approves it (tests alone are not enough).
 *
 * Everything else (prompt, playbook, knowledge, scope wording, read/draft tools)
 * goes live automatically once it passes evaluation.
 */
export interface InvariantInput {
  changeType: 'create' | 'update' | 'retire'
  /** null for create. */
  current: { spec: AgentSpec; skills: SkillInfo[]; status: string } | null
  /** null for retire. */
  candidate: { spec: AgentSpec; skills: SkillInfo[] } | null
  policy: SelfManagementPolicy
  /** Adapter names with an active Integration in this tenant (Integration.name). */
  enabledAdapters: ReadonlySet<string>
  /** Tool kill switch (tenant + platform). */
  disabledTools: readonly string[]
  /** Non-candidate agents in the tenant (delegation targets must be among them). */
  tenantAgentIds: ReadonlySet<string>
}

export interface InvariantResult {
  violations: string[]
  riskIncreases: string[]
  /** The candidate's effective tools (playbook tools ∩ allowlist). */
  tools: string[]
  contract?: AgentContract
}

const LEVEL_ORDER: ApprovalLevel[] = ['AUTOMATIC', 'NOTIFY', 'CUSTOMER_APPROVAL', 'OPERATOR_APPROVAL', 'PROHIBITED']

export function parseSpecContract(spec: AgentSpec): { contract?: AgentContract; errors: string[] } {
  const parsed = agentContractSchema.safeParse(spec.contract)
  if (parsed.success) return { contract: parsed.data, errors: [] }
  return { errors: parsed.error.issues.map((i) => `contract.${i.path.join('.') || '(root)'}: ${i.message}`) }
}

export function isManagerSpec(spec: Pick<AgentSpec, 'contract'>): boolean {
  const management = (spec.contract as { management?: { enabled?: unknown } }).management
  return management?.enabled === true
}

/** Playbook tools ∩ contract allowlist — what the agent could ever be offered. */
export function effectiveTools(skills: SkillInfo[], contract: Pick<AgentContract, 'allowedTools'> | undefined): string[] {
  const fromSkills = toolRegistry.resolve(skills.flatMap((s) => s.requiredTools)).map((t) => t.toolName)
  const allow = contract?.allowedTools
  return Array.from(new Set(allow ? fromSkills.filter((t) => allow.includes(t)) : fromSkills)).sort()
}

function permissionLevel(spec: AgentSpec, tool: string): ApprovalLevel {
  // Same default as runtime when no AgentPermission row exists (packages/tools/permissions.ts).
  return spec.permissions.find((p) => p.action === tool)?.level ?? defaultPermissionLevel(tool)
}

export function checkRevisionInvariants(input: InvariantInput): InvariantResult {
  const violations: string[] = []
  const riskIncreases: string[] = []
  const { current, candidate, policy } = input

  if (current && isManagerSpec(current.spec)) {
    violations.push('Manager agents cannot be changed by the revision pipeline (a manager cannot modify itself or another manager).')
  }

  if (input.changeType === 'retire') {
    if (!current) violations.push('Retire needs an existing agent.')
    else if (current.status === 'PRODUCTION') riskIncreases.push('Retiring an agent that is in production stops work the business relies on.')
    return { violations, riskIncreases, tools: [] }
  }

  if (!candidate) return { violations: [...violations, 'No candidate definition.'], riskIncreases, tools: [] }

  if (isManagerSpec(candidate.spec)) {
    violations.push('Management capability (contract.management) can only be granted by a direct human edit of the agent, never through a revision.')
  }

  const { contract, errors } = parseSpecContract(candidate.spec)
  violations.push(...errors)
  if (!contract) return { violations, riskIncreases, tools: [] }

  // ---- autonomy ceiling
  if (stageRank(contract.autonomyStage) > stageRank(policy.maxAutonomyStage)) {
    violations.push(`Autonomy stage "${contract.autonomyStage}" is above this tenant's self-management ceiling "${policy.maxAutonomyStage}".`)
  }

  // ---- tools: registered, enabled for the tenant, not kill-switched
  const requested = Array.from(new Set([...candidate.skills.flatMap((s) => s.requiredTools), ...(contract.allowedTools ?? [])]))
  for (const name of requested) {
    const resolved = toolRegistry.resolve([name])
    if (!resolved.length) {
      violations.push(`Tool "${name}" is not a registered platform tool (new capabilities need a reviewed integration, not a revision).`)
      continue
    }
    for (const registered of resolved) {
      if (!input.enabledAdapters.has(registered.adapter.name)) {
        violations.push(`Tool "${registered.toolName}" needs the "${registered.adapter.name}" integration, which this tenant has not connected.`)
      }
      if (input.disabledTools.includes(registered.toolName)) {
        violations.push(`Tool "${registered.toolName}" is disabled by a kill switch.`)
      }
    }
  }
  for (const p of candidate.spec.permissions) {
    if (!toolRegistry.has(p.action)) violations.push(`Permission for unknown tool "${p.action}".`)
  }

  // ---- delegation stays inside the tenant
  for (const id of contract.delegation.allowedSpecialists) {
    if (!input.tenantAgentIds.has(id)) violations.push(`Delegation target "${id}" is not an agent in this tenant.`)
  }
  for (const id of contract.handoffs.allowedAgents) {
    if (id !== '*' && !input.tenantAgentIds.has(id)) violations.push(`Hand-off target "${id}" is not an agent in this tenant.`)
  }

  // ---- test cases are append-only
  if (current) {
    const have = new Set(suiteOf(candidate.spec, candidate.skills).map(canonicalJson))
    const dropped = suiteOf(current.spec, current.skills).filter((c) => !have.has(canonicalJson(c)))
    if (dropped.length) violations.push(`${dropped.length} existing evaluation case(s) would be removed; cases can only be added.`)
  }

  const tools = effectiveTools(candidate.skills, contract)

  // ---- risk increases: need a human approval on top of passing tests
  if (!current) {
    const risky = tools.filter((t) => isHighRisk(getToolRiskProfile(t).risk))
    if (risky.length) riskIncreases.push(`New agent with high-risk tools: ${risky.join(', ')}.`)
    if (stageRank(contract.autonomyStage) > stageRank('approval_gated')) riskIncreases.push(`New agent starts above approval_gated ("${contract.autonomyStage}").`)
    if (contract.delegation.enabled) riskIncreases.push('New agent can delegate to other agents.')
    if (contract.handoffs.enabled) riskIncreases.push('New agent can hand work to other agents.')
    return { violations, riskIncreases, tools, contract }
  }

  const before = parseSpecContract(current.spec).contract
  const beforeTools = new Set(effectiveTools(current.skills, before))

  if (before && stageRank(contract.autonomyStage) > stageRank(before.autonomyStage)) {
    riskIncreases.push(`Autonomy raised from "${before.autonomyStage}" to "${contract.autonomyStage}".`)
  }
  const addedRisky = tools.filter((t) => !beforeTools.has(t) && isHighRisk(getToolRiskProfile(t).risk))
  if (addedRisky.length) riskIncreases.push(`Adds high-risk tools: ${addedRisky.join(', ')}.`)

  for (const tool of tools) {
    if (getToolRiskProfile(tool).risk === 'read') continue
    const was = permissionLevel(current.spec, tool)
    const now = permissionLevel(candidate.spec, tool)
    if (beforeTools.has(tool) && LEVEL_ORDER.indexOf(now) < LEVEL_ORDER.indexOf(was)) {
      riskIncreases.push(`Loosens permission for ${tool} from ${was} to ${now}.`)
    }
  }

  if (before) {
    if (contract.delegation.enabled && !before.delegation.enabled) riskIncreases.push('Enables delegation.')
    const newSpecialists = contract.delegation.allowedSpecialists.filter((id) => !before.delegation.allowedSpecialists.includes(id))
    if (before.delegation.enabled && newSpecialists.length) riskIncreases.push(`Adds delegation targets: ${newSpecialists.join(', ')}.`)
    if (contract.handoffs.enabled && !before.handoffs.enabled) riskIncreases.push('Enables hand-offs to other agents.')
    const newTargets = contract.handoffs.allowedAgents.filter((id) => !before.handoffs.allowedAgents.includes(id))
    if (before.handoffs.enabled && newTargets.length) riskIncreases.push(`Adds hand-off targets: ${newTargets.join(', ')}.`)
    if (contract.memory.mode === 'tenant' && contract.memory.write && !(before.memory.mode === 'tenant' && before.memory.write)) riskIncreases.push('Lets the agent save memories the whole team uses.')
    if (before.model.privacy === 'local_only' && contract.model.privacy !== 'local_only') riskIncreases.push('Allows data to leave local models (privacy local_only removed).')
    const beforeCap = before.limits.maxRunCostUsd ?? Infinity
    const afterCap = contract.limits.maxRunCostUsd ?? Infinity
    if (afterCap > beforeCap) riskIncreases.push(`Raises the per-run cost limit from ${beforeCap} to ${afterCap === Infinity ? 'unlimited' : afterCap}.`)
    if (canonicalJson(before.owner) !== canonicalJson(contract.owner) || canonicalJson(before.escalation) !== canonicalJson(contract.escalation)) {
      riskIncreases.push('Changes who owns the agent or where it escalates.')
    }
    const removedOut = before.scope.outOfScope.filter((item) => !contract.scope.outOfScope.includes(item))
    if (removedOut.length) riskIncreases.push(`Removes out-of-scope boundaries: ${removedOut.join('; ')}.`)
  }
  if (current.spec.modelProvider !== candidate.spec.modelProvider) {
    riskIncreases.push(`Moves the agent's data to a different model provider (${current.spec.modelProvider} → ${candidate.spec.modelProvider}).`)
  }

  return { violations, riskIncreases, tools, contract }
}
