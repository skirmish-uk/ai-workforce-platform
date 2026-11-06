import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '@ai-workforce/db'
import type { Prisma } from '@prisma/client'
import { runAgent } from '../agent'
import { ApprovalError, decideApproval, executeApprovedAction, expireStaleApprovals } from '../approvals'
import { runEvaluation } from '../evaluation'
import { executeWorkflow } from '../workflow'
import { BASE_CONTRACT, assertTestDatabase, createFixture, deps, fakeTools, scriptedLLM, text, toolUse, type Fixture } from './helpers'

const CRM_UPDATE = 'hubspot-crm__update_contact'
const SEND = 'gmail__send_email'

const fixtures: Fixture[] = []
async function fixture(opts: Parameters<typeof createFixture>[0] = {}) {
  const f = await createFixture(opts)
  fixtures.push(f)
  return f
}

before(() => assertTestDatabase())
after(async () => {
  for (const f of fixtures) await f.cleanup().catch(() => undefined)
  await prisma.$disconnect()
})

async function user(tenantId: string, role: 'CUSTOMER_ADMIN' | 'CUSTOMER_STAFF' | 'PLATFORM_OPERATOR') {
  const u = await prisma.user.create({ data: { email: `${role.toLowerCase()}-${Math.random().toString(36).slice(2)}@example.test`, role, tenantId } })
  return { id: u.id, role: u.role, tenantId }
}

async function pendingApproval(f: Fixture, tools = fakeTools()) {
  const llm = scriptedLLM([toolUse([{ name: CRM_UPDATE, input: { id: 'c1', properties: { stage: 'lead' } } }], 'Updating stage.')])
  const run = await runAgent(f.agentId, 'mark lead', { deps: deps(llm, tools) })
  assert.equal(run.status, 'approval_required')
  return run.approvalId!
}

describe('approval decisions', () => {
  test('role, tenant, double-decision and level checks', async () => {
    const f = await fixture({ requiredTools: [CRM_UPDATE], permissions: { [CRM_UPDATE]: 'AUTOMATIC' } })
    const approvalId = await pendingApproval(f)
    const staff = await user(f.tenantId, 'CUSTOMER_STAFF')
    const admin = await user(f.tenantId, 'CUSTOMER_ADMIN')
    const other = await fixture()
    const outsider = await user(other.tenantId, 'CUSTOMER_ADMIN')

    await assert.rejects(decideApproval({ approvalId, decision: 'approve', actor: staff }), (e: ApprovalError) => e.code === 'FORBIDDEN')
    await assert.rejects(decideApproval({ approvalId, decision: 'approve', actor: outsider }), (e: ApprovalError) => e.code === 'NOT_FOUND')
    const decided = await decideApproval({ approvalId, decision: 'approve', actor: admin, reason: 'looks right' })
    assert.equal(decided.status, 'APPROVED')
    await assert.rejects(decideApproval({ approvalId, decision: 'reject', actor: admin }), (e: ApprovalError) => e.code === 'CONFLICT')

    const operatorLevel = await prisma.approval.create({
      data: { action: SEND, level: 'OPERATOR_APPROVAL', tenantId: f.tenantId, agentId: f.agentId, status: 'PENDING', input: { kind: 'tool_call' } },
    })
    await assert.rejects(decideApproval({ approvalId: operatorLevel.id, decision: 'approve', actor: admin }), (e: ApprovalError) => e.code === 'FORBIDDEN')
    const operator = await user(f.tenantId, 'PLATFORM_OPERATOR')
    assert.equal((await decideApproval({ approvalId: operatorLevel.id, decision: 'approve', actor: operator })).status, 'APPROVED')
    assert.equal((await prisma.auditLog.count({ where: { tenantId: f.tenantId, action: 'APPROVAL_GRANTED' } })), 2)
  })

  test('expired approvals cannot be approved and are swept by expireStaleApprovals', async () => {
    const f = await fixture({ requiredTools: [CRM_UPDATE], permissions: { [CRM_UPDATE]: 'AUTOMATIC' } })
    const admin = await user(f.tenantId, 'CUSTOMER_ADMIN')
    const a = await pendingApproval(f)
    const later = new Date(Date.now() + 73 * 3_600_000)
    await assert.rejects(decideApproval({ approvalId: a, decision: 'approve', actor: admin, now: later }), (e: ApprovalError) => e.code === 'EXPIRED')
    assert.equal((await prisma.approval.findUniqueOrThrow({ where: { id: a } })).status, 'EXPIRED')

    const b = await pendingApproval(f)
    await prisma.approval.update({ where: { id: b }, data: { expiresAt: new Date(Date.now() - 1000) } })
    assert.ok((await expireStaleApprovals()) >= 1)
    assert.equal((await prisma.approval.findUniqueOrThrow({ where: { id: b } })).status, 'EXPIRED')
  })

  test('an approved call executes exactly once, with exactly the approved arguments', async () => {
    const f = await fixture({ requiredTools: [CRM_UPDATE], permissions: { [CRM_UPDATE]: 'AUTOMATIC' } })
    const admin = await user(f.tenantId, 'CUSTOMER_ADMIN')
    const approvalId = await pendingApproval(f)
    const tools = fakeTools(() => ({ id: 'c1', properties: { stage: 'lead' }, updatedAt: 'now' }))

    const notYet = await executeApprovedAction(approvalId, { executeTool: tools.executeTool })
    assert.match(notYet.error ?? '', /not APPROVED/)
    assert.equal(tools.executed.length, 0)

    await decideApproval({ approvalId, decision: 'approve', actor: admin })
    const [first, second] = await Promise.all([
      executeApprovedAction(approvalId, { executeTool: tools.executeTool }),
      executeApprovedAction(approvalId, { executeTool: tools.executeTool }),
    ])
    assert.equal(tools.executed.length, 1, 'concurrent duplicate jobs execute once')
    assert.deepEqual(tools.executed[0], { toolName: CRM_UPDATE, input: { id: 'c1', properties: { stage: 'lead' } } })
    const results = [first, second]
    assert.equal(results.filter((r) => r.status === 'EXECUTED').length, 1)
    assert.equal(results.filter((r) => /not APPROVED/.test(r.error ?? '')).length, 1)
    assert.equal((await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } })).status, 'EXECUTED')
  })

  test('policy is re-checked at execution time: a since-prohibited or kill-switched action does not run', async () => {
    const f = await fixture({ requiredTools: [CRM_UPDATE], permissions: { [CRM_UPDATE]: 'AUTOMATIC' } })
    const admin = await user(f.tenantId, 'CUSTOMER_ADMIN')
    const tools = fakeTools()

    const a = await pendingApproval(f)
    await decideApproval({ approvalId: a, decision: 'approve', actor: admin })
    await prisma.agentPermission.updateMany({ where: { agentId: f.agentId, action: CRM_UPDATE }, data: { level: 'PROHIBITED' } })
    const denied = await executeApprovedAction(a, { executeTool: tools.executeTool })
    assert.equal(denied.status, 'EXECUTION_FAILED')
    assert.match(denied.error ?? '', /no longer permits/)

    await prisma.agentPermission.updateMany({ where: { agentId: f.agentId, action: CRM_UPDATE }, data: { level: 'AUTOMATIC' } })
    const b = await pendingApproval(f)
    await decideApproval({ approvalId: b, decision: 'approve', actor: admin })
    await prisma.tenant.update({ where: { id: f.tenantId }, data: { settings: { killSwitch: { agentsDisabled: true } } } })
    assert.equal((await executeApprovedAction(b, { executeTool: tools.executeTool })).status, 'EXECUTION_FAILED')
    assert.equal(tools.executed.length, 0)
  })
})

describe('workflow pause and resume', () => {
  async function workflow(f: Fixture, steps: unknown[]) {
    const wf = await prisma.workflow.create({ data: { name: 'wf', description: 'test workflow', steps: steps as Prisma.InputJsonValue, tenantId: f.tenantId, timeout: 60 } })
    const run = await prisma.workflowRun.create({ data: { workflowId: wf.id, tenantId: f.tenantId, input: { lead: 'Ann' } } })
    return run.id
  }

  test('tool approval inside an agent_task pauses the run, then resumes from the checkpoint without redoing completed steps', async () => {
    const f = await fixture({ requiredTools: [CRM_UPDATE], permissions: { [CRM_UPDATE]: 'AUTOMATIC' } })
    const admin = await user(f.tenantId, 'CUSTOMER_ADMIN')
    const runId = await workflow(f, [
      { id: 'prep', type: 'transform', outputKey: 'greeting', template: 'Hello {{input.lead}}' },
      { id: 'research', type: 'agent_task', agentId: f.agentId, input: 'Research {{input.lead}}', outputKey: 'research' },
      { id: 'update', type: 'agent_task', agentId: f.agentId, input: 'Update CRM for {{input.lead}}' },
    ])
    const tools = fakeTools(() => ({ id: 'c1', properties: { stage: 'lead' }, updatedAt: 'now' }))
    const llm = scriptedLLM([
      text('Ann is a qualified lead.'), // research step
      toolUse([{ name: CRM_UPDATE, input: { id: 'c1', properties: { stage: 'lead' } } }]), // update step → approval
    ])

    const paused = await executeWorkflow(runId, { deps: deps(llm, tools) })
    assert.equal(paused.status, 'approval_required')
    assert.equal((await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } })).status, 'APPROVAL_REQUIRED')
    const approval = await prisma.approval.findFirstOrThrow({ where: { workflowRunId: runId } })
    assert.equal((approval.input as Record<string, unknown>).workflowStepId, 'update')

    // Resuming before a decision is a no-op.
    assert.equal((await executeWorkflow(runId, { deps: deps(llm, tools) })).status, 'approval_required')

    await decideApproval({ approvalId: approval.id, decision: 'approve', actor: admin })
    assert.equal((await executeApprovedAction(approval.id, { executeTool: tools.executeTool })).status, 'EXECUTED')

    const resumeLLM = scriptedLLM([
      (params) => {
        assert.match(String(params.messages[0].content), /\[Platform note\] A human approved hubspot-crm__update_contact/)
        return text('CRM updated after approval.')
      },
    ])
    const resumed = await executeWorkflow(runId, { deps: deps(resumeLLM, tools) })
    assert.equal(resumed.status, 'completed', resumed.error)
    assert.equal(resumeLLM.calls.length, 1, 'the completed research step was not re-run')
    assert.equal(tools.executed.length, 1, 'approved action executed once in total')
    const final = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } })
    assert.equal(final.status, 'COMPLETED')
    assert.equal((final.output as Record<string, unknown>).research, 'Ann is a qualified lead.')

    // A duplicate job on a finished run is a no-op.
    assert.equal((await executeWorkflow(runId, { deps: deps(scriptedLLM([]), tools) })).status, 'completed')
  })

  test('approval steps: approve continues, reject cancels', async () => {
    const f = await fixture()
    const admin = await user(f.tenantId, 'CUSTOMER_ADMIN')
    const steps = [
      { id: 'gate', type: 'approval', action: 'publish_report' },
      { id: 'after', type: 'transform', outputKey: 'done', template: 'yes' },
    ]
    const okRun = await workflow(f, steps)
    assert.equal((await executeWorkflow(okRun)).status, 'approval_required')
    const gate = await prisma.approval.findFirstOrThrow({ where: { workflowRunId: okRun } })
    assert.equal(gate.status, 'PENDING')
    await decideApproval({ approvalId: gate.id, decision: 'approve', actor: admin })
    const resumed = await executeWorkflow(okRun)
    assert.equal(resumed.status, 'completed', resumed.error)
    assert.equal(resumed.output?.done, 'yes')

    const noRun = await workflow(f, steps)
    await executeWorkflow(noRun)
    const gate2 = await prisma.approval.findFirstOrThrow({ where: { workflowRunId: noRun } })
    await decideApproval({ approvalId: gate2.id, decision: 'reject', actor: admin, reason: 'not now' })
    assert.equal((await prisma.workflowRun.findUniqueOrThrow({ where: { id: noRun } })).status, 'CANCELLED')
    assert.equal((await executeWorkflow(noRun)).status, 'cancelled')
  })
})

describe('evaluation runner', () => {
  test('dry-run suite is stored against the agent version and gates limited autonomy', async () => {
    const f = await fixture({
      requiredTools: [CRM_UPDATE, SEND],
      permissions: { [CRM_UPDATE]: 'AUTOMATIC', [SEND]: 'AUTOMATIC' },
      contract: { ...BASE_CONTRACT, autonomyStage: 'limited' },
    })
    const cases = [
      { name: 'normal', input: 'update Ann to lead', expect: { status: 'completed', toolsRequested: [CRM_UPDATE] } },
      { name: 'high-risk send stays gated', category: 'high_risk', input: 'email Ann', expect: { status: 'approval_required', toolsNotExecuted: [SEND] } },
      { name: 'legacy', input: { lead: 'x' }, expected: 'send_follow_up_email' },
    ]
    const tools = fakeTools()
    const crmCall = () => toolUse([{ name: CRM_UPDATE, input: { id: 'c1', properties: { s: 'lead' } } }])
    const sendCall = () => toolUse([{ name: SEND, input: { to: ['ann@example.test'], subject: 's', body: 'b' } }])

    // 1) A bad model run: it sends instead of updating → the "normal" case fails → no evidence.
    const failing = await runEvaluation(f.agentId, { cases, deps: deps(scriptedLLM([sendCall(), sendCall()]), tools) })
    assert.equal(failing.passed, false)
    assert.equal(failing.results.find((r) => r.name === 'legacy')?.assertable, false, 'legacy label-only cases are not counted as passes')
    assert.equal((await prisma.evaluation.findUniqueOrThrow({ where: { id: failing.evaluationId } })).agentVersion, 1)
    const capped = await runAgent(f.agentId, 'update', { deps: deps(scriptedLLM([crmCall()]), tools) })
    assert.equal(capped.stage, 'approval_gated', 'a failing evaluation is not evidence')
    assert.equal(capped.status, 'approval_required')

    // 2) A good run, evaluated at the configured (limited) stage in dry-run → evidence recorded.
    const passing = await runEvaluation(f.agentId, { cases, deps: deps(scriptedLLM([crmCall(), text('Updated Ann.'), sendCall()]), tools) })
    assert.equal(passing.passed, true, JSON.stringify(passing.results))
    assert.equal(tools.executed.length, 0, 'evaluations never execute real tools')

    // 3) Now limited autonomy is in effect for this version: the AUTOMATIC low-risk write runs.
    const live = await runAgent(f.agentId, 'update', { deps: deps(scriptedLLM([crmCall(), text('Updated.')]), tools) })
    assert.equal(live.stage, 'limited')
    assert.equal(live.status, 'completed', live.error)
    assert.equal(tools.executed.length, 1)

    // 4) A material change bumps the version → evidence no longer applies.
    await prisma.agent.update({ where: { id: f.agentId }, data: { version: { increment: 1 } } })
    const after = await runAgent(f.agentId, 'update', { deps: deps(scriptedLLM([crmCall()]), tools) })
    assert.equal(after.stage, 'approval_gated')
  })
})
