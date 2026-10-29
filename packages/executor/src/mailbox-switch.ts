import { prisma } from '@ai-workforce/db'
import type { Prisma } from '@prisma/client'
import { toolRegistry } from '@ai-workforce/tools'

/**
 * Points a tenant's agents at the mailbox they use: Gmail (`gmail__*` tools) or any other
 * mailbox over IMAP/SMTP (`email__*`, packages/integrations/src/email.ts). The two have the same
 * actions and inputs, so this renames the tool names everywhere an agent refers to them: its
 * instructions, contract (allowed tools, done checks), playbooks (instructions, required tools,
 * test cases), permissions and approval policies. Each changed agent moves to a new version, so
 * an agent at `limited` or `expanded` asks for approval again until its tests pass on the new
 * version (run them from the agent's page). Nothing else about the agent changes.
 *
 * Refuses an agent when renaming would leave it with a tool the other mailbox doesn't have
 * (email__move_email has no Gmail version), or when one of its playbooks is shared with other
 * tenants.
 */

export type MailboxKind = 'gmail' | 'email'

export interface MailboxSwitchAgent {
  agentId: string
  name: string
  /** Tools renamed for this agent, e.g. "gmail__send_email -> email__send_email". */
  tools: string[]
  skipped?: string
}

export interface MailboxSwitchResult {
  to: MailboxKind
  applied: boolean
  agents: MailboxSwitchAgent[]
  /** Agents that don't use email at all. */
  unchanged: number
}

const PREFIX: Record<MailboxKind, string> = { gmail: 'gmail__', email: 'email__' }
const INTEGRATION: Record<MailboxKind, string> = { gmail: 'Gmail', email: 'Email' }

function renamer(to: MailboxKind) {
  const from = to === 'email' ? 'gmail' : 'email'
  const pattern = new RegExp(`\\b${from}__([a-z_]+)`, 'g')
  const found = new Set<string>()
  const text = (value: string): string =>
    value.replace(pattern, (whole, action: string) => {
      found.add(action)
      return `${PREFIX[to]}${action}`
    })
  const json = <T>(value: T): T => JSON.parse(text(JSON.stringify(value ?? null))) as T
  return { text, json, found, from }
}

export async function switchMailboxTools(input: { tenantId: string; to: MailboxKind; apply: boolean; actorUserId?: string | null }): Promise<MailboxSwitchResult> {
  const { tenantId, to, apply } = input
  if (apply) {
    const connection = await prisma.integration.findFirst({ where: { tenantId, name: INTEGRATION[to], isActive: true } })
    if (!connection) throw new Error(`Connect ${to === 'email' ? 'a mailbox' : 'Gmail'} on the Integrations page first: agents can't use ${INTEGRATION[to]} until it is connected.`)
  }

  const agents = await prisma.agent.findMany({
    where: { tenantId, isCandidate: false, status: { not: 'ARCHIVED' } },
    include: { skills: { include: { skill: true } }, permissions: true, approvalPolicies: true },
    orderBy: { name: 'asc' },
  })

  const result: MailboxSwitchResult = { to, applied: false, agents: [], unchanged: 0 }
  for (const agent of agents) {
    const r = renamer(to)
    const systemPrompt = r.text(agent.systemPrompt)
    const mission = r.text(agent.mission)
    const config = r.json(agent.config)
    const skills = agent.skills.map(({ skill }) => {
      const rs = renamer(to)
      const data = {
        instructions: rs.text(skill.instructions),
        description: rs.text(skill.description),
        purpose: rs.text(skill.purpose),
        requiredTools: skill.requiredTools.map(rs.text),
        constraints: skill.constraints.map(rs.text),
        evaluationCases: rs.json(skill.evaluationCases),
        failureHandling: rs.json(skill.failureHandling),
        metadata: rs.json(skill.metadata),
      }
      for (const a of rs.found) r.found.add(a)
      return { skill, data, changed: rs.found.size > 0 }
    })
    const permissions = agent.permissions.map((p) => ({ p, action: r.text(p.action) }))
    const policies = agent.approvalPolicies.map((p) => ({ p, action: r.text(p.action) }))

    if (!r.found.size) {
      result.unchanged++
      continue
    }
    const entry: MailboxSwitchAgent = { agentId: agent.id, name: agent.name, tools: [...r.found].sort().map((a) => `${r.from}__${a} -> ${PREFIX[to]}${a}`) }
    result.agents.push(entry)

    const missing = [...r.found].filter((a) => !toolRegistry.has(`${PREFIX[to]}${a}`))
    if (missing.length) {
      entry.skipped = `${INTEGRATION[to]} has no ${missing.map((a) => `${PREFIX[to]}${a}`).join(', ')}; change the agent's playbook first.`
      continue
    }
    const shared = skills.find(({ skill, changed }) => changed && skill.tenantId !== tenantId)
    if (shared) {
      entry.skipped = `Playbook "${shared.skill.name}" is shared with other businesses, so it can't be changed for this one.`
      continue
    }
    if (!apply) continue

    await prisma.$transaction(async (tx) => {
      for (const { skill, data, changed } of skills) {
        if (!changed) continue
        await tx.skill.update({ where: { id: skill.id }, data: { ...data, evaluationCases: data.evaluationCases as Prisma.InputJsonValue, failureHandling: data.failureHandling as Prisma.InputJsonValue, metadata: data.metadata as Prisma.InputJsonValue } })
      }
      const keep = new Set(agent.permissions.map((p) => p.action))
      for (const { p, action } of permissions) {
        if (action === p.action) continue
        // The agent may already have the other mailbox's permission: keep that one.
        if (keep.has(action)) await tx.agentPermission.delete({ where: { id: p.id } })
        else await tx.agentPermission.update({ where: { id: p.id }, data: { action } })
      }
      for (const { p, action } of policies) if (action !== p.action) await tx.approvalPolicy.update({ where: { id: p.id }, data: { action } })
      await tx.agent.update({ where: { id: agent.id }, data: { systemPrompt, mission, config: config as Prisma.InputJsonValue, version: { increment: 1 } } })
      await tx.auditLog.create({
        data: { action: 'AGENT_MAILBOX_SWITCHED', entityType: 'Agent', entityId: agent.id, tenantId, userId: input.actorUserId ?? null, oldData: { version: agent.version }, newData: { to, version: agent.version + 1, tools: entry.tools } },
      })
    })
  }
  result.applied = apply
  return result
}
