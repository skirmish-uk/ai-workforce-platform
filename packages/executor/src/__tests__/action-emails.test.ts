import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '@ai-workforce/db'
import type { ApprovalLevel } from '@prisma/client'
import { runAgent } from '../agent'
import { ACTION_NOTIFICATION_KIND, composeActionEmail, notifyAgentActions } from '../notifications/action-emails'
import type { EmailMessage, Mailer } from '../notifications/mailer'
import { BASE_CONTRACT, assertTestDatabase, createFixture, deps, fakeTools, scriptedLLM, text, toolUse, type Fixture } from './helpers'

const CRM_UPDATE = 'hubspot-crm__update_contact'

const fixtures: Fixture[] = []
before(() => assertTestDatabase())
after(async () => {
  for (const f of fixtures) await f.cleanup().catch(() => undefined)
  await prisma.$disconnect()
})

function fakeMailer(): Mailer & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = []
  return { description: 'fake', sent, async send(m) { sent.push(m) } }
}
const everyone = () => true

/** A limited-stage agent (with the evaluation evidence that unlocks it) whose CRM update runs at `level`. */
async function agentAt(level: ApprovalLevel, tenantSettings: Record<string, unknown> = {}) {
  const f = await createFixture({ requiredTools: [CRM_UPDATE], permissions: { [CRM_UPDATE]: level }, contract: { ...BASE_CONTRACT, autonomyStage: 'limited' }, tenantSettings })
  fixtures.push(f)
  await prisma.evaluation.create({ data: { agentId: f.agentId, name: 'evidence', agentVersion: 1, passed: true, score: 1 } })
  const admin = await prisma.user.create({ data: { email: `admin-${randomUUID().slice(0, 8)}@example.test`, role: 'CUSTOMER_ADMIN', tenantId: f.tenantId } })
  return { ...f, admin }
}

async function updateContact(f: Fixture, options: { dryRun?: boolean } = {}) {
  const llm = scriptedLLM([toolUse([{ name: CRM_UPDATE, input: { id: `c-${randomUUID().slice(0, 6)}`, properties: { stage: 'lead', note: 'SECRET NOTE' } } }]), text('Updated.')])
  const run = await runAgent(f.agentId, 'mark lead', { deps: deps(llm, fakeTools()), ...options })
  assert.equal(run.status, 'completed', run.error)
  return run
}

describe('NOTIFY-level action emails', () => {
  test('an action that ran at NOTIFY is emailed to the admins once, without its content', async () => {
    const f = await agentAt('NOTIFY')
    await updateContact(f)
    const mailer = fakeMailer()

    const result = await notifyAgentActions({ mailer, isDeliverable: everyone, appUrl: 'https://demo.example' })
    const mine = mailer.sent.filter((m) => m.to === f.admin.email)
    assert.equal(mine.length, 1)
    assert.ok(result.emailsSent >= 1)
    assert.match(mine[0].subject, / did: HubSpot CRM: update contact$/)
    assert.match(mine[0].text, /Result: done/)
    assert.match(mine[0].text, new RegExp(`https://demo\\.example/dashboard/agents/${f.agentId}`))
    assert.doesNotMatch(mine[0].text + mine[0].html, /SECRET NOTE/)

    const [row] = await prisma.notification.findMany({ where: { tenantId: f.tenantId, kind: ACTION_NOTIFICATION_KIND } })
    assert.equal(row.status, 'SENT')
    assert.deepEqual((row.detail as { emailed: string[] }).emailed, [f.admin.email])

    const again = fakeMailer()
    await notifyAgentActions({ mailer: again, isDeliverable: everyone })
    assert.equal(again.sent.filter((m) => m.to === f.admin.email).length, 0, 'announced once')
  })

  test('AUTOMATIC actions and dry runs are not emailed', async () => {
    const auto = await agentAt('AUTOMATIC')
    await updateContact(auto)
    const dry = await agentAt('NOTIFY')
    await updateContact(dry, { dryRun: true })
    const mailer = fakeMailer()

    await notifyAgentActions({ mailer, isDeliverable: everyone })
    assert.equal(mailer.sent.filter((m) => m.to === auto.admin.email || m.to === dry.admin.email).length, 0)
    assert.equal(await prisma.notification.count({ where: { tenantId: { in: [auto.tenantId, dry.tenantId] } } }), 0)
  })

  test('tenant opt-out, and no mailer: recorded as skipped', async () => {
    const off = await agentAt('NOTIFY', { notifications: { actionEmails: false } })
    await updateContact(off)
    const noMail = await agentAt('NOTIFY')
    await updateContact(noMail)

    await notifyAgentActions({ mailer: null, isDeliverable: everyone })
    const [offRow] = await prisma.notification.findMany({ where: { tenantId: off.tenantId } })
    assert.equal(offRow.status, 'SKIPPED')
    assert.match(String((offRow.detail as { reason: string }).reason), /turned off/)
    const [noMailRow] = await prisma.notification.findMany({ where: { tenantId: noMail.tenantId } })
    assert.equal(noMailRow.status, 'SKIPPED')
    assert.deepEqual((noMailRow.detail as { wouldEmail: string[] }).wouldEmail, [noMail.admin.email])
  })

  test('digest wording for several agents and sandbox results', () => {
    const at = new Date('2026-10-15T01:00:00Z')
    const email = composeActionEmail({
      to: 'a@b.co',
      tenantName: 'Acme',
      url: 'https://x.co/dashboard/agents',
      tenantSettings: { timeZone: 'Australia/Sydney' },
      items: [
        { agentName: 'Riley', label: 'Google Calendar: create event', at, sandbox: true },
        { agentName: 'Casey', label: 'HubSpot CRM: update contact', at, sandbox: false },
      ],
    })
    assert.equal(email.subject, 'Your agents took 2 actions in Acme')
    assert.match(email.text, /Agent: Riley/)
    assert.match(email.text, /Result: simulated on a sandbox connection/)
    assert.match(email.text, /When: Thursday 15 October 2026, 12:00 \(Australia\/Sydney, UTC\+11:00\)/)
  })
})
