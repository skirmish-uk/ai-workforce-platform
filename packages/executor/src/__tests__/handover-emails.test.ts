import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '@ai-workforce/db'
import { runAgent } from '../agent'
import { notifyHandovers } from '../notifications/handover-emails'
import type { EmailMessage, Mailer } from '../notifications/mailer'
import { assertTestDatabase, createFixture, deps, scriptedLLM, toolUse, type Fixture } from './helpers'

const fixtures: Fixture[] = []
before(() => assertTestDatabase())
after(async () => {
  for (const f of fixtures) await f.cleanup().catch(() => undefined)
  await prisma.$disconnect()
})

test('a hand-off is emailed once to its destination and the admins; a tool result is in the reasoning chain', async () => {
  const f = await createFixture()
  fixtures.push(f)
  const admin = await prisma.user.create({ data: { email: `admin-${randomUUID().slice(0, 8)}@example.test`, role: 'CUSTOMER_ADMIN', tenantId: f.tenantId } })
  const run = await runAgent(f.agentId, 'Sam wants the liability clause changed before Friday', {
    deps: deps(scriptedLLM([toolUse([{ name: 'platform__escalate', input: { reason: 'Contract terms need a person', severity: 'high' } }], 'This is a contract change.')])),
  })
  assert.equal(run.status, 'escalated')
  assert.equal(run.reasoning?.[0]?.text, 'This is a contract change.')

  const sent: EmailMessage[] = []
  const mailer: Mailer = { description: 'fake', async send(m) { sent.push(m) } }
  await notifyHandovers({ mailer, isDeliverable: () => true, appUrl: 'https://demo.example' })
  const mine = sent.filter((m) => m.to === admin.email || m.to === 'sales-ops@example.test')
  assert.deepEqual(mine.map((m) => m.to).sort(), [admin.email, 'sales-ops@example.test'].sort())
  assert.match(mine[0].subject, /handed you a request: Sam wants the liability clause/)
  assert.match(mine[0].text, /Why: Contract terms need a person/)
  assert.match(mine[0].text, /https:\/\/demo\.example\/dashboard\/approvals#handovers/)

  const again: EmailMessage[] = []
  await notifyHandovers({ mailer: { description: 'fake', async send(m) { again.push(m) } }, isDeliverable: () => true })
  assert.equal(again.filter((m) => m.to === admin.email).length, 0, 'announced once')
})

test('without email configured the hand-off is recorded as skipped, and it stays open in the inbox', async () => {
  const f = await createFixture()
  fixtures.push(f)
  const run = await runAgent(f.agentId, 'Refund this customer', { deps: deps(scriptedLLM([toolUse([{ name: 'platform__escalate', input: { reason: 'Refunds need a person' } }])])) })
  await notifyHandovers({ mailer: null })
  const h = await prisma.handover.findUniqueOrThrow({ where: { runId: run.runId } })
  assert.equal(h.status, 'OPEN')
  assert.ok(h.notifiedAt)
  assert.equal(await prisma.auditLog.count({ where: { entityId: h.id, action: 'HANDOVER_NOTIFICATION_SKIPPED' } }), 1)
})
