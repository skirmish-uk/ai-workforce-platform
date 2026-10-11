import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentContractSchema, resolveAgentContract, validateAgentDefinition } from '../contract'
import { BASE_CONTRACT } from './helpers'

const agentWith = (contract: unknown, extra: Partial<{ modelProvider: string; modelName: string; systemPrompt: string }> = {}) => ({
  config: contract === undefined ? {} : { contract },
  mission: 'Keep CRM records accurate for the sales team.',
  systemPrompt: extra.systemPrompt ?? 'Be careful.',
  modelProvider: extra.modelProvider ?? 'anthropic',
  modelName: extra.modelName ?? 'claude-haiku-4-5-20251001',
})

const skill = (over: Partial<{ requiredTools: string[]; evaluationCases: unknown; metadata: unknown; version: string }> = {}) => ({
  name: 'crm_update',
  version: over.version ?? '1.0.0',
  requiredTools: over.requiredTools ?? ['hubspot-crm__update_contact'],
  evaluationCases: (over.evaluationCases ?? [{ input: 'x', expect: { status: 'completed' } }]) as never,
  metadata: (over.metadata ?? { owner: 'Ops', lastReviewedAt: '2026-10-01' }) as never,
})

test('a minimal contract parses with conservative defaults', () => {
  const c = agentContractSchema.parse(BASE_CONTRACT)
  assert.equal(c.memory.mode, 'none')
  assert.equal(c.delegation.enabled, false)
  assert.equal(c.limits.maxIterations, 8)
  assert.equal(c.limits.maxToolCalls, 20)
  assert.equal(c.approvals.ttlHours, 72)
  assert.equal(c.schedule.missedRunPolicy, 'skip')
  assert.equal(c.model.privacy, 'any')
  assert.equal(agentContractSchema.parse({ ...BASE_CONTRACT, autonomyStage: undefined }).autonomyStage, 'approval_gated')
})

test('missing required contract fields are reported, not defaulted', () => {
  const rest: Record<string, unknown> = { ...BASE_CONTRACT }
  delete rest.owner
  delete rest.definitionOfDone
  const resolved = resolveAgentContract(agentWith(rest))
  assert.equal(resolved.source, 'config')
  assert.ok(resolved.errors.some((e) => e.includes('owner')), resolved.errors.join())
  assert.ok(resolved.errors.some((e) => e.includes('definitionOfDone')), resolved.errors.join())
})

test('unknown keys and unimplemented memory modes are rejected (strict schema)', () => {
  assert.ok(resolveAgentContract(agentWith({ ...BASE_CONTRACT, superpowers: true })).errors.length > 0)
  assert.ok(resolveAgentContract(agentWith({ ...BASE_CONTRACT, memory: { mode: 'persistent' } })).errors.length > 0)
  assert.ok(resolveAgentContract(agentWith({ ...BASE_CONTRACT, autonomyStage: 'god_mode' })).errors.length > 0)
})

test('agents without a contract get approval-gated legacy defaults and cannot be deployed', () => {
  const resolved = resolveAgentContract(agentWith(undefined))
  assert.equal(resolved.source, 'legacy_default')
  assert.equal(resolved.contract.autonomyStage, 'approval_gated')
  assert.equal(validateAgentDefinition(agentWith(undefined), [skill()]).ok, true)
  const deploy = validateAgentDefinition(agentWith(undefined), [skill()], { forDeployment: true })
  assert.equal(deploy.ok, false)
  assert.ok(deploy.errors.some((e) => e.includes('no contract')))
})

test('contradictory configuration fails validation', () => {
  const cases: Array<[string, unknown, Parameters<typeof agentWith>[1]?]> = [
    ['delegation without specialists', { ...BASE_CONTRACT, delegation: { enabled: true } }],
    ['local_only with cloud fallback', { ...BASE_CONTRACT, model: { privacy: 'local_only', fallbacks: [{ provider: 'openai', model: 'gpt-4o' }] } }, { modelProvider: 'ollama', modelName: 'llama3.1' }],
    ['local_only with cloud primary', { ...BASE_CONTRACT, model: { privacy: 'local_only' } }],
    ['unknown allowlisted tool', { ...BASE_CONTRACT, allowedTools: ['acme__launch_rockets'] }],
    [
      'DoD requires a tool the allowlist forbids',
      { ...BASE_CONTRACT, allowedTools: ['hubspot-crm__update_contact'], definitionOfDone: { summary: 'Email sent to the lead.', checks: [{ type: 'tool_succeeded', tool: 'gmail__send_email' }] } },
    ],
  ]
  for (const [label, contract, extra] of cases) {
    const v = validateAgentDefinition(agentWith(contract, extra), [skill()])
    assert.equal(v.ok, false, label)
  }
})

test('deployment strictness: playbooks need eval cases, an owner and registered tools', () => {
  const ok = validateAgentDefinition(agentWith(BASE_CONTRACT), [skill()], { forDeployment: true })
  assert.deepEqual(ok.errors, [])

  const noCases = validateAgentDefinition(agentWith(BASE_CONTRACT), [skill({ evaluationCases: [] })], { forDeployment: true })
  assert.ok(noCases.errors.some((e) => e.includes('no evaluation cases')))
  // Drafts only get a warning for the same problem.
  const draft = validateAgentDefinition(agentWith(BASE_CONTRACT), [skill({ evaluationCases: [] })])
  assert.equal(draft.ok, true)
  assert.ok(draft.warnings.some((w) => w.includes('no evaluation cases')))

  const noOwner = validateAgentDefinition(agentWith(BASE_CONTRACT), [skill({ metadata: {} })], { forDeployment: true })
  assert.ok(noOwner.errors.some((e) => e.includes('no owner')))

  const badTool = validateAgentDefinition(agentWith(BASE_CONTRACT), [skill({ requiredTools: ['slack__post'] })], { forDeployment: true })
  assert.ok(badTool.errors.some((e) => e.includes('unregistered tools')))

  const noPrompt = validateAgentDefinition(agentWith(BASE_CONTRACT, { systemPrompt: '  ' }), [skill()], { forDeployment: true })
  assert.ok(noPrompt.errors.some((e) => e.includes('system prompt')))
})
