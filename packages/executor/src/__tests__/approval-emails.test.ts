import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '@ai-workforce/db'
import type { ApprovalLevel, Prisma, UserRole } from '@prisma/client'
import {
  APPROVAL_NOTIFICATION_ACTIONS,
  composeApprovalEmail,
  describeAction,
  notifyPendingApprovals,
  readApprovalNotificationSettings,
} from '../notifications/approval-emails'
import { isDeliverableAddress, mailerConfigFromEnv, type EmailMessage, type Mailer } from '../notifications/mailer'
import { assertTestDatabase, auditRows, createFixture, type Fixture } from './helpers'

const fixtures: Fixture[] = []
async function fixture(tenantSettings: Record<string, unknown> = {}) {
  const f = await createFixture({ tenantSettings })
  fixtures.push(f)
  return f
}

before(() => assertTestDatabase())
after(async () => {
  for (const f of fixtures) await f.cleanup().catch(() => undefined)
  await prisma.$disconnect()
})

function fakeMailer(failFor: string[] = []): Mailer & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = []
  return {
    description: 'fake',
    sent,
    async send(message) {
      if (failFor.includes(message.to)) throw new Error('550 mailbox unavailable')
      sent.push(message)
    },
  }
}

const everyone = () => true

async function user(tenantId: string, role: UserRole, email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`) {
  return prisma.user.create({ data: { email, role, tenantId } })
}

async function approval(f: Fixture, over: { level?: ApprovalLevel; action?: string; createdAt?: Date; expiresAt?: Date | null; target?: string } = {}) {
  const action = over.action ?? 'gmail__send_email'
  return prisma.approval.create({
    data: {
      tenantId: f.tenantId,
      agentId: f.agentId,
      action,
      level: over.level ?? 'CUSTOMER_APPROVAL',
      status: 'PENDING',
      expiresAt: over.expiresAt === undefined ? new Date(Date.now() + 24 * 3_600_000) : over.expiresAt,
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
      input: {
        kind: 'tool_call',
        toolName: action,
        arguments: { to: 'client@acme.co', body: 'CONFIDENTIAL QUOTE 4,200' },
        summary: {
          action,
          target: over.target ?? 'Gmail',
          riskClass: 'external_communication',
          sideEffects: 'Sends an email',
          material: { to: 'client@acme.co', body: 'CONFIDENTIAL QUOTE 4,200' },
          rationale: 'Following up on <b>yesterday</b> call',
          policyReason: 'Customer approval required',
          evidence: {},
        },
      } as Prisma.InputJsonObject,
    },
  })
}

async function notifiedAt(id: string) {
  return (await prisma.approval.findUniqueOrThrow({ where: { id } })).notifiedAt
}

describe('approval email sweep', () => {
  test('emails each approver once with a digest, never the content, and never twice', async () => {
    const f = await fixture()
    const admin = await user(f.tenantId, 'CUSTOMER_ADMIN')
    await user(f.tenantId, 'CUSTOMER_STAFF')
    const first = await approval(f)
    const second = await approval(f, { action: 'hubspot-crm__update_contact', target: 'HubSpot CRM' })
    const mailer = fakeMailer()

    const result = await notifyPendingApprovals({ mailer, isDeliverable: everyone, appUrl: 'https://demo.example/' })
    const mine = mailer.sent.filter((m) => m.to === admin.email)
    assert.equal(mine.length, 1, 'one digest for the admin')
    assert.equal(mailer.sent.filter((m) => m.to.startsWith('customer_staff')).length, 0, 'staff cannot approve, so is not emailed')
    assert.ok(result.emailsSent >= 1)
    const email = mine[0]
    assert.match(email.subject, /^2 actions are waiting for your approval in Test /)
    assert.match(email.text, /Gmail: send email/)
    assert.match(email.text, /HubSpot CRM: update contact/)
    assert.match(email.text, /Review and decide: https:\/\/demo\.example\/dashboard\/approvals/)
    assert.doesNotMatch(email.text + email.html, /CONFIDENTIAL QUOTE|client@acme\.co/, 'the material content stays in the dashboard')
    assert.match(email.html, /Following up on &lt;b&gt;yesterday&lt;\/b&gt; call/, 'HTML is escaped')

    assert.ok(await notifiedAt(first.id))
    assert.ok(await notifiedAt(second.id))
    const sent = await auditRows(f.tenantId, APPROVAL_NOTIFICATION_ACTIONS.sent)
    assert.equal(sent.length, 2)
    assert.deepEqual((sent[0].newData as { emailed: string[] }).emailed, [admin.email])

    const again = fakeMailer()
    await notifyPendingApprovals({ mailer: again, isDeliverable: everyone })
    assert.equal(again.sent.filter((m) => m.to === admin.email).length, 0, 'already announced')
  })

  test('operator-level approvals go to the platform team; policy addresses are added', async () => {
    const f = await fixture()
    const admin = await user(f.tenantId, 'CUSTOMER_ADMIN')
    const operator = await user(f.tenantId, 'PLATFORM_OPERATOR')
    await prisma.approvalPolicy.create({ data: { agentId: f.agentId, name: 'Escalations', action: 'gmail__send_email', notifyEmails: ['owner@agency.example.org'] } })
    await approval(f, { level: 'OPERATOR_APPROVAL' })
    const mailer = fakeMailer()

    await notifyPendingApprovals({ mailer, isDeliverable: everyone })
    const recipients = mailer.sent.map((m) => m.to)
    assert.ok(recipients.includes(operator.email))
    assert.ok(recipients.includes('owner@agency.example.org'))
    assert.ok(!recipients.includes(admin.email), 'a customer admin cannot decide an operator-level approval')
  })

  test('no mailer: recorded as skipped with who would have been emailed', async () => {
    const f = await fixture()
    const admin = await user(f.tenantId, 'CUSTOMER_ADMIN')
    const a = await approval(f)
    await notifyPendingApprovals({ mailer: null, isDeliverable: everyone })
    assert.ok(await notifiedAt(a.id))
    const [row] = await auditRows(f.tenantId, APPROVAL_NOTIFICATION_ACTIONS.skipped)
    assert.deepEqual((row.newData as { wouldEmail: string[] }).wouldEmail, [admin.email])
  })

  test('tenant opt-out and reserved addresses are respected', async () => {
    const off = await fixture({ notifications: { approvalEmails: false } })
    await user(off.tenantId, 'CUSTOMER_ADMIN')
    await approval(off)
    const demo = await fixture()
    await user(demo.tenantId, 'CUSTOMER_ADMIN', `admin-${randomUUID().slice(0, 6)}@demo-agency.local`)
    await approval(demo)
    const mailer = fakeMailer()

    await notifyPendingApprovals({ mailer })
    const [offRow] = await auditRows(off.tenantId, APPROVAL_NOTIFICATION_ACTIONS.skipped)
    assert.match(String((offRow.newData as { reason: string }).reason), /turned off/)
    const [demoRow] = await auditRows(demo.tenantId, APPROVAL_NOTIFICATION_ACTIONS.skipped)
    assert.match(String((demoRow.newData as { reason: string }).reason), /nobody to email/)
    assert.equal((demoRow.newData as { notMailed: string[] }).notMailed.length, 1)
    assert.equal(mailer.sent.filter((m) => m.to.endsWith('.local')).length, 0)
  })

  test('a failed send is audited, and old or expired approvals are not announced', async () => {
    const f = await fixture()
    const admin = await user(f.tenantId, 'CUSTOMER_ADMIN')
    const fresh = await approval(f)
    const old = await approval(f, { createdAt: new Date(Date.now() - 48 * 3_600_000) })
    const expired = await approval(f, { expiresAt: new Date(Date.now() - 60_000) })

    await notifyPendingApprovals({ mailer: fakeMailer([admin.email]), isDeliverable: everyone })
    const [failed] = await auditRows(f.tenantId, APPROVAL_NOTIFICATION_ACTIONS.failed)
    assert.equal((failed.newData as { approvalId: string }).approvalId, fresh.id)
    assert.match(JSON.stringify(failed.newData), /550 mailbox unavailable/)
    assert.equal(await notifiedAt(old.id), null)
    assert.equal(await notifiedAt(expired.id), null)
  })
})

describe('approval email helpers', () => {
  test('deliverable addresses', () => {
    assert.ok(isDeliverableAddress('ops@agency.com.au'))
    for (const bad of ['admin@demo-agency.local', 'x@example.test', 'a@example.com', 'a@sub.example.org', 'not-an-email', 'a@b', 'a b@c.com']) {
      assert.equal(isDeliverableAddress(bad), false, bad)
    }
  })

  test('action labels and settings', () => {
    assert.equal(describeAction('gmail__send_email'), 'Gmail: send email')
    assert.equal(describeAction('google-calendar__create_event'), 'Google Calendar: create event')
    assert.equal(describeAction('agent_revision'), 'Agent revision')
    assert.deepEqual(readApprovalNotificationSettings({}), { enabled: true, extraRecipients: [] })
    assert.deepEqual(readApprovalNotificationSettings({ notifications: { approvalEmails: false, approvalRecipients: ['a@b.co', 3] } }), { enabled: false, extraRecipients: ['a@b.co'] })
  })

  test('subject has no line breaks; expiry shown in the tenant time zone', () => {
    const email = composeApprovalEmail({
      to: 'a@b.co',
      tenantName: 'Acme',
      url: 'https://x.co/dashboard/approvals',
      tenantSettings: { timeZone: 'Australia/Sydney' },
      items: [{ agentName: 'Riley\r\nBcc: evil@x.co', label: 'Gmail: send email', target: 'Gmail', risk: 'external_communication', rationale: null, sandbox: true, expiresAt: new Date('2026-10-15T10:00:00Z') }],
    })
    assert.doesNotMatch(email.subject, /[\r\n]/)
    assert.match(email.text, /Expires: Thursday 15 October 2026, 21:00 \(Australia\/Sydney, UTC\+11:00\)/)
    assert.match(email.text, /Sandbox: fictional data/)
  })

  test('SMTP settings', () => {
    assert.equal(mailerConfigFromEnv({}), null)
    assert.throws(() => mailerConfigFromEnv({ SMTP_HOST: 'smtp.x.co' }), /EMAIL_FROM/)
    assert.deepEqual(mailerConfigFromEnv({ SMTP_HOST: 'smtp.x.co', SMTP_PORT: '465', SMTP_USER: 'me@x.co', SMTP_PASSWORD: 'pw' }), {
      host: 'smtp.x.co', port: 465, secure: true, user: 'me@x.co', password: 'pw', from: 'me@x.co',
    })
    assert.equal(mailerConfigFromEnv({ SMTP_HOST: 'smtp.x.co', EMAIL_FROM: 'AI <n@x.co>' })!.secure, false)
  })
})
