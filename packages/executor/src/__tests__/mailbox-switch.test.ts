import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '@ai-workforce/db'
import { switchMailboxTools } from '../mailbox-switch'
import { assertTestDatabase, BASE_CONTRACT, createAgent, createFixture, type Fixture } from './helpers'

const fixtures: Fixture[] = []
before(() => assertTestDatabase())
after(async () => {
  for (const f of fixtures) await f.cleanup().catch(() => undefined)
  await prisma.$disconnect()
})

const TRIAGE_CONTRACT = { ...BASE_CONTRACT, allowedTools: ['gmail__list_emails', 'gmail__modify_labels'], autonomyStage: 'limited' }

test("switching a tenant to its IMAP mailbox renames the agents' Gmail tools everywhere, as a new version", async () => {
  const f = await createFixture({
    contract: TRIAGE_CONTRACT,
    requiredTools: ['gmail__list_emails', 'gmail__modify_labels'],
    permissions: { gmail__modify_labels: 'NOTIFY', 'hubspot-crm__create_contact': 'AUTOMATIC' },
    evaluationCases: [{ name: 'mixed inbox', input: 'Triage', toolFixtures: { gmail__list_emails: { messages: [] } }, expect: { toolsNotExecuted: ['gmail__send_email'] } }],
  })
  fixtures.push(f)
  await prisma.skill.updateMany({ where: { tenantId: f.tenantId }, data: { instructions: 'Read the inbox with gmail__list_emails (query "is:unread"), then label each with gmail__modify_labels.' } })
  await prisma.approvalPolicy.create({ data: { name: 'Sending', action: 'gmail__send_email', agentId: f.agentId, notifyEmails: [] } })
  const crmOnly = await createAgent(f.tenantId, { requiredTools: ['hubspot-crm__search_contacts'] })

  // Not connected yet: a preview works, applying refuses.
  const preview = await switchMailboxTools({ tenantId: f.tenantId, to: 'email', apply: false })
  assert.equal(preview.applied, false)
  assert.equal(preview.unchanged, 1, 'the CRM-only agent has nothing to change')
  assert.deepEqual(preview.agents.map((a) => a.tools), [['gmail__list_emails -> email__list_emails', 'gmail__modify_labels -> email__modify_labels', 'gmail__send_email -> email__send_email']])
  await assert.rejects(switchMailboxTools({ tenantId: f.tenantId, to: 'email', apply: true }), /Connect a mailbox/)
  assert.equal((await prisma.agent.findUniqueOrThrow({ where: { id: f.agentId } })).version, 1, 'a preview changes nothing')

  await prisma.integration.create({ data: { name: 'Email', provider: 'imap', tenantId: f.tenantId, credentials: { encrypted: true }, config: { sandbox: true } } })
  const done = await switchMailboxTools({ tenantId: f.tenantId, to: 'email', apply: true })
  assert.equal(done.applied, true)

  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: f.agentId }, include: { skills: { include: { skill: true } }, permissions: true, approvalPolicies: true } })
  assert.equal(agent.version, 2, 'a new version: limited autonomy waits for passing tests again')
  assert.deepEqual((agent.config as { contract: { allowedTools: string[] } }).contract.allowedTools, ['email__list_emails', 'email__modify_labels'])
  const skill = agent.skills[0].skill
  assert.deepEqual(skill.requiredTools, ['email__list_emails', 'email__modify_labels'])
  assert.match(skill.instructions, /email__list_emails \(query "is:unread"\).*email__modify_labels/)
  assert.doesNotMatch(JSON.stringify(skill.evaluationCases), /gmail__/)
  assert.deepEqual(agent.permissions.map((p) => p.action).sort(), ['email__modify_labels', 'hubspot-crm__create_contact'])
  assert.equal(agent.permissions.find((p) => p.action === 'email__modify_labels')?.level, 'NOTIFY', 'permission levels are kept')
  assert.deepEqual(agent.approvalPolicies.map((p) => p.action), ['email__send_email'])
  assert.equal((await prisma.agent.findUniqueOrThrow({ where: { id: crmOnly } })).version, 1)
  const audit = await prisma.auditLog.findMany({ where: { tenantId: f.tenantId, action: 'AGENT_MAILBOX_SWITCHED' } })
  assert.equal(audit.length, 1)

  // Running it again finds nothing to do; switching back restores Gmail names.
  assert.equal((await switchMailboxTools({ tenantId: f.tenantId, to: 'email', apply: true })).agents.length, 0)
  await prisma.integration.create({ data: { name: 'Gmail', provider: 'google', tenantId: f.tenantId, credentials: { encrypted: true }, config: { sandbox: true } } })
  await switchMailboxTools({ tenantId: f.tenantId, to: 'gmail', apply: true })
  const back = await prisma.skill.findFirstOrThrow({ where: { tenantId: f.tenantId, requiredTools: { has: 'gmail__list_emails' } } })
  assert.deepEqual(back.requiredTools, ['gmail__list_emails', 'gmail__modify_labels'])
})

test('an agent using a tool only IMAP mailboxes have is left on IMAP, with the reason', async () => {
  const f = await createFixture({ requiredTools: ['email__list_emails', 'email__move_email'] })
  fixtures.push(f)
  const preview = await switchMailboxTools({ tenantId: f.tenantId, to: 'gmail', apply: false })
  assert.match(preview.agents[0].skipped ?? '', /no gmail__move_email/)
})

test('a playbook shared with other businesses is never changed for one of them', async () => {
  const f = await createFixture({ requiredTools: ['hubspot-crm__search_contacts'] })
  fixtures.push(f)
  const shared = await prisma.skill.create({ data: { name: `shared-${f.tenantId}`, version: '1.0.0', description: 'Shared', purpose: 'Shared playbook', instructions: 'Use gmail__send_email.', requiredTools: ['gmail__send_email'], tenantId: null } })
  try {
    await prisma.agentSkill.create({ data: { agentId: f.agentId, skillId: shared.id, enabled: true } })
    await prisma.integration.create({ data: { name: 'Email', provider: 'imap', tenantId: f.tenantId, credentials: { encrypted: true }, config: { sandbox: true } } })
    const done = await switchMailboxTools({ tenantId: f.tenantId, to: 'email', apply: true })
    assert.match(done.agents[0].skipped ?? '', /shared with other businesses/)
    assert.deepEqual((await prisma.skill.findUniqueOrThrow({ where: { id: shared.id } })).requiredTools, ['gmail__send_email'])
  } finally {
    await prisma.skill.delete({ where: { id: shared.id } })
  }
})
