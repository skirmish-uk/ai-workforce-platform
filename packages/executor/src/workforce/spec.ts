import { z } from 'zod'
import { ApprovalLevel, type Agent, type AgentPermission, type Prisma, type Skill } from '@prisma/client'
import { prisma } from '@ai-workforce/db'
import { canonicalJson } from '../safety'

/**
 * An AgentSpec is the complete, declarative definition of one agent: identity,
 * prompt, model, contract, playbooks (skills), per-tool permissions and its own
 * evaluation cases. Revisions propose a whole spec (not a diff), so a promotion
 * and a rollback are the same operation: apply a spec.
 *
 * Self-building is deliberately config-only: a spec can combine registered
 * tools and write new playbooks, but it cannot contain code.
 */

const SEMVER = /^\d+\.\d+\.\d+$/

export const newSkillSchema = z
  .object({
    name: z.string().min(1).max(100),
    version: z.string().regex(SEMVER, 'must be semver, e.g. 1.0.0'),
    description: z.string().min(1).max(2000),
    purpose: z.string().min(1).max(2000),
    instructions: z.string().min(1).max(20_000),
    requiredTools: z.array(z.string().min(1)).max(20).default([]),
    constraints: z.array(z.string().min(1)).max(50).default([]),
    /** At least one case is required for the candidate to be deployable (validateAgentDefinition). */
    evaluationCases: z.array(z.unknown()).max(100).default([]),
  })
  .strict()
export type NewSkill = z.infer<typeof newSkillSchema>

export const skillRefSchema = z.union([
  z.object({ skillId: z.string().min(1) }).strict(),
  z.object({ create: newSkillSchema }).strict(),
])
export type SkillRef = z.infer<typeof skillRefSchema>

const permissionSchema = z.object({ action: z.string().min(1), level: z.nativeEnum(ApprovalLevel) }).strict()

export const agentSpecSchema = z
  .object({
    name: z.string().min(1).max(100),
    role: z.string().min(1).max(200),
    mission: z.string().min(10).max(5000),
    systemPrompt: z.string().min(1).max(50_000),
    modelProvider: z.string().min(1),
    modelName: z.string().min(1),
    modelConfig: z.record(z.unknown()).default({}),
    /** Validated with agentContractSchema by the invariant check, so errors are reported per field. */
    contract: z.record(z.unknown()),
    skills: z.array(skillRefSchema).max(20).default([]),
    permissions: z.array(permissionSchema).max(100).default([]),
    /** Agent-level evaluation cases (Agent.config.evaluationCases), in addition to each skill's. */
    evaluationCases: z.array(z.unknown()).max(200).default([]),
  })
  .strict()
export type AgentSpec = z.infer<typeof agentSpecSchema>

/** What a proposer may send. Evaluation cases can only be added (addEvaluationCases), never removed. */
export const agentChangesSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    role: z.string().min(1).max(200).optional(),
    mission: z.string().min(10).max(5000).optional(),
    systemPrompt: z.string().min(1).max(50_000).optional(),
    modelProvider: z.enum(['anthropic', 'openai', 'ollama']).optional(),
    modelName: z.string().min(1).optional(),
    /** Top-level contract keys to replace (e.g. { soul: {...}, scope: {...} }). */
    contract: z.record(z.unknown()).optional(),
    /** Replaces the agent's playbook list. Reference existing skills by id or write new ones. */
    skills: z.array(skillRefSchema).max(20).optional(),
    /** Sets the level for each listed tool; unlisted tools keep their current level. */
    permissions: z.array(permissionSchema).max(100).optional(),
  })
  .strict()
export type AgentChanges = z.infer<typeof agentChangesSchema>

export class SpecError extends Error {
  constructor(message: string, public readonly issues: string[] = [message]) {
    super(message)
    this.name = 'SpecError'
  }
}

function zodIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${prefix}${i.path.length ? '.' + i.path.join('.') : ''}: ${i.message}`)
}

export function readAgentEvaluationCases(config: unknown): unknown[] {
  if (!config || typeof config !== 'object') return []
  const cases = (config as Record<string, unknown>).evaluationCases
  return Array.isArray(cases) ? cases : []
}

export function specFromAgent(
  agent: Pick<Agent, 'name' | 'role' | 'mission' | 'systemPrompt' | 'modelProvider' | 'modelName' | 'modelConfig' | 'config'>,
  skillIds: string[],
  permissions: Array<Pick<AgentPermission, 'action' | 'level'>>
): AgentSpec {
  const config = (agent.config && typeof agent.config === 'object' ? agent.config : {}) as Record<string, unknown>
  return {
    name: agent.name,
    role: agent.role,
    mission: agent.mission,
    systemPrompt: agent.systemPrompt,
    modelProvider: agent.modelProvider,
    modelName: agent.modelName,
    modelConfig: (agent.modelConfig && typeof agent.modelConfig === 'object' ? agent.modelConfig : {}) as Record<string, unknown>,
    contract: (config.contract && typeof config.contract === 'object' ? config.contract : {}) as Record<string, unknown>,
    skills: skillIds.map((skillId) => ({ skillId })),
    permissions: permissions.map((p) => ({ action: p.action, level: p.level })),
    evaluationCases: readAgentEvaluationCases(agent.config),
  }
}

export async function readAgentSpec(agentId: string): Promise<{ agent: Agent; spec: AgentSpec }> {
  const agent = await prisma.agent.findUniqueOrThrow({
    where: { id: agentId },
    include: { skills: { where: { enabled: true } }, permissions: true },
  })
  return { agent, spec: specFromAgent(agent, agent.skills.map((s) => s.skillId), agent.permissions) }
}

function dedupeCases(cases: unknown[]): unknown[] {
  const seen = new Set<string>()
  return cases.filter((c) => {
    const key = canonicalJson(c)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Builds the candidate spec: base (null for a new agent) + changes + appended
 * evaluation cases. Throws SpecError with per-field issues.
 */
export function mergeSpec(
  base: AgentSpec | null,
  changes: AgentChanges,
  addEvaluationCases: unknown[],
  defaults: { modelProvider: string; modelName: string }
): AgentSpec {
  if (!base) {
    const missing = (['name', 'role', 'mission', 'systemPrompt', 'contract'] as const).filter((k) => changes[k] === undefined)
    if (missing.length) throw new SpecError(`A new agent needs: ${missing.join(', ')}`)
  }
  const start: AgentSpec = base ?? {
    name: '',
    role: '',
    mission: '',
    systemPrompt: '',
    modelProvider: defaults.modelProvider,
    modelName: defaults.modelName,
    modelConfig: {},
    contract: {},
    skills: [],
    permissions: [],
    evaluationCases: [],
  }

  const permissions = new Map(start.permissions.map((p) => [p.action, p.level]))
  for (const p of changes.permissions ?? []) permissions.set(p.action, p.level)

  const candidate = {
    ...start,
    ...(changes.name !== undefined ? { name: changes.name } : {}),
    ...(changes.role !== undefined ? { role: changes.role } : {}),
    ...(changes.mission !== undefined ? { mission: changes.mission } : {}),
    ...(changes.systemPrompt !== undefined ? { systemPrompt: changes.systemPrompt } : {}),
    ...(changes.modelProvider !== undefined ? { modelProvider: changes.modelProvider } : {}),
    ...(changes.modelName !== undefined ? { modelName: changes.modelName } : {}),
    contract: { ...start.contract, ...(changes.contract ?? {}) },
    skills: changes.skills ?? start.skills,
    permissions: Array.from(permissions, ([action, level]) => ({ action, level })),
    evaluationCases: dedupeCases([...start.evaluationCases, ...addEvaluationCases]),
  }
  const parsed = agentSpecSchema.safeParse(candidate)
  if (!parsed.success) throw new SpecError('Invalid agent definition', zodIssues('spec', parsed.error))
  return parsed.data
}

/** What the invariant check and evaluation need to know about each playbook in a spec. */
export interface SkillInfo {
  id?: string
  name: string
  version: string
  requiredTools: string[]
  evaluationCases: unknown[]
}

/** Resolves a spec's skill refs. Referenced skills must be active and belong to the tenant (or be global). */
export async function loadSkillInfos(tenantId: string, refs: SkillRef[]): Promise<{ skills: SkillInfo[]; errors: string[] }> {
  const ids = refs.flatMap((r) => ('skillId' in r ? [r.skillId] : []))
  const rows = ids.length
    ? await prisma.skill.findMany({ where: { id: { in: ids }, isActive: true, OR: [{ tenantId }, { tenantId: null }] } })
    : []
  const byId = new Map(rows.map((r) => [r.id, r]))
  const errors: string[] = []
  const skills: SkillInfo[] = []
  for (const ref of refs) {
    if ('skillId' in ref) {
      const row = byId.get(ref.skillId)
      if (!row) {
        errors.push(`skill ${ref.skillId} does not exist, is inactive, or belongs to another tenant`)
        continue
      }
      skills.push(skillInfoFromRow(row))
    } else {
      skills.push({ name: ref.create.name, version: ref.create.version, requiredTools: ref.create.requiredTools, evaluationCases: ref.create.evaluationCases })
    }
  }
  return { skills, errors }
}

const versionParts = (v: string) => v.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0)
function newerVersion(a: string, b: string): boolean {
  const [x, y] = [versionParts(a), versionParts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

/**
 * One version of each playbook: a new version replaces the older one of the same name. A
 * revision that added Ava's playbook 1.1.0 but also kept 1.0.0 gave her both sets of
 * instructions, listed twice on her page (26 Oct). `skills` lines up with `spec.skills`.
 */
export function newestPlaybooks<S extends Pick<AgentSpec, 'skills'>>(spec: S, skills: SkillInfo[]): { spec: S; skills: SkillInfo[]; replaced: string[] } {
  const best = new Map<string, number>()
  skills.forEach((s, i) => {
    const at = best.get(s.name)
    if (at === undefined || newerVersion(s.version, skills[at].version)) best.set(s.name, i)
  })
  const keep = skills.map((s, i) => best.get(s.name) === i)
  return {
    spec: { ...spec, skills: spec.skills.filter((_, i) => keep[i]) },
    skills: skills.filter((_, i) => keep[i]),
    replaced: skills.filter((_, i) => !keep[i]).map((s) => `${s.name} ${s.version}`),
  }
}

export function skillInfoFromRow(row: Pick<Skill, 'id' | 'name' | 'version' | 'requiredTools' | 'evaluationCases'>): SkillInfo {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    requiredTools: row.requiredTools,
    evaluationCases: Array.isArray(row.evaluationCases) ? (row.evaluationCases as unknown[]) : [],
  }
}

/** The full evaluation suite of a spec: its own cases plus every playbook's. */
export function suiteOf(spec: Pick<AgentSpec, 'evaluationCases'>, skills: SkillInfo[]): unknown[] {
  return dedupeCases([...spec.evaluationCases, ...skills.flatMap((s) => s.evaluationCases)])
}

/**
 * Test cases are append-only. Any current case missing from the candidate's
 * suite (e.g. its playbook was dropped or replaced) is carried into the
 * candidate's own cases, so removing a capability that tests still demand
 * makes the candidate fail evaluation instead of silently losing coverage.
 */
export function carryOverCases(candidate: AgentSpec, candidateSkills: SkillInfo[], currentSuite: unknown[]): AgentSpec {
  const have = new Set(suiteOf(candidate, candidateSkills).map(canonicalJson))
  const missing = currentSuite.filter((c) => !have.has(canonicalJson(c)))
  return missing.length ? { ...candidate, evaluationCases: [...candidate.evaluationCases, ...missing] } : candidate
}

/**
 * Creates the Skill rows for `create` refs and returns a spec that only
 * references skill ids. New playbooks are owned by the proposing manager.
 */
export async function materializeSkills(
  tx: Prisma.TransactionClient,
  tenantId: string,
  spec: AgentSpec,
  meta: { revisionId: string; owner: string }
): Promise<{ spec: AgentSpec; createdSkillIds: string[] }> {
  const createdSkillIds: string[] = []
  const skills: SkillRef[] = []
  for (const ref of spec.skills) {
    if ('skillId' in ref) {
      skills.push(ref)
      continue
    }
    const exists = await tx.skill.findFirst({ where: { tenantId, name: ref.create.name, version: ref.create.version }, select: { id: true } })
    if (exists) throw new SpecError(`Skill "${ref.create.name}" version ${ref.create.version} already exists; bump the version.`)
    const row = await tx.skill.create({
      data: {
        ...ref.create,
        evaluationCases: ref.create.evaluationCases as Prisma.InputJsonValue,
        metadata: { owner: meta.owner, lastReviewedAt: new Date().toISOString().slice(0, 10), createdByRevision: meta.revisionId },
        tenantId,
      },
    })
    createdSkillIds.push(row.id)
    skills.push({ skillId: row.id })
  }
  return { spec: { ...spec, skills }, createdSkillIds }
}

/** Writes a spec (all skill refs must be ids) onto an agent row. */
export async function applySpec(
  tx: Prisma.TransactionClient,
  agentId: string,
  spec: AgentSpec,
  options: { incrementVersion: boolean }
): Promise<Agent> {
  const current = await tx.agent.findUniqueOrThrow({ where: { id: agentId }, select: { config: true } })
  const config = (current.config && typeof current.config === 'object' ? current.config : {}) as Record<string, unknown>
  const skillIds = spec.skills.map((ref) => {
    if (!('skillId' in ref)) throw new SpecError('applySpec needs materialized skills')
    return ref.skillId
  })
  await tx.agentSkill.deleteMany({ where: { agentId } })
  if (skillIds.length) await tx.agentSkill.createMany({ data: skillIds.map((skillId) => ({ agentId, skillId, enabled: true })) })
  await tx.agentPermission.deleteMany({ where: { agentId } })
  if (spec.permissions.length) await tx.agentPermission.createMany({ data: spec.permissions.map((p) => ({ agentId, action: p.action, level: p.level })) })
  return tx.agent.update({
    where: { id: agentId },
    data: {
      name: spec.name,
      role: spec.role,
      mission: spec.mission,
      systemPrompt: spec.systemPrompt,
      modelProvider: spec.modelProvider,
      modelName: spec.modelName,
      modelConfig: spec.modelConfig as Prisma.InputJsonValue,
      config: { ...config, contract: spec.contract, evaluationCases: spec.evaluationCases } as Prisma.InputJsonValue,
      ...(options.incrementVersion ? { version: { increment: 1 } } : {}),
    },
  })
}
