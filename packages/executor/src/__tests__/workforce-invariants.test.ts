import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkRevisionInvariants, type InvariantInput } from '../workforce/invariants'
import { selfManagementPolicySchema } from '../workforce/policy'
import { carryOverCases, mergeSpec, SpecError, suiteOf, type AgentSpec, type SkillInfo } from '../workforce/spec'
import { judgeWatch } from '../workforce/revisions'
import { BASE_CONTRACT } from './helpers'

const CRM_GET = 'hubspot-crm__get_contact'
const CRM_UPDATE = 'hubspot-crm__update_contact'
const SEND = 'gmail__send_email'
const CASE_A = { name: 'a', input: 'x', expect: { status: 'completed' } }
const CASE_B = { name: 'b', input: 'y', expect: { toolsNotExecuted: [SEND] } }

const policy = selfManagementPolicySchema.parse({ enabled: true })

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    name: 'CRM Keeper',
    role: 'CRM hygiene',
    mission: 'Keep CRM contacts accurate and current.',
    systemPrompt: 'You keep the CRM tidy.',
    modelProvider: 'anthropic',
    modelName: 'claude-haiku-4-5-20251001',
    modelConfig: {},
    contract: JSON.parse(JSON.stringify(BASE_CONTRACT)),
    skills: [{ skillId: 's1' }],
    permissions: [{ action: CRM_UPDATE, level: 'CUSTOMER_APPROVAL' }],
    evaluationCases: [CASE_A],
    ...overrides,
  }
}
const crmSkill: SkillInfo = { id: 's1', name: 'crm', version: '1.0.0', requiredTools: [CRM_GET, CRM_UPDATE], evaluationCases: [CASE_B] }

function input(over: Partial<InvariantInput> = {}): InvariantInput {
  return {
    changeType: 'update',
    current: { spec: spec(), skills: [crmSkill], status: 'PRODUCTION' },
    candidate: { spec: spec({ systemPrompt: 'You keep the CRM tidy. Always check for duplicates first.' }), skills: [crmSkill] },
    policy,
    enabledAdapters: new Set(['HubSpot CRM', 'Gmail']),
    disabledTools: [],
    tenantAgentIds: new Set(['agent-1', 'agent-2']),
    ...over,
  }
}

test('a prompt-only change has no violations and no risk increase (goes live on passing tests)', () => {
  const r = checkRevisionInvariants(input())
  assert.deepEqual(r.violations, [])
  assert.deepEqual(r.riskIncreases, [])
  assert.deepEqual(r.tools, [CRM_GET, CRM_UPDATE])
})

test('hard limits: manager targets, granting management, autonomy ceiling, unknown/unconnected/disabled tools, foreign delegates', () => {
  const managerContract = { ...BASE_CONTRACT, management: { enabled: true } }
  assert.match(checkRevisionInvariants(input({ current: { spec: spec({ contract: managerContract }), skills: [], status: 'PRODUCTION' } })).violations.join(), /Manager agents cannot be changed/)
  assert.match(checkRevisionInvariants(input({ candidate: { spec: spec({ contract: managerContract }), skills: [crmSkill] } })).violations.join(), /can only be granted by a direct human edit/)

  const tooAutonomous = spec({ contract: { ...BASE_CONTRACT, autonomyStage: 'expanded' } })
  assert.match(checkRevisionInvariants(input({ candidate: { spec: tooAutonomous, skills: [crmSkill] } })).violations.join(), /above this tenant's self-management ceiling "limited"/)

  const unknown: SkillInfo = { name: 'x', version: '1.0.0', requiredTools: ['shell__exec'], evaluationCases: [CASE_B] }
  assert.match(checkRevisionInvariants(input({ candidate: { spec: spec(), skills: [crmSkill, unknown] } })).violations.join(), /"shell__exec" is not a registered platform tool/)

  const drive: SkillInfo = { name: 'drive', version: '1.0.0', requiredTools: ['google-drive__list_files'], evaluationCases: [CASE_B] }
  assert.match(checkRevisionInvariants(input({ candidate: { spec: spec(), skills: [crmSkill, drive] } })).violations.join(), /needs the "Google Drive" integration/)

  assert.match(checkRevisionInvariants(input({ disabledTools: [CRM_UPDATE] })).violations.join(), /disabled by a kill switch/)

  const delegating = spec({ contract: { ...BASE_CONTRACT, delegation: { enabled: true, allowedSpecialists: ['other-tenant-agent'] } } })
  assert.match(checkRevisionInvariants(input({ candidate: { spec: delegating, skills: [crmSkill] } })).violations.join(), /not an agent in this tenant/)

  assert.ok(checkRevisionInvariants(input({ candidate: { spec: spec({ contract: { rationale: 'short' } }), skills: [crmSkill] } })).violations.some((v) => v.startsWith('contract.')))
})

test('evaluation cases are append-only, including cases owned by a dropped playbook', () => {
  const dropped = checkRevisionInvariants(input({ candidate: { spec: spec({ evaluationCases: [] }), skills: [crmSkill] } }))
  assert.match(dropped.violations.join(), /1 existing evaluation case\(s\) would be removed/)

  // Replacing the playbook with one that has fewer cases is caught too…
  const weaker: SkillInfo = { ...crmSkill, id: 's2', version: '1.1.0', evaluationCases: [] }
  assert.match(checkRevisionInvariants(input({ candidate: { spec: spec({ skills: [{ skillId: 's2' }] }), skills: [weaker] } })).violations.join(), /would be removed/)

  // …unless the missing cases are carried over, which the pipeline does automatically.
  const carried = carryOverCases(spec({ skills: [{ skillId: 's2' }] }), [weaker], suiteOf(spec(), [crmSkill]))
  assert.deepEqual(checkRevisionInvariants(input({ candidate: { spec: carried, skills: [weaker] } })).violations, [])
})

test('risk increases need a human: autonomy, high-risk tools, looser permissions, owner/escalation, privacy, provider, cost cap, scope', () => {
  const sendSkill: SkillInfo = { name: 'email', version: '1.0.0', requiredTools: [SEND], evaluationCases: [] }
  const cases: Array<[Partial<AgentSpec>, SkillInfo[], RegExp]> = [
    [{ contract: { ...BASE_CONTRACT, autonomyStage: 'limited' } }, [crmSkill], /Autonomy raised from "approval_gated" to "limited"/],
    [{}, [crmSkill, sendSkill], /Adds high-risk tools: gmail__send_email/],
    [{ permissions: [{ action: CRM_UPDATE, level: 'AUTOMATIC' }] }, [crmSkill], /Loosens permission for hubspot-crm__update_contact/],
    [{ contract: { ...BASE_CONTRACT, escalation: { destination: 'someone-else@example.test' } } }, [crmSkill], /owns the agent or where it escalates/],
    [{ modelProvider: 'openai', modelName: 'gpt-4o-mini' }, [crmSkill], /different model provider/],
    [{ contract: { ...BASE_CONTRACT, scope: { inScope: ['Updating CRM contacts'], outOfScope: ['Other'] } } }, [crmSkill], /Removes out-of-scope boundaries: Pricing decisions/],
  ]
  for (const [over, skills, pattern] of cases) {
    const r = checkRevisionInvariants(input({ candidate: { spec: spec(over), skills } }))
    assert.deepEqual(r.violations, [], pattern.source)
    assert.match(r.riskIncreases.join(' | '), pattern)
  }

  const capped = spec({ contract: { ...BASE_CONTRACT, limits: { maxRetries: 1, maxRunCostUsd: 0.1 } } })
  const uncapped = checkRevisionInvariants(input({ current: { spec: capped, skills: [crmSkill], status: 'PRODUCTION' }, candidate: { spec: spec(), skills: [crmSkill] } }))
  assert.match(uncapped.riskIncreases.join(), /per-run cost limit/)

  const local = spec({ contract: { ...BASE_CONTRACT, model: { privacy: 'local_only' } }, modelProvider: 'ollama', modelName: 'llama3.1' })
  const leaky = checkRevisionInvariants(input({ current: { spec: local, skills: [crmSkill], status: 'PRODUCTION' }, candidate: { spec: { ...local, contract: { ...BASE_CONTRACT } }, skills: [crmSkill] } }))
  assert.match(leaky.riskIncreases.join(), /privacy local_only removed/)

  // Tightening is never a risk increase.
  const tighter = checkRevisionInvariants(input({ candidate: { spec: spec({ permissions: [{ action: CRM_UPDATE, level: 'PROHIBITED' }], contract: { ...BASE_CONTRACT, autonomyStage: 'draft' } }), skills: [crmSkill] } }))
  assert.deepEqual(tighter.riskIncreases, [])
})

test('create and retire', () => {
  const create = checkRevisionInvariants(input({ changeType: 'create', current: null }))
  assert.deepEqual(create.violations, [])
  assert.deepEqual(create.riskIncreases, [], 'a new agent with only CRM read/reversible tools at approval_gated is low risk')
  const sendSkill: SkillInfo = { name: 'email', version: '1.0.0', requiredTools: [SEND], evaluationCases: [] }
  assert.match(checkRevisionInvariants(input({ changeType: 'create', current: null, candidate: { spec: spec(), skills: [sendSkill] } })).riskIncreases.join(), /New agent with high-risk tools/)

  assert.match(checkRevisionInvariants(input({ changeType: 'retire', candidate: null })).riskIncreases.join(), /Retiring an agent that is in production/)
  assert.deepEqual(checkRevisionInvariants(input({ changeType: 'retire', candidate: null, current: { spec: spec(), skills: [], status: 'DRAFT' } })).riskIncreases, [])
})

test('mergeSpec: field replacement, permission merge, append-only cases, required fields for create', () => {
  const merged = mergeSpec(spec(), { systemPrompt: 'New prompt', permissions: [{ action: CRM_GET, level: 'AUTOMATIC' }], contract: { soul: { tone: 'warm' } } }, [CASE_B, CASE_A], { modelProvider: 'anthropic', modelName: 'm' })
  assert.equal(merged.systemPrompt, 'New prompt')
  assert.equal(merged.name, 'CRM Keeper')
  assert.deepEqual(merged.permissions.map((p) => p.action).sort(), [CRM_GET, CRM_UPDATE])
  assert.deepEqual((merged.contract as Record<string, unknown>).soul, { tone: 'warm' })
  assert.equal((merged.contract as Record<string, unknown>).rationale, BASE_CONTRACT.rationale, 'unlisted contract keys are kept')
  assert.equal(merged.evaluationCases.length, 2, 'duplicates are dropped; nothing is removed')
  assert.throws(() => mergeSpec(null, { name: 'x' }, [], { modelProvider: 'anthropic', modelName: 'm' }), SpecError)
})

test('watch verdicts: insufficient data, baseline comparison, absolute floors for new agents', () => {
  const watch = policy.watch
  assert.equal(judgeWatch({ runs: 2, dodPassRate: 0, failureRate: 1 }, null, watch).verdict, 'insufficient_data')
  const baseline = { runs: 20, dodPassRate: 0.9, failureRate: 0.05 }
  assert.equal(judgeWatch({ runs: 10, dodPassRate: 0.85, failureRate: 0.1 }, baseline, watch).verdict, 'healthy')
  const bad = judgeWatch({ runs: 10, dodPassRate: 0.5, failureRate: 0.4 }, baseline, watch)
  assert.equal(bad.verdict, 'degraded')
  assert.equal(bad.verdict === 'degraded' && bad.reasons.length, 2)
  assert.equal(judgeWatch({ runs: 10, dodPassRate: 0.9, failureRate: 0.5 }, { runs: 0, dodPassRate: null, failureRate: null }, watch).verdict, 'degraded')
  assert.equal(judgeWatch({ runs: 10, dodPassRate: 0.9, failureRate: 0.1 }, null, watch).verdict, 'healthy')
})
