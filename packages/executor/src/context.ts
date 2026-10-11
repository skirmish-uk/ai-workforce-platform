import { prisma } from '@ai-workforce/db'
import type { Agent, Skill } from '@prisma/client'
import { searchKnowledge, isEmbeddingConfigured } from '@ai-workforce/knowledge'
import type { AutonomyStage } from '@ai-workforce/tools'
import { resolveAgentContract, type AgentContract } from './contract'
import { formatBusinessContext, readBusinessContext } from './business-context'
import { PLATFORM_POLICY, wrapUntrusted } from './untrusted'

export interface KnowledgeExcerpt {
  documentId: string
  title: string
  content: string
  updatedAt: string
  stale: boolean
  /** Present for semantic-search hits. */
  score?: number
}

export interface AssembledContext {
  systemPrompt: string
  skills: Skill[]
  requiredTools: string[]
  /** Provenance for every reference document placed in the prompt. */
  knowledgeUsed: KnowledgeExcerpt[]
  /** Missing/stale/invalid context detected while assembling — surfaced in the run trace. */
  warnings: string[]
  /** Prompt-injection heuristics that fired on retrieved content, by source. */
  injectionSignals: Array<{ source: string; signals: string[] }>
}

export interface BuildContextOptions {
  query?: string
  contract?: AgentContract
  stage?: AutonomyStage
  /** One line per offered tool, e.g. "gmail__send_email — requires human approval". */
  toolNotes?: string[]
}

async function loadAgentSkills(agentId: string): Promise<Skill[]> {
  const agentSkills = await prisma.agentSkill.findMany({
    where: { agentId, enabled: true },
    include: { skill: true },
  })
  return agentSkills.map((link) => link.skill).filter((skill) => skill.isActive)
}

function formatSkillSection(skill: Skill): string {
  const metadata = (skill.metadata ?? {}) as Record<string, unknown>
  const owner = typeof metadata.owner === 'string' ? ` · owner: ${metadata.owner}` : ''
  const constraints = skill.constraints.length
    ? `\nConstraints:\n${skill.constraints.map((c) => `- ${c}`).join('\n')}`
    : ''
  return `### ${skill.name} (v${skill.version}${owner})\nPurpose: ${skill.purpose}\n${skill.instructions}${constraints}`
}

function isStale(updatedAt: Date, staleAfterDays: number | undefined, now = Date.now()): boolean {
  return staleAfterDays !== undefined && now - updatedAt.getTime() > staleAfterDays * 86_400_000
}

/**
 * Prefers semantic search scoped to the current query (Phase 4 RAG); falls
 * back to the agent's highest-priority attached documents when there's no
 * query yet, or when OPENAI_API_KEY / embeddings aren't configured. Both paths
 * filter by tenant *in the query* (access control during retrieval, not after).
 */
async function loadKnowledgeContext(
  agentId: string,
  tenantId: string,
  query: string | undefined,
  limit: number,
  staleAfterDays: number | undefined
): Promise<KnowledgeExcerpt[]> {
  if (limit === 0) return []

  if (query && isEmbeddingConfigured()) {
    const results = await searchKnowledge({ tenantId, query, agentId, topK: limit })
    if (results.length) {
      const docs = await prisma.knowledgeDocument.findMany({
        where: { tenantId, id: { in: Array.from(new Set(results.map((r) => r.documentId))) } },
        select: { id: true, updatedAt: true },
      })
      const updated = new Map(docs.map((d) => [d.id, d.updatedAt]))
      return results.map((r) => {
        const updatedAt = updated.get(r.documentId) ?? new Date(0)
        return {
          documentId: r.documentId,
          title: r.documentTitle,
          content: r.content,
          updatedAt: updatedAt.toISOString(),
          stale: isStale(updatedAt, staleAfterDays),
          score: r.score,
        }
      })
    }
  }

  const sources = await prisma.agentKnowledgeSource.findMany({
    where: { agentId, document: { tenantId } },
    include: { document: true },
    orderBy: { priority: 'desc' },
    take: limit,
  })
  return sources.map((s) => ({
    documentId: s.document.id,
    title: s.document.title,
    content: s.document.content.slice(0, 1500),
    updatedAt: s.document.updatedAt.toISOString(),
    stale: isStale(s.document.updatedAt, staleAfterDays),
  }))
}

function bullet(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n')
}

function formatIdentity(agent: Agent, contract: AgentContract, stage: AutonomyStage | undefined, toolNotes: string[]): string {
  const lines = [
    `You are ${agent.name}, ${agent.role}.`,
    `Mission: ${agent.mission}`,
    `Why this matters: ${contract.rationale}`,
    `Definition of Done: ${contract.definitionOfDone.summary}`,
    `In scope:\n${bullet(contract.scope.inScope)}`,
    `Out of scope (decline or escalate):\n${bullet(contract.scope.outOfScope)}`,
  ]
  if (contract.inputs.description) lines.push(`Expected input: ${contract.inputs.description}`)
  if (contract.outputs.description || contract.outputs.format === 'json') {
    const fields = contract.outputs.requiredFields.length ? ` with fields: ${contract.outputs.requiredFields.join(', ')}` : ''
    lines.push(`Expected output: ${contract.outputs.description ?? ''}${contract.outputs.format === 'json' ? ` (respond with a JSON object${fields})` : ''}`.trim())
  }
  if (stage) lines.push(`Autonomy stage: ${stage}.`)
  lines.push(toolNotes.length ? `Tools available to you and how the platform will treat them:\n${bullet(toolNotes)}` : 'You have no external tools for this task.')
  lines.push(`Reporting line / escalation: ${contract.escalation.destination} (owner: ${contract.owner.name}).`)
  if (contract.escalation.triggers.length) lines.push(`Escalate when:\n${bullet(contract.escalation.triggers)}`)
  return lines.join('\n\n')
}

function formatSoul(contract: AgentContract): string | null {
  const soul = contract.soul
  const lines = [
    soul.tone && `Tone: ${soul.tone}`,
    soul.values?.length && `Working values:\n${bullet(soul.values)}`,
    soul.uncertainty && `When uncertain: ${soul.uncertainty}`,
    soul.askWhen && `Ask a question when: ${soul.askWhen}`,
    soul.escalateWhen && `Escalate when: ${soul.escalateWhen}`,
  ].filter(Boolean) as string[]
  return lines.length ? `${lines.join('\n')}\n(Style never overrides correctness, security or the platform policy.)` : null
}

/**
 * Assembles the full system prompt at call time. Order is the context
 * hierarchy from 03_AGENT_SYSTEM.md — higher sections win on conflict:
 * platform policy → identity/authority → behaviour (soul) → business context →
 * agent instructions → skill playbooks → retrieved reference knowledge
 * (wrapped as untrusted data). Nothing here is persisted: per CLAUDE.md
 * design decision #3, the prompt is rebuilt on every run.
 */
export async function buildAgentContext(agentId: string, options: BuildContextOptions = {}): Promise<AssembledContext> {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId }, include: { tenant: { select: { settings: true } } } })
  const contract = options.contract ?? resolveAgentContract(agent).contract
  const warnings: string[] = []
  const injectionSignals: AssembledContext['injectionSignals'] = []

  const skills = await loadAgentSkills(agentId)
  const knowledgeUsed = await loadKnowledgeContext(
    agentId,
    agent.tenantId,
    options.query,
    contract.context.maxKnowledgeExcerpts,
    contract.context.staleAfterDays
  )
  const requiredTools = Array.from(new Set(skills.flatMap((skill) => skill.requiredTools)))

  const business = readBusinessContext(agent.tenant.settings)
  if (business.error) warnings.push(business.error)
  if (!business.context) warnings.push('No tenant business context recorded (Tenant.settings.businessContext).')
  for (const doc of knowledgeUsed.filter((k) => k.stale)) {
    warnings.push(`Knowledge document "${doc.title}" (${doc.documentId}) is stale (last updated ${doc.updatedAt}).`)
  }

  const knowledgeBlocks = knowledgeUsed.map((k) => {
    const wrapped = wrapUntrusted(`knowledge:${k.documentId}`, `Title: ${k.title}\nLast updated: ${k.updatedAt}${k.stale ? ' (STALE — verify before relying on it)' : ''}\n\n${k.content}`)
    if (wrapped.signals.length) injectionSignals.push({ source: `knowledge:${k.documentId}`, signals: wrapped.signals })
    return wrapped.text
  })

  const soul = formatSoul(contract)
  const sections = [
    PLATFORM_POLICY,
    `## Identity and authority\n${formatIdentity(agent, contract, options.stage, options.toolNotes ?? [])}`,
    soul ? `## Behaviour\n${soul}` : null,
    `## Business context\n${formatBusinessContext(business.context)}`,
    agent.systemPrompt?.trim() ? `## Agent instructions\n${agent.systemPrompt.trim()}` : null,
    skills.length ? `## Playbooks\n${skills.map(formatSkillSection).join('\n\n')}` : null,
    knowledgeBlocks.length
      ? `## Reference knowledge\nRetrieved for this request. Cite the document title when you rely on it.\n\n${knowledgeBlocks.join('\n\n')}`
      : null,
  ]

  return {
    systemPrompt: sections.filter(Boolean).join('\n\n'),
    skills,
    requiredTools,
    knowledgeUsed,
    warnings,
    injectionSignals,
  }
}
