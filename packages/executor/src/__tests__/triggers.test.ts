import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '@ai-workforce/db'
import type { Prisma } from '@prisma/client'
import { detectManagerTriggers, findDueManagerReviews, managerReviewInput } from '../workforce/triggers'
import { selfManagementPolicySchema } from '../workforce/policy'
import { BASE_CONTRACT, assertTestDatabase, createAgent, createFixture, type Fixture } from './helpers'

const thresholds = selfManagementPolicySchema.parse({}).autoReview
const quiet = { runs: 20, failureRate: 0.05, qualityFlaggedRuns: 0, approvalsDecided: 10, humanOverrideRate: 0.1, toolCalls: 30, toolErrorRate: 0 }

test('triggers fire on failures, quality flags, rejections, tool errors and rollbacks, once per problem', () => {
  const t = detectManagerTriggers({
    agents: [
      { id: 'a1', name: 'Sarah', metrics: { ...quiet, failureRate: 0.4 } },
      { id: 'a2', name: 'Ava', metrics: { ...quiet, qualityFlaggedRuns: 3, approvalsDecided: 4, humanOverrideRate: 0.75 } },
      { id: 'a3', name: 'Triage', metrics: { ...quiet, toolErrorRate: 0.5 } },
      { id: 'a4', name: 'Quiet', metrics: quiet },
      { id: 'a5', name: 'New', metrics: { ...quiet, runs: 2, failureRate: 1 } },
    ],
    rollbacks: [{ revisionId: 'r1', agentId: 'a4', agentName: 'Quiet', reason: 'failure rate rose' }],
    alreadyFired: new Set(['quality:a2']),
  }, thresholds)
  assert.deepEqual(t.map((x) => x.key).sort(), ['failures:a1', 'rejections:a2', 'rollback:a4', 'tool_errors:a3'])
  assert.match(t.find((x) => x.kind === 'tool_errors')!.detail, /escalate rather than change the agent/)
  assert.match(managerReviewInput(t), /^Automatic repair review/)
})

const fixtures: Fixture[] = []
before(() => assertTestDatabase())
after(async () => {
  for (const f of fixtures) await f.cleanup().catch(() => undefined)
  await prisma.$disconnect()
})

test('due reviews: one combined review per tenant, never the same problem twice, capped per day', async () => {
  const f = await createFixture({ tenantSettings: { selfManagement: { enabled: true, autoReview: { maxPerDay: 1 } } } })
  fixtures.push(f)
  const managerId = await createAgent(f.tenantId, { contract: { ...BASE_CONTRACT, management: { enabled: true } } })
  for (let i = 0; i < 6; i++) {
    await prisma.auditLog.create({ data: { action: i < 3 ? 'AGENT_RUN_FAILED' : 'AGENT_RUN_COMPLETED', entityType: 'Agent', entityId: f.agentId, tenantId: f.tenantId, newData: { status: i < 3 ? 'failed' : 'completed', qualitySignals: i >= 3 ? ['announced_without_action'] : [] } as Prisma.InputJsonValue } })
  }
  const due = (await findDueManagerReviews()).filter((d) => d.tenantId === f.tenantId)
  assert.equal(due.length, 1)
  assert.equal(due[0].managerId, managerId)
  assert.deepEqual(due[0].triggers.map((t) => t.kind).sort(), ['failures', 'quality'])
  assert.equal(await prisma.auditLog.count({ where: { tenantId: f.tenantId, action: 'MANAGER_REVIEW_TRIGGERED' } }), 2)

  // Same problems again: nothing new. A new problem: blocked by the daily cap of 1.
  assert.equal((await findDueManagerReviews()).filter((d) => d.tenantId === f.tenantId).length, 0)
  const other = await createAgent(f.tenantId)
  for (let i = 0; i < 5; i++) await prisma.auditLog.create({ data: { action: 'AGENT_RUN_FAILED', entityType: 'Agent', entityId: other, tenantId: f.tenantId, newData: { status: 'failed' } } })
  assert.equal((await findDueManagerReviews()).filter((d) => d.tenantId === f.tenantId).length, 0)

  // Tenants without self-management are never reviewed.
  const off = await createFixture({ tenantSettings: {} })
  fixtures.push(off)
  await createAgent(off.tenantId, { contract: { ...BASE_CONTRACT, management: { enabled: true } } })
  for (let i = 0; i < 6; i++) await prisma.auditLog.create({ data: { action: 'AGENT_RUN_FAILED', entityType: 'Agent', entityId: off.agentId, tenantId: off.tenantId, newData: { status: 'failed' } } })
  assert.equal((await findDueManagerReviews()).filter((d) => d.tenantId === off.tenantId).length, 0)
})
