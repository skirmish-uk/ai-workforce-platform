/**
 * Copies one demo-tenant agent's tested upgrades from one database to another (for example
 * from a local demo to the hosted one), with their history:
 *
 *   npx tsx scripts/copy-agent.ts export demo-agent-1 > sarah.json      # on the source
 *   npx tsx scripts/copy-agent.ts import sarah.json [--dry-run]         # on the target
 *
 * Copies the agent's definition and version, the playbook versions it uses or that its
 * revisions created, its permissions, its promoted/rolled-back revisions (so the Improvements
 * page shows the history) and its evaluations. Everything is matched by meaning, not by row
 * id: the tenant by slug, playbooks by name + version, users by email. Revision specs are
 * rewritten to the target's playbook ids. Approvals, runs and audit rows are not copied.
 *
 * Import refuses unless the target agent is still at version 1 with no revisions (so it never
 * overwrites upgrades made on the target), and runs in one transaction. Back up first.
 */
import { config } from 'dotenv'
import path from 'node:path'
import { readFileSync } from 'node:fs'
const loaded = config({ path: path.resolve(__dirname, '../.env') })
for (const [key, value] of Object.entries(loaded.parsed ?? {})) {
  if (process.env[key] === '' && value !== '') process.env[key] = value
}

import { prisma } from '@ai-workforce/db'
import type { Prisma } from '@prisma/client'

const TENANT_SLUG = 'demo-agency'
const KEPT_STATUSES = ['PROMOTED', 'ROLLED_BACK']

interface ExportFile {
  format: 'ai-workforce-agent-copy/1'
  exportedAt: string
  agent: { id: string; name: string; role: string; mission: string; systemPrompt: string; modelProvider: string; modelName: string; modelConfig: unknown; config: unknown; version: number }
  /** Playbooks keyed by their source id. */
  skills: Record<string, { name: string; version: string; description: string | null; purpose: string | null; instructions: string; requiredTools: string[]; inputs: unknown; outputs: unknown; constraints: string[]; failureHandling: unknown; evaluationCases: unknown; metadata: unknown; isActive: boolean }>
  links: Array<{ skillId: string; enabled: boolean; config: unknown }>
  permissions: Array<{ action: string; level: string; conditions: unknown }>
  revisions: Array<Record<string, unknown> & { proposedByUserEmail: string | null }>
  evaluations: Array<{ id: string; name: string; suite: unknown; results: unknown; score: number | null; passed: boolean | null; agentVersion: number | null; createdAt: string }>
}

const json = (v: unknown) => (v === null || v === undefined ? undefined : (v as Prisma.InputJsonValue))

async function exportAgent(agentId: string): Promise<void> {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId }, include: { skills: true, permissions: true, tenant: { select: { slug: true } } } })
  if (agent.tenant.slug !== TENANT_SLUG) throw new Error(`${agentId} is not in the ${TENANT_SLUG} tenant`)
  const revisions = await prisma.agentRevision.findMany({ where: { agentId, status: { in: KEPT_STATUSES } }, orderBy: { createdAt: 'asc' } })
  const skillIds = new Set<string>(agent.skills.map((s) => s.skillId))
  for (const r of revisions) {
    for (const id of r.createdSkillIds) skillIds.add(id)
    for (const spec of [r.spec, r.previousSpec]) {
      for (const ref of ((spec as { skills?: Array<{ skillId?: string }> } | null)?.skills ?? [])) if (ref.skillId) skillIds.add(ref.skillId)
    }
  }
  const skills = await prisma.skill.findMany({ where: { id: { in: [...skillIds] } } })
  const users = await prisma.user.findMany({ where: { id: { in: revisions.map((r) => r.proposedByUserId).filter((x): x is string => Boolean(x)) } }, select: { id: true, email: true } })
  const email = new Map(users.map((u) => [u.id, u.email]))
  const evaluations = await prisma.evaluation.findMany({ where: { agentId }, orderBy: { createdAt: 'asc' } })
  const permissions = new Map(agent.permissions.map((p) => [p.action, { action: p.action, level: p.level, conditions: p.conditions }]))

  const out: ExportFile = {
    format: 'ai-workforce-agent-copy/1',
    exportedAt: new Date().toISOString(),
    agent: { id: agent.id, name: agent.name, role: agent.role, mission: agent.mission, systemPrompt: agent.systemPrompt, modelProvider: agent.modelProvider, modelName: agent.modelName, modelConfig: agent.modelConfig, config: agent.config, version: agent.version },
    skills: Object.fromEntries(skills.map((s) => [s.id, { name: s.name, version: s.version, description: s.description, purpose: s.purpose, instructions: s.instructions, requiredTools: s.requiredTools, inputs: s.inputs, outputs: s.outputs, constraints: s.constraints, failureHandling: s.failureHandling, evaluationCases: s.evaluationCases, metadata: s.metadata, isActive: s.isActive }])),
    links: agent.skills.map((l) => ({ skillId: l.skillId, enabled: l.enabled, config: l.config })),
    permissions: [...permissions.values()],
    revisions: revisions.map((r) => ({ ...r, tenantId: undefined, approvalId: null, candidateAgentId: null, proposedByUserEmail: r.proposedByUserId ? email.get(r.proposedByUserId) ?? null : null })),
    evaluations: evaluations.map((e) => ({ id: e.id, name: e.name, suite: e.suite, results: e.results, score: e.score, passed: e.passed, agentVersion: e.agentVersion, createdAt: e.createdAt.toISOString() })),
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
}

/** Rewrites every skillId inside a revision spec to the target's ids. */
function remapSpec(spec: unknown, ids: Map<string, string>): unknown {
  if (!spec || typeof spec !== 'object') return spec
  const s = spec as { skills?: Array<Record<string, unknown>> }
  if (!Array.isArray(s.skills)) return spec
  return { ...s, skills: s.skills.map((ref) => (typeof ref.skillId === 'string' ? { ...ref, skillId: ids.get(ref.skillId) ?? ref.skillId } : ref)) }
}

async function importAgent(file: string, dryRun: boolean): Promise<void> {
  const data = JSON.parse(readFileSync(file, 'utf8')) as ExportFile
  if (data.format !== 'ai-workforce-agent-copy/1') throw new Error('Not an agent copy file')
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const target = await prisma.agent.findUnique({ where: { id: data.agent.id } })
  if (!target || target.tenantId !== tenant.id) throw new Error(`${data.agent.id} does not exist in ${TENANT_SLUG} on the target; run the seed first`)
  const existing = await prisma.agentRevision.count({ where: { agentId: data.agent.id } })
  if (target.version !== 1 || existing > 0) {
    throw new Error(`Refusing: ${data.agent.id} on the target is at version ${target.version} with ${existing} revision(s). It has its own history; nothing was changed.`)
  }
  const users = await prisma.user.findMany({ where: { tenantId: tenant.id }, select: { id: true, email: true } })
  const userByEmail = new Map(users.map((u) => [u.email, u.id]))

  console.log(`${dryRun ? '[dry run] ' : ''}Copying ${data.agent.name}: v1 -> v${data.agent.version} (${data.agent.modelName}), ${Object.keys(data.skills).length} playbook version(s), ${data.revisions.length} revision(s), ${data.evaluations.length} evaluation(s), ${data.permissions.length} permission(s)`)
  if (dryRun) {
    for (const s of Object.values(data.skills)) console.log(`  playbook ${s.name} ${s.version}`)
    for (const r of data.revisions) console.log(`  revision ${r.id} ${r.status}: v${r.baseVersion} -> v${r.promotedVersion}`)
    return
  }

  await prisma.$transaction(async (tx) => {
    // Playbooks: reuse the target's row for the same name + version, else create it.
    const ids = new Map<string, string>()
    for (const [sourceId, s] of Object.entries(data.skills)) {
      const found = await tx.skill.findUnique({ where: { name_version_tenantId: { name: s.name, version: s.version, tenantId: tenant.id } } })
      const row = found ?? (await tx.skill.create({
        data: { name: s.name, version: s.version, description: s.description ?? '', purpose: s.purpose ?? '', instructions: s.instructions, requiredTools: s.requiredTools, inputs: json(s.inputs), outputs: json(s.outputs), constraints: s.constraints, failureHandling: json(s.failureHandling), evaluationCases: json(s.evaluationCases), metadata: json(s.metadata), isActive: s.isActive, tenantId: tenant.id },
      }))
      ids.set(sourceId, row.id)
      console.log(`  playbook ${s.name} ${s.version}: ${found ? 'already there' : 'created'}`)
    }

    await tx.agent.update({
      where: { id: data.agent.id },
      data: { name: data.agent.name, role: data.agent.role, mission: data.agent.mission, systemPrompt: data.agent.systemPrompt, modelProvider: data.agent.modelProvider, modelName: data.agent.modelName, modelConfig: json(data.agent.modelConfig), config: json(data.agent.config), version: data.agent.version },
    })
    await tx.agentSkill.deleteMany({ where: { agentId: data.agent.id } })
    await tx.agentSkill.createMany({ data: data.links.map((l) => ({ agentId: data.agent.id, skillId: ids.get(l.skillId) ?? l.skillId, enabled: l.enabled, config: json(l.config) })) })
    await tx.agentPermission.deleteMany({ where: { agentId: data.agent.id } })
    await tx.agentPermission.createMany({ data: data.permissions.map((p) => ({ agentId: data.agent.id, action: p.action, level: p.level as never, conditions: json(p.conditions) })) })

    for (const r of data.revisions) {
      const { proposedByUserEmail, ...rest } = r
      await tx.agentRevision.create({
        data: {
          ...(rest as Record<string, unknown>),
          tenantId: tenant.id,
          agentId: data.agent.id,
          approvalId: null,
          candidateAgentId: null,
          proposedByUserId: proposedByUserEmail ? userByEmail.get(proposedByUserEmail) ?? null : null,
          createdSkillIds: ((r.createdSkillIds as string[]) ?? []).map((id) => ids.get(id) ?? id),
          spec: json(remapSpec(r.spec, ids)),
          previousSpec: json(remapSpec(r.previousSpec, ids)),
        } as Prisma.AgentRevisionUncheckedCreateInput,
      })
    }
    for (const e of data.evaluations) {
      await tx.evaluation.create({ data: { id: e.id, name: e.name, suite: json(e.suite), results: json(e.results), score: e.score, passed: e.passed, agentVersion: e.agentVersion, createdAt: new Date(e.createdAt), agentId: data.agent.id } })
    }
  })
  console.log(`✅ ${data.agent.name} is now v${data.agent.version} on ${data.agent.modelName}, with ${data.revisions.length} revision(s) of history.`)
}

const [mode, arg] = process.argv.slice(2)
const run = mode === 'export' && arg ? exportAgent(arg) : mode === 'import' && arg ? importAgent(arg, process.argv.includes('--dry-run')) : Promise.reject(new Error('usage: copy-agent.ts export <agentId> | import <file> [--dry-run]'))
run
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
