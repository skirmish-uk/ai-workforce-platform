import { randomUUID } from 'node:crypto'
import { prisma } from '@ai-workforce/db'
import type { ApprovalLevel, AgentStatus, Prisma } from '@prisma/client'
import type { LLMClient, LLMCompleteParams, LLMResponse, LLMToolCall } from '@ai-workforce/llm'
import type { RegisteredTool } from '@ai-workforce/tools'
import type { RunAgentDeps } from '../agent'

/**
 * DB-backed tests write and delete real rows, so they must never point at a
 * dev or production database. Run them via `npm test` in packages/executor,
 * which sets DATABASE_URL to the ai_workforce_test database.
 */
export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? ''
  if (!/\/[\w-]*_test(\?|$)/.test(url)) {
    throw new Error(`Refusing to run DB tests: DATABASE_URL must point at a *_test database (got "${url.replace(/:[^:@/]+@/, ':***@')}")`)
  }
}

export function text(content: string, usage = { inputTokens: 100, outputTokens: 20 }): LLMResponse {
  return { content, toolCalls: [], stopReason: 'end_turn', usage, model: 'fake' }
}

export function toolUse(calls: Array<Omit<LLMToolCall, 'id'> & { id?: string }>, content: string | null = null): LLMResponse {
  return {
    content,
    toolCalls: calls.map((c, i) => ({ id: c.id ?? `call_${i}_${randomUUID().slice(0, 6)}`, name: c.name, input: c.input })),
    stopReason: 'tool_use',
    usage: { inputTokens: 100, outputTokens: 20 },
    model: 'fake',
  }
}

export type ScriptStep = LLMResponse | Error | ((params: LLMCompleteParams) => LLMResponse)

/**
 * A fake provider that replays a script. One script is shared by every client
 * the factory creates (fallback candidates included) unless `perModel` is used.
 */
export function scriptedLLM(script: ScriptStep[], perModel: Record<string, ScriptStep[]> = {}) {
  const calls: Array<{ provider: string; model: string; params: LLMCompleteParams }> = []
  const queues = new Map<string, ScriptStep[]>(Object.entries(perModel).map(([k, v]) => [k, [...v]]))
  const shared = [...script]
  const createClient = (provider: string, model: string): LLMClient => ({
    provider: provider as LLMClient['provider'],
    model,
    async complete(params: LLMCompleteParams): Promise<LLMResponse> {
      calls.push({ provider, model, params: JSON.parse(JSON.stringify(params)) })
      const queue = queues.get(model) ?? shared
      const step = queue.shift()
      if (!step) throw new Error(`scriptedLLM: script exhausted for ${model}`)
      if (step instanceof Error) throw step
      return typeof step === 'function' ? step(params) : step
    },
  })
  return { createClient, calls }
}

export function fakeTools(handler: (toolName: string, input: unknown) => unknown | Promise<unknown> = () => ({ ok: true })) {
  const executed: Array<{ toolName: string; input: unknown }> = []
  const executeTool = async (registered: RegisteredTool, input: unknown) => {
    executed.push({ toolName: registered.toolName, input })
    return handler(registered.toolName, input)
  }
  return { executeTool, executed }
}

export function deps(llm: ReturnType<typeof scriptedLLM>, tools = fakeTools()): RunAgentDeps {
  return { createClient: llm.createClient, executeTool: tools.executeTool, sleep: async () => undefined }
}

export const BASE_CONTRACT = {
  rationale: 'Keeps the CRM up to date so sales follow-ups are not missed.',
  definitionOfDone: { summary: 'A final answer summarising what was done is returned.', checks: [] as unknown[] },
  scope: { inScope: ['Updating CRM contacts'], outOfScope: ['Pricing decisions'] },
  autonomyStage: 'approval_gated',
  risk: { classification: 'medium' },
  owner: { name: 'Test Owner', contact: 'owner@example.test' },
  escalation: { destination: 'sales-ops@example.test' },
  limits: { maxRetries: 1 },
}

export interface FixtureOptions {
  contract?: Record<string, unknown> | null
  requiredTools?: string[]
  permissions?: Record<string, ApprovalLevel>
  tenantSettings?: Record<string, unknown>
  status?: AgentStatus
  modelProvider?: string
  modelName?: string
  evaluationCases?: unknown[]
}

export interface Fixture {
  tenantId: string
  agentId: string
  cleanup: () => Promise<void>
}

export async function createTenant(settings: Record<string, unknown> = {}): Promise<string> {
  const slug = `t-${randomUUID().slice(0, 12)}`
  const tenant = await prisma.tenant.create({ data: { name: `Test ${slug}`, slug, settings: settings as Prisma.InputJsonValue } })
  return tenant.id
}

export async function createAgent(tenantId: string, opts: FixtureOptions = {}): Promise<string> {
  const contract = opts.contract === undefined ? BASE_CONTRACT : opts.contract
  const agent = await prisma.agent.create({
    data: {
      name: `Agent ${randomUUID().slice(0, 6)}`,
      role: 'Test Specialist',
      mission: 'Exercise the agent executor in automated tests.',
      systemPrompt: 'You are a careful test agent. Follow the playbook exactly and report only what tools confirm.',
      modelProvider: opts.modelProvider ?? 'anthropic',
      modelName: opts.modelName ?? 'claude-haiku-4-5-20251001',
      status: opts.status ?? 'DRAFT',
      tenantId,
      config: (contract === null ? {} : { contract }) as Prisma.InputJsonValue,
    },
  })

  if (opts.requiredTools?.length) {
    const skill = await prisma.skill.create({
      data: {
        name: `skill-${randomUUID().slice(0, 8)}`,
        version: '1.0.0',
        description: 'Test skill',
        purpose: 'Test purpose for executor tests',
        instructions: 'Use the available tools to complete the request, then summarise.',
        requiredTools: opts.requiredTools,
        evaluationCases: (opts.evaluationCases ?? []) as Prisma.InputJsonValue,
        metadata: { owner: 'Test Owner', lastReviewedAt: '2026-10-10' },
        tenantId,
      },
    })
    await prisma.agentSkill.create({ data: { agentId: agent.id, skillId: skill.id, enabled: true } })
  }

  for (const [action, level] of Object.entries(opts.permissions ?? {})) {
    await prisma.agentPermission.create({ data: { agentId: agent.id, action, level } })
  }
  return agent.id
}

export async function createFixture(opts: FixtureOptions = {}): Promise<Fixture> {
  assertTestDatabase()
  const tenantId = await createTenant(opts.tenantSettings)
  const agentId = await createAgent(tenantId, opts)
  return {
    tenantId,
    agentId,
    cleanup: async () => {
      await prisma.skill.deleteMany({ where: { tenantId } })
      await prisma.tenant.delete({ where: { id: tenantId } })
    },
  }
}

export async function auditRows(tenantId: string, action?: string) {
  return prisma.auditLog.findMany({ where: { tenantId, ...(action ? { action } : {}) }, orderBy: { createdAt: 'asc' } })
}
