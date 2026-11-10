import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '@ai-workforce/db'
import { runAgent } from '../agent'
import { decideApproval, executeApprovedAction } from '../approvals'
import { assertTestDatabase, createFixture, scriptedLLM, toolUse, type Fixture } from './helpers'

const SEARCH = 'hubspot-crm__search_contacts'
const SEND = 'gmail__send_email'
const fixtures: Fixture[] = []
before(() => assertTestDatabase())
after(async () => {
  for (const f of fixtures) await f.cleanup().catch(() => undefined)
  await prisma.$disconnect()
})

test('sandbox connections: look-ups return fictional data and approved actions are simulated, never sent', async () => {
  const f = await createFixture({ requiredTools: [SEARCH, SEND], permissions: { [SEND]: 'CUSTOMER_APPROVAL' } })
  fixtures.push(f)
  await prisma.integration.createMany({
    data: [
      { name: 'HubSpot CRM', provider: 'hubspot', tenantId: f.tenantId, credentials: { encrypted: true }, config: { sandbox: true } },
      { name: 'Gmail', provider: 'google', tenantId: f.tenantId, credentials: { encrypted: true }, config: { sandbox: true } },
    ],
  })
  // No executeTool override: this goes through the real connection lookup.
  const llm = scriptedLLM([
    toolUse([{ name: SEARCH, input: { query: 'Priya' } }]),
    (params) => {
      const lastResult = JSON.stringify(params.messages.at(-1))
      assert.match(lastResult, /Harbour Dental/, 'the model sees the sandbox contact')
      assert.match(lastResult, /Sandbox connection/, 'and is told it is sandbox data')
      return toolUse([{ name: SEND, input: { to: ['priya@harbourdental.example'], subject: 'Your website refresh', body: 'Hi Priya, could we book a call?' } }])
    },
  ])
  const run = await runAgent(f.agentId, 'Follow up with Priya', { deps: { createClient: llm.createClient, sleep: async () => undefined } })
  assert.deepEqual(run.toolCalls.map((c) => `${c.toolName}:${c.status}`), [`${SEARCH}:simulated`, `${SEND}:approval_required`])

  const admin = await prisma.user.create({ data: { email: `admin-${f.tenantId}@example.test`, role: 'CUSTOMER_ADMIN', tenantId: f.tenantId } })
  await decideApproval({ approvalId: run.approvalId!, decision: 'approve', actor: { id: admin.id, role: admin.role, tenantId: f.tenantId } })
  const executed = await executeApprovedAction(run.approvalId!)
  assert.equal(executed.status, 'EXECUTED', executed.error)
  assert.equal((executed.output as { sandbox?: boolean }).sandbox, true)
  assert.match(String((executed.output as { result?: string }).result), /would have been sent/)

  const realCalls = await prisma.auditLog.count({ where: { tenantId: f.tenantId, action: 'AGENT_TOOL_CALL' } })
  assert.equal(realCalls, 0, 'nothing is ever recorded as a real tool call')
  assert.equal(await prisma.auditLog.count({ where: { tenantId: f.tenantId, action: 'AGENT_TOOL_CALL_SIMULATED' } }), 2)
})
