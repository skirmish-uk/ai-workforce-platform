import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '@ai-workforce/db'
import type { Prisma } from '@prisma/client'
import { runAgent } from '../agent'
import { decideApproval, executeApprovedAction } from '../approvals'
import {
  processRevision,
  proposeRevision,
  RevisionError,
  rollbackRevision,
  watchPromotedRevisions,
} from '../workforce/revisions'
import { BASE_CONTRACT, assertTestDatabase, createAgent, createFixture, deps, fakeTools, scriptedLLM, text, toolUse, type Fixture } from './helpers'

const CRM_GET = 'hubspot-crm__get_contact'
const CRM_UPDATE = 'hubspot-crm__update_contact'
const SEND = 'gmail__send_email'
const CASE_OK = { name: 'routine update', category: 'normal', input: 'Update contact c1 to stage lead', expect: { status: ['completed', 'approval_required'], toolsNotExecuted: [SEND] } }
const NEW_CASE = { name: 'duplicate check', category: 'regression', input: 'Is c1 a duplicate?', expect: { status: 'completed' } }
const MANAGER_CONTRACT = { ...BASE_CONTRACT, management: { enabled: true } }
const FATAL = () => Object.assign(new Error('bad request'), { status: 400 })

const fixtures: Fixture[] = []
before(() => assertTestDatabase())
after(async () => {
  for (const f of fixtures) await f.cleanup().catch(() => undefined)
  await prisma.$disconnect()
})

/** A tenant with self-management on, HubSpot + Gmail connected, one worker agent and one manager. */
async function workforce(selfManagement: Record<string, unknown> = {}, agentStatus: 'DRAFT' | 'PRODUCTION' = 'DRAFT') {
  const f = await createFixture({
    tenantSettings: { selfManagement: { enabled: true, replayRuns: 0, ...selfManagement } },
    requiredTools: [CRM_GET, CRM_UPDATE],
    permissions: { [CRM_UPDATE]: 'CUSTOMER_APPROVAL' },
    evaluationCases: [CASE_OK],
    status: agentStatus,
  })
  fixtures.push(f)
  await prisma.integration.createMany({
    data: [
      { name: 'HubSpot CRM', provider: 'hubspot', tenantId: f.tenantId, credentials: {} },
      { name: 'Gmail', provider: 'google', tenantId: f.tenantId, credentials: {} },
    ],
  })
  const managerId = await createAgent(f.tenantId, { contract: MANAGER_CONTRACT })
  const admin = await prisma.user.create({ data: { email: `admin-${f.tenantId}@example.test`, role: 'CUSTOMER_ADMIN', tenantId: f.tenantId } })
  return { ...f, managerId, admin: { id: admin.id, role: admin.role, tenantId: admin.tenantId } }
}

function propose(w: Awaited<ReturnType<typeof workforce>>, over: Partial<Parameters<typeof proposeRevision>[0]> = {}) {
  return proposeRevision({
    tenantId: w.tenantId,
    changeType: 'update',
    agentId: w.agentId,
    rationale: 'Three runs last week updated duplicate contacts; add a duplicate check to the prompt.',
    changes: { systemPrompt: 'You keep the CRM tidy. Before updating, check whether the contact is a duplicate.' },
    addEvaluationCases: [NEW_CASE],
    proposedBy: { agentId: w.managerId, runId: 'manager-run-1' },
    ...over,
  })
}

const passingLLM = (n = 10) => scriptedLLM(Array.from({ length: n }, () => text('Done: checked for duplicates and summarised.')))

describe('revision pipeline', () => {
  test('a low-risk change that passes evaluation is promoted automatically as a new version', async () => {
    const w = await workforce()
    const { revisionId, riskIncreases } = await propose(w)
    assert.deepEqual(riskIncreases, [])

    const llm = passingLLM()
    const outcome = await processRevision(revisionId, { deps: deps(llm) })
    assert.equal(outcome.status, 'PROMOTED', outcome.error)
    assert.equal(llm.calls.length, 2, 'both suite cases (existing + added) were evaluated')

    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: w.agentId } })
    assert.equal(agent.version, 2)
    assert.match(agent.systemPrompt, /duplicate/)
    assert.deepEqual((agent.config as { evaluationCases: unknown[] }).evaluationCases, [NEW_CASE])
    assert.equal(await prisma.agent.count({ where: { tenantId: w.tenantId, isCandidate: true } }), 0, 'sandbox removed')
    const evidence = await prisma.evaluation.findFirst({ where: { agentId: w.agentId, agentVersion: 2, passed: true } })
    assert.ok(evidence, 'evaluation evidence carried to the promoted version')

    const rev = await prisma.agentRevision.findUniqueOrThrow({ where: { id: revisionId } })
    assert.equal(rev.promotedVersion, 2)
    assert.ok(rev.watchUntil && rev.previousSpec)
    assert.ok(await prisma.auditLog.findFirst({ where: { tenantId: w.tenantId, action: 'AGENT_REVISION_PROMOTED', entityId: revisionId } }))
  })

  test('a candidate that fails evaluation is discarded and the live agent is untouched (new playbooks cleaned up)', async () => {
    const w = await workforce()
    const before = await prisma.agent.findUniqueOrThrow({ where: { id: w.agentId } })
    const existing = await prisma.agentSkill.findFirstOrThrow({ where: { agentId: w.agentId } })
    const { revisionId } = await propose(w, {
      changes: {
        skills: [
          { skillId: existing.skillId },
          { create: { name: 'dedupe', version: '1.0.0', description: 'Dedupe contacts', purpose: 'Avoid duplicate records', instructions: 'Search before updating.', requiredTools: [CRM_GET], evaluationCases: [NEW_CASE] } },
        ],
      },
    })
    const llm = scriptedLLM([FATAL(), FATAL(), FATAL()])
    const outcome = await processRevision(revisionId, { deps: deps(llm) })
    assert.equal(outcome.status, 'FAILED')
    assert.match(outcome.error ?? '', /failed its evaluation suite/)

    const after = await prisma.agent.findUniqueOrThrow({ where: { id: w.agentId } })
    assert.equal(after.version, before.version)
    assert.equal(after.systemPrompt, before.systemPrompt)
    assert.equal(await prisma.agent.count({ where: { tenantId: w.tenantId, isCandidate: true } }), 0)
    assert.equal(await prisma.skill.count({ where: { tenantId: w.tenantId, name: 'dedupe' } }), 0, 'playbook created for the failed candidate removed')
    const rev = await prisma.agentRevision.findUniqueOrThrow({ where: { id: revisionId } })
    assert.ok((rev.results as { evaluation?: { failures: unknown[] } }).evaluation?.failures.length)
  })

  test('a risk-increasing change waits for a human; approval promotes it exactly once', async () => {
    const w = await workforce()
    const { revisionId, riskIncreases } = await propose(w, { changes: { permissions: [{ action: CRM_UPDATE, level: 'AUTOMATIC' }] } })
    assert.match(riskIncreases.join(), /Loosens permission/)

    const outcome = await processRevision(revisionId, { deps: deps(passingLLM()) })
    assert.equal(outcome.status, 'AWAITING_APPROVAL', outcome.error)
    assert.equal((await prisma.agent.findUniqueOrThrow({ where: { id: w.agentId } })).version, 1, 'nothing applied before approval')

    const approval = await prisma.approval.findUniqueOrThrow({ where: { id: outcome.approvalId! } })
    assert.equal((approval.input as { kind: string }).kind, 'agent_revision')
    await decideApproval({ approvalId: approval.id, decision: 'approve', actor: w.admin })
    const executed = await executeApprovedAction(approval.id)
    assert.equal(executed.status, 'EXECUTED', executed.error)
    assert.equal((await executeApprovedAction(approval.id)).status, 'EXECUTED', 'second execution is a no-op')

    const permission = await prisma.agentPermission.findFirstOrThrow({ where: { agentId: w.agentId, action: CRM_UPDATE } })
    assert.equal(permission.level, 'AUTOMATIC')
    assert.equal((await prisma.agent.findUniqueOrThrow({ where: { id: w.agentId } })).version, 2)
  })

  test('a rejected approval discards the candidate', async () => {
    const w = await workforce()
    const { revisionId } = await propose(w, { changes: { contract: { autonomyStage: 'limited' } } })
    const outcome = await processRevision(revisionId, { deps: deps(passingLLM()) })
    assert.equal(outcome.status, 'AWAITING_APPROVAL', outcome.error)
    await decideApproval({ approvalId: outcome.approvalId!, decision: 'reject', actor: w.admin, reason: 'not yet' })
    const rev = await prisma.agentRevision.findUniqueOrThrow({ where: { id: revisionId } })
    assert.equal(rev.status, 'REJECTED')
    assert.equal(await prisma.agent.count({ where: { tenantId: w.tenantId, isCandidate: true } }), 0)
  })

  test('hard limits are refused at proposal time, whoever would approve them', async () => {
    const w = await workforce({ maxRevisionsPerDay: 3 })
    const refused = async (over: Partial<Parameters<typeof proposeRevision>[0]>, code: RevisionError['code'], pattern: RegExp) => {
      await assert.rejects(propose(w, over), (e: unknown) => e instanceof RevisionError && e.code === code && pattern.test(e.message))
    }
    await refused({ changes: { contract: { autonomyStage: 'expanded' } } }, 'INVALID', /ceiling/)
    await refused({ changes: { contract: { management: { enabled: true } } } }, 'INVALID', /can only be granted by a direct human edit/)
    await refused({ agentId: w.managerId, proposedBy: { agentId: 'someone-else' } }, 'INVALID', /Manager agents cannot be changed/)
    await refused({ agentId: w.managerId }, 'INVALID', /cannot propose changes to itself/)
    await refused({ changes: { skills: [{ create: { name: 'x', version: '1.0.0', description: 'd', purpose: 'p', instructions: 'i', requiredTools: ['shell__exec'], evaluationCases: [NEW_CASE] } }] } }, 'INVALID', /not a registered platform tool/)
    await refused({ addEvaluationCases: [{ input: 'no assertions' }] }, 'INVALID', /no "expect"/)

    await propose(w)
    await refused({}, 'CONFLICT', /open revision/)
    const other = await createAgent(w.tenantId, { requiredTools: [CRM_GET], evaluationCases: [CASE_OK] })
    await propose(w, { agentId: other })
    const third = await createAgent(w.tenantId, { requiredTools: [CRM_GET], evaluationCases: [CASE_OK] })
    await propose(w, { agentId: third })
    const fourth = await createAgent(w.tenantId, { requiredTools: [CRM_GET], evaluationCases: [CASE_OK] })
    await refused({ agentId: fourth }, 'RATE_LIMITED', /Daily revision limit/)

    const off = await workforce({ enabled: false })
    await assert.rejects(propose(off), (e: unknown) => e instanceof RevisionError && e.code === 'DISABLED')
  })

  test('a revision against an agent a human has since edited is superseded, not applied', async () => {
    const w = await workforce()
    const { revisionId } = await propose(w)
    await prisma.agent.update({ where: { id: w.agentId }, data: { version: { increment: 1 }, systemPrompt: 'Human edit' } })
    const outcome = await processRevision(revisionId, { deps: deps(passingLLM()) })
    assert.equal(outcome.status, 'SUPERSEDED')
    assert.equal((await prisma.agent.findUniqueOrThrow({ where: { id: w.agentId } })).systemPrompt, 'Human edit')
  })

  test('replay: a candidate that does worse than the live agent on recent real inputs is not promoted', async () => {
    const w = await workforce({ replayRuns: 2 })
    for (const input of ['Update contact c7 email', 'Merge c8 and c9']) {
      await prisma.auditLog.create({
        data: { action: 'AGENT_RUN_COMPLETED', entityType: 'Agent', entityId: w.agentId, tenantId: w.tenantId, newData: { status: 'completed', input, trigger: 'api', dryRun: false, dodPassed: true } as Prisma.InputJsonValue },
      })
    }
    const { revisionId } = await propose(w)
    // 2 suite cases pass, then both replays fail.
    const llm = scriptedLLM([text('ok'), text('ok'), FATAL(), FATAL()])
    const tools = fakeTools()
    const outcome = await processRevision(revisionId, { deps: deps(llm, tools) })
    assert.equal(outcome.status, 'FAILED')
    assert.match(outcome.error ?? '', /Replay: candidate did worse .* \(2 vs 0 bad outcomes of 2\)/)
    assert.equal((await prisma.agent.findUniqueOrThrow({ where: { id: w.agentId } })).version, 1)
  })

  test('the post-promotion watch rolls back automatically when live metrics degrade', async () => {
    const w = await workforce()
    const { revisionId } = await propose(w)
    assert.equal((await processRevision(revisionId, { deps: deps(passingLLM()) })).status, 'PROMOTED')
    const original = 'You are a careful test agent. Follow the playbook exactly and report only what tools confirm.'

    for (let i = 0; i < 5; i++) {
      await prisma.auditLog.create({
        data: { action: 'AGENT_RUN_FAILED', entityType: 'Agent', entityId: w.agentId, tenantId: w.tenantId, newData: { status: 'failed', input: `job ${i}`, dryRun: false } as Prisma.InputJsonValue },
      })
    }
    const outcomes = await watchPromotedRevisions()
    assert.ok(outcomes.some((o) => o.revisionId === revisionId && o.verdict === 'rolled_back'), JSON.stringify(outcomes))

    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: w.agentId } })
    assert.equal(agent.version, 3, 'rollback is a new version; history is not rewritten')
    assert.equal(agent.systemPrompt, original)
    const rev = await prisma.agentRevision.findUniqueOrThrow({ where: { id: revisionId } })
    assert.equal(rev.status, 'ROLLED_BACK')
    assert.equal((rev.results as { rollback: { automatic: boolean } }).rollback.automatic, true)
    await assert.rejects(rollbackRevision(revisionId, { reason: 'again' }), RevisionError)
  })

  test('manual rollback refuses when the agent changed again since the revision', async () => {
    const w = await workforce()
    const { revisionId } = await propose(w)
    await processRevision(revisionId, { deps: deps(passingLLM()) })
    await prisma.agent.update({ where: { id: w.agentId }, data: { version: { increment: 1 } } })
    await assert.rejects(rollbackRevision(revisionId, { reason: 'undo' }), /roll back manually/)
    assert.equal((await prisma.agentRevision.findUniqueOrThrow({ where: { id: revisionId } })).status, 'PROMOTED', 'status restored')
  })

  test('create: a new agent with a new playbook is built, evaluated and promoted for deployment', async () => {
    const w = await workforce()
    const { revisionId } = await proposeRevision({
      tenantId: w.tenantId,
      changeType: 'create',
      rationale: 'Overdue CRM follow-ups are being missed; a dedicated agent should flag stale contacts.',
      changes: {
        name: 'Follow-up Flagger',
        role: 'Flags stale CRM contacts',
        mission: 'Find contacts with no activity for 30 days and report them.',
        systemPrompt: 'You find stale contacts and report them. You never contact anyone.',
        contract: { ...BASE_CONTRACT, rationale: 'Stale contacts cost deals; flag them weekly so sales can follow up.' },
        skills: [{ create: { name: 'stale-contacts', version: '1.0.0', description: 'Find stale contacts', purpose: 'Surface follow-ups', instructions: 'Search contacts, report stale ones.', requiredTools: [CRM_GET], evaluationCases: [NEW_CASE] } }],
      },
      proposedBy: { agentId: w.managerId },
    })
    const outcome = await processRevision(revisionId, { deps: deps(passingLLM()) })
    assert.equal(outcome.status, 'PROMOTED', outcome.error)
    assert.ok(outcome.deployAgentId)
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: outcome.deployAgentId }, include: { skills: { include: { skill: true } } } })
    assert.equal(agent.isCandidate, false)
    assert.equal(agent.name, 'Follow-up Flagger')
    assert.match(String((agent.skills[0].skill.metadata as { owner: string }).owner), /Workforce Manager/)
  })

  test('retire: pausing a production agent needs approval and can be rolled back', async () => {
    const w = await workforce({}, 'PRODUCTION')
    const { revisionId } = await propose(w, { changeType: 'retire', changes: undefined, addEvaluationCases: undefined })
    const outcome = await processRevision(revisionId)
    assert.equal(outcome.status, 'AWAITING_APPROVAL')
    await decideApproval({ approvalId: outcome.approvalId!, decision: 'approve', actor: w.admin })
    assert.equal((await executeApprovedAction(outcome.approvalId!)).status, 'EXECUTED')
    assert.equal((await prisma.agent.findUniqueOrThrow({ where: { id: w.agentId } })).status, 'PAUSED')
    await rollbackRevision(revisionId, { reason: 'still needed' })
    assert.equal((await prisma.agent.findUniqueOrThrow({ where: { id: w.agentId } })).status, 'PRODUCTION')
  })

  test('a tenant kill switch blocks processing', async () => {
    const w = await workforce()
    const { revisionId } = await propose(w)
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: w.tenantId } })
    await prisma.tenant.update({ where: { id: w.tenantId }, data: { settings: { ...(tenant.settings as object), killSwitch: { agentsDisabled: true } } } })
    assert.equal((await processRevision(revisionId, { deps: deps(passingLLM()) })).status, 'BLOCKED')
  })

  test('sandbox candidates never run outside dry-run', async () => {
    const w = await workforce()
    const candidate = await prisma.agent.create({ data: { name: 'c', role: 'r', mission: 'candidate mission', systemPrompt: 'p', modelProvider: 'anthropic', modelName: 'claude-haiku-4-5-20251001', tenantId: w.tenantId, isCandidate: true, config: { contract: BASE_CONTRACT } as Prisma.InputJsonValue } })
    const run = await runAgent(candidate.id, 'do something', { deps: deps(passingLLM()) })
    assert.equal(run.status, 'blocked')
  })
})

describe('manager agent tools', () => {
  test('the manager inspects the workforce and submits a proposal; data comes back wrapped as untrusted', async () => {
    const w = await workforce()
    const llm = scriptedLLM([
      toolUse([{ name: 'platform__list_agents', input: {} }]),
      toolUse([{ name: 'platform__inspect_agent', input: { agentId: w.agentId } }]),
      toolUse([{
        name: 'platform__propose_agent_change',
        input: { changeType: 'update', agentId: w.agentId, rationale: 'Add a duplicate check: recent runs updated duplicate contacts.', changes: { systemPrompt: 'Check duplicates first.' }, addEvaluationCases: [NEW_CASE] },
      }]),
      text('Proposed one revision for the CRM agent.'),
    ])
    const run = await runAgent(w.managerId, 'Weekly workforce review', { deps: deps(llm) })
    assert.equal(run.status, 'completed', run.error)
    assert.deepEqual(run.toolCalls.map((c) => `${c.toolName}:${c.status}`), [
      'platform__list_agents:completed',
      'platform__inspect_agent:completed',
      'platform__propose_agent_change:completed',
    ])
    const offered = llm.calls[0].params.tools!.map((t) => t.name)
    assert.ok(offered.includes('platform__propose_agent_change'))
    assert.ok(!offered.some((n) => /promote|approve|kill|settings/.test(n)), 'no tool can promote, approve or change settings')

    const listResult = JSON.stringify(llm.calls[1].params.messages.at(-1))
    assert.match(listResult, /untrusted_data source=\\"platform:platform__list_agents\\"/)
    const revision = await prisma.agentRevision.findFirstOrThrow({ where: { tenantId: w.tenantId, agentId: w.agentId } })
    assert.equal(revision.status, 'PROPOSED')
    assert.equal(revision.proposedByAgentId, w.managerId)
    assert.equal(revision.proposedByRunId, run.runId)
  })

  test('workers suggest improvements; the manager sees them; nothing is offered when the tenant has not opted in', async () => {
    const w = await workforce()
    const worker = scriptedLLM([
      toolUse([{ name: 'platform__suggest_improvement', input: { suggestion: 'Playbook should say how to handle contacts with two emails.', evidence: 'c3 had two' } }]),
      text('Updated nothing; asked for guidance.'),
    ])
    const run = await runAgent(w.agentId, 'Tidy contact c3', { deps: deps(worker) })
    assert.equal(run.status, 'completed', run.error)
    assert.equal(await prisma.auditLog.count({ where: { tenantId: w.tenantId, action: 'AGENT_IMPROVEMENT_SUGGESTED' } }), 1)
    assert.ok(!worker.calls[0].params.tools!.some((t) => t.name === 'platform__propose_agent_change'), 'workers cannot propose')

    const manager = scriptedLLM([toolUse([{ name: 'platform__inspect_agent', input: { agentId: w.agentId } }]), text('Reviewed.')])
    await runAgent(w.managerId, 'Review', { deps: deps(manager) })
    assert.match(JSON.stringify(manager.calls[1].params.messages.at(-1)), /two emails/)

    const off = await workforce({ enabled: false })
    const llm = scriptedLLM([text('hi')])
    await runAgent(off.managerId, 'Review', { deps: deps(llm) })
    assert.ok(!llm.calls[0].params.tools!.some((t) => t.name.startsWith('platform__list') || t.name === 'platform__propose_agent_change'))
  })

  test('a manager in the recommend stage only describes proposals; dry runs submit nothing', async () => {
    const w = await workforce()
    await prisma.agent.update({ where: { id: w.managerId }, data: { config: { contract: { ...MANAGER_CONTRACT, autonomyStage: 'recommend' } } as Prisma.InputJsonValue } })
    const call = { name: 'platform__propose_agent_change', input: { changeType: 'update', agentId: w.agentId, rationale: 'Add a duplicate check to reduce errors.', changes: { systemPrompt: 'x' } } }
    const run = await runAgent(w.managerId, 'Review', { deps: deps(scriptedLLM([toolUse([call]), text('Recommend: add duplicate check.')])) })
    assert.equal(run.toolCalls[0].status, 'proposed')
    assert.equal(run.proposedActions.length, 1)

    await prisma.agent.update({ where: { id: w.managerId }, data: { config: { contract: MANAGER_CONTRACT } as Prisma.InputJsonValue } })
    const dry = await runAgent(w.managerId, 'Review', { dryRun: true, trigger: 'evaluation', deps: deps(scriptedLLM([toolUse([call]), text('done')])) })
    assert.equal(dry.toolCalls[0].status, 'simulated')
    assert.equal(await prisma.agentRevision.count({ where: { tenantId: w.tenantId } }), 0)
  })
})
