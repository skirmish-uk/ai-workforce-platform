import { z } from 'zod'
import type { Agent, Skill } from '@prisma/client'
import { AUTONOMY_STAGES, type AutonomyStage, toolRegistry } from '@ai-workforce/tools'
import { DOD_CHECK_SCHEMA } from './dod'

/**
 * The agent contract (brief §3/§4) lives in the existing `Agent.config` JSON
 * column under `contract`, so no competing configuration system or migration is
 * needed. Mapping to the brief's three conceptual files:
 *
 * - IDENTITY.md → Agent.name/role/mission/systemPrompt + contract.scope,
 *   definitionOfDone, inputs/outputs, allowedTools, autonomyStage, owner,
 *   escalation — enforced by packages/tools policy, not just described.
 * - SOUL.md     → contract.soul (tone, values, uncertainty, when to ask/escalate).
 * - USER.md     → Tenant.settings.businessContext (see ./business-context.ts),
 *   shared by every agent in the tenant instead of being copied per agent.
 */

const modelRefSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'ollama']),
  model: z.string().min(1),
})
export type ModelRef = z.infer<typeof modelRefSchema>

export const MODEL_TIERS = ['simple', 'standard', 'complex'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

export const agentContractSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    /** One sentence: why this agent exists / the business outcome it owns. */
    rationale: z.string().min(10),
    definitionOfDone: z.object({
      /** One-sentence, observable Definition of Done. */
      summary: z.string().min(10),
      /** Deterministic checks evaluated in the Assess phase of every run. */
      checks: z.array(DOD_CHECK_SCHEMA).default([]),
    }),
    inputs: z
      .object({
        description: z.string().optional(),
        /** When the run input is a JSON object, these keys must be present or the run stops with needs_clarification. */
        requiredFields: z.array(z.string().min(1)).default([]),
        maxLength: z.number().int().positive().max(200_000).default(20_000),
      })
      .default({}),
    outputs: z
      .object({
        description: z.string().optional(),
        format: z.enum(['text', 'json']).default('text'),
        requiredFields: z.array(z.string().min(1)).default([]),
      })
      .default({}),
    scope: z.object({
      inScope: z.array(z.string().min(1)).min(1),
      outOfScope: z.array(z.string().min(1)).min(1),
    }),
    /** Explicit tool allowlist. Omit to allow every tool required by the agent's enabled skills. */
    allowedTools: z.array(z.string().min(1)).optional(),
    soul: z
      .object({
        tone: z.string(),
        values: z.array(z.string()),
        uncertainty: z.string(),
        askWhen: z.string(),
        escalateWhen: z.string(),
      })
      .partial()
      .default({}),
    autonomyStage: z.enum(AUTONOMY_STAGES).default('approval_gated'),
    risk: z.object({
      classification: z.enum(['low', 'medium', 'high']),
      notes: z.string().optional(),
    }),
    owner: z.object({ name: z.string().min(1), contact: z.string().min(1) }),
    escalation: z.object({
      destination: z.string().min(1),
      triggers: z.array(z.string()).default([]),
    }),
    model: z
      .object({
        /** Ordered fallbacks used only when the primary provider is unavailable (never on quality failures). */
        fallbacks: z.array(modelRefSchema).default([]),
        /** local_only: never send data to a cloud provider, including via fallback. */
        privacy: z.enum(['any', 'local_only']).default('any'),
        /** Optional per-task-tier routing; a run may request a tier (e.g. workflow step / schedule payload). */
        tiers: z.object({ simple: modelRefSchema, standard: modelRefSchema, complex: modelRefSchema }).partial().optional(),
      })
      .default({}),
    limits: z
      .object({
        maxIterations: z.number().int().min(1).max(50).default(8),
        maxToolCalls: z.number().int().min(0).max(200).default(20),
        maxWallClockMs: z.number().int().min(1_000).max(3_600_000).default(120_000),
        /** Per-run LLM spend ceiling, in addition to the tenant's daily/monthly cap. */
        maxRunCostUsd: z.number().positive().optional(),
        /** Transient LLM/provider error retries (exponential backoff) per model candidate. */
        maxRetries: z.number().int().min(0).max(5).default(2),
        toolTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
      })
      .default({}),
    memory: z
      .object({
        /**
         * Only "none" is implemented: nothing is persisted across runs except the
         * audit trail. Any other value is rejected so nobody believes memory is on.
         */
        mode: z.literal('none').default('none'),
      })
      .default({}),
    delegation: z
      .object({
        enabled: z.boolean().default(false),
        allowedSpecialists: z.array(z.string().min(1)).default([]),
        maxDepth: z.number().int().min(1).max(3).default(2),
        maxChildren: z.number().int().min(1).max(10).default(3),
      })
      .default({}),
    /**
     * Workforce Manager capability (docs/WORKFORCE_MANAGER.md): the agent may inspect the
     * tenant's other agents and propose revisions to them. Only a human can set this — the
     * revision pipeline rejects any proposal that grants it or that targets a manager.
     */
    management: z
      .object({
        enabled: z.boolean().default(false),
        /** Upper bound on platform__propose_agent_change calls in one run. */
        maxProposalsPerRun: z.number().int().min(1).max(5).default(3),
      })
      .default({}),
    schedule: z
      .object({
        /** skip: a fire time missed while workers were down is dropped. run_once: dispatch one catch-up run. */
        missedRunPolicy: z.enum(['skip', 'run_once']).default('skip'),
        maxConcurrentRuns: z.number().int().min(1).max(5).default(1),
      })
      .default({}),
    approvals: z
      .object({
        ttlHours: z.number().positive().max(720).default(72),
      })
      .default({}),
    evaluation: z
      .object({
        /** Fraction of assertable eval cases that must pass before limited/expanded autonomy takes effect. */
        minPassRate: z.number().min(0).max(1).default(1),
      })
      .default({}),
    context: z
      .object({
        maxKnowledgeExcerpts: z.number().int().min(0).max(20).default(5),
        /** Knowledge documents older than this are flagged as stale in the prompt and the run trace. */
        staleAfterDays: z.number().int().positive().optional(),
      })
      .default({}),
    /** Brief §2 "R rule" assessment, recorded for the deploy decision. */
    taskAssessment: z
      .object({
        frequency: z.string(),
        manualEffortMinutes: z.number().nonnegative(),
        expectedSavings: z.string(),
        riskLevel: z.enum(['low', 'medium', 'high']),
        implementationEstimate: z.string(),
        operatingCost: z.string(),
        successMetric: z.string(),
      })
      .partial()
      .optional(),
  })
  .strict()

export type AgentContract = z.infer<typeof agentContractSchema>

export interface ResolvedContract {
  contract: AgentContract
  /** 'config' = validated from Agent.config.contract; 'legacy_default' = agent predates contracts. */
  source: 'config' | 'legacy_default'
  errors: string[]
}

/**
 * Conservative defaults for agents created before contracts existed: they can
 * still be run ad hoc (so existing drafts keep working), but every external
 * write is approval-gated and they cannot be deployed until a contract is added.
 */
export function legacyDefaultContract(agent: Pick<Agent, 'mission'>): AgentContract {
  return agentContractSchema.parse({
    rationale: agent.mission?.length >= 10 ? agent.mission : 'Legacy agent without a recorded rationale.',
    definitionOfDone: { summary: 'Return a non-empty final answer for the request.', checks: [] },
    scope: { inScope: ['Unspecified (legacy agent)'], outOfScope: ['Unspecified (legacy agent)'] },
    autonomyStage: 'approval_gated',
    risk: { classification: 'high', notes: 'No contract recorded; treated as high risk.' },
    owner: { name: 'unassigned', contact: 'unassigned' },
    escalation: { destination: 'tenant administrators' },
  })
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `contract.${issue.path.join('.') || '(root)'}: ${issue.message}`)
}

export function readContractConfig(config: unknown): unknown {
  if (!config || typeof config !== 'object') return undefined
  return (config as Record<string, unknown>).contract
}

/** Parses Agent.config.contract. Never throws: invalid contracts are reported in `errors`. */
export function resolveAgentContract(agent: Pick<Agent, 'config' | 'mission'>): ResolvedContract {
  const raw = readContractConfig(agent.config)
  if (raw === undefined || raw === null) {
    return { contract: legacyDefaultContract(agent), source: 'legacy_default', errors: [] }
  }
  const parsed = agentContractSchema.safeParse(raw)
  if (!parsed.success) {
    return { contract: legacyDefaultContract(agent), source: 'config', errors: formatZodIssues(parsed.error) }
  }
  return { contract: parsed.data, source: 'config', errors: [] }
}

export interface DefinitionValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
  contract: AgentContract
  source: ResolvedContract['source']
}

const SEMVER = /^\d+\.\d+\.\d+$/

/**
 * Cross-field validation of an agent definition. `forDeployment` turns the
 * checks a draft may skip (no contract, playbooks without owners/eval cases,
 * unresolvable tools) into hard errors.
 */
export function validateAgentDefinition(
  agent: Pick<Agent, 'config' | 'mission' | 'systemPrompt' | 'modelProvider' | 'modelName'>,
  skills: Array<Pick<Skill, 'name' | 'version' | 'requiredTools' | 'evaluationCases' | 'metadata'>>,
  options: { forDeployment?: boolean } = {}
): DefinitionValidation {
  const strict = options.forDeployment === true
  const resolved = resolveAgentContract(agent)
  const errors = [...resolved.errors]
  const warnings: string[] = []
  const contract = resolved.contract
  const push = (message: string, hard: boolean) => (hard ? errors.push(message) : warnings.push(message))

  if (resolved.source === 'legacy_default') {
    push('Agent has no contract (Agent.config.contract); running with conservative approval-gated defaults.', strict)
  }
  if (!agent.systemPrompt?.trim()) push('Agent has no system prompt.', strict)

  const knownTools = new Set(toolRegistry.all().map((t) => t.toolName))
  const skillTools = new Set(toolRegistry.resolve(skills.flatMap((s) => s.requiredTools)).map((t) => t.toolName))

  for (const tool of contract.allowedTools ?? []) {
    if (!knownTools.has(tool)) errors.push(`contract.allowedTools: "${tool}" is not a registered tool.`)
    else if (!skillTools.has(tool)) warnings.push(`contract.allowedTools: "${tool}" is allowed but no enabled skill requires it.`)
  }

  for (const check of contract.definitionOfDone.checks) {
    if (check.type === 'tool_succeeded') {
      if (!knownTools.has(check.tool)) errors.push(`definitionOfDone: tool_succeeded references unknown tool "${check.tool}".`)
      else if (contract.allowedTools && !contract.allowedTools.includes(check.tool)) {
        errors.push(`definitionOfDone: tool_succeeded requires "${check.tool}", which contract.allowedTools forbids.`)
      }
    }
  }

  if (contract.delegation.enabled && contract.delegation.allowedSpecialists.length === 0) {
    errors.push('contract.delegation is enabled but allowedSpecialists is empty.')
  }
  if (contract.delegation.allowedSpecialists.includes('*') && !contract.management.enabled) {
    errors.push('contract.delegation.allowedSpecialists "*" (the whole team) is only allowed for a manager agent.')
  }

  if (contract.model.privacy === 'local_only') {
    const refs: ModelRef[] = [
      { provider: agent.modelProvider as ModelRef['provider'], model: agent.modelName },
      ...contract.model.fallbacks,
      ...Object.values(contract.model.tiers ?? {}),
    ]
    for (const ref of refs) {
      if (ref.provider.toLowerCase() !== 'ollama') {
        errors.push(`contract.model.privacy is local_only but "${ref.provider}/${ref.model}" is a cloud provider.`)
      }
    }
  }

  for (const skill of skills) {
    if (!SEMVER.test(skill.version)) push(`Skill "${skill.name}" version "${skill.version}" is not semver.`, strict)
    const cases = Array.isArray(skill.evaluationCases) ? skill.evaluationCases : []
    if (cases.length === 0) push(`Skill "${skill.name}" has no evaluation cases.`, strict)
    const metadata = (skill.metadata ?? {}) as Record<string, unknown>
    if (typeof metadata.owner !== 'string' || !metadata.owner) push(`Skill "${skill.name}" playbook has no owner (metadata.owner).`, strict)
    if (typeof metadata.lastReviewedAt !== 'string') warnings.push(`Skill "${skill.name}" playbook has no metadata.lastReviewedAt.`)
    const unresolved = skill.requiredTools.filter((name) => toolRegistry.resolve([name]).length === 0)
    if (unresolved.length) push(`Skill "${skill.name}" requires unregistered tools: ${unresolved.join(', ')}.`, strict)
  }

  return { ok: errors.length === 0, errors, warnings, contract, source: resolved.source }
}

export function isAutonomyAbove(stage: AutonomyStage, ceiling: AutonomyStage): boolean {
  return AUTONOMY_STAGES.indexOf(stage) > AUTONOMY_STAGES.indexOf(ceiling)
}
