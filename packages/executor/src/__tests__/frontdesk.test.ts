import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '@ai-workforce/db'
import { runAgent } from '../agent'
import { validateAgentDefinition } from '../contract'
import { BASE_CONTRACT, assertTestDatabase, createAgent, createFixture, scriptedLLM, text, toolUse, type Fixture } from './helpers'

const fixtures: Fixture[] = []
before(() => assertTestDatabase())
after(async () => {
  for (const f of fixtures) await f.cleanup().catch(() => undefined)
  await prisma.$disconnect()
})

const MANAGER = { ...BASE_CONTRACT, management: { enabled: true }, delegation: { enabled: true, allowedSpecialists: ['*'], maxDepth: 1 } }

test('front desk: a manager routes work to the right agent on the team and reports the outcome', async () => {
  const f = await createFixture({ tenantSettings: { selfManagement: { enabled: true } } })
  fixtures.push(f)
  const managerId = await createAgent(f.tenantId, { contract: MANAGER })
  const otherManager = await createAgent(f.tenantId, { contract: { ...BASE_CONTRACT, management: { enabled: true } } })
  const paused = await createAgent(f.tenantId, { status: 'PAUSED' })

  const llm = scriptedLLM([
    (params) => {
      const delegate = params.tools!.find((t) => t.name === 'platform__delegate')!
      const ids = (delegate.inputSchema as { properties: { specialistAgentId: { enum: string[] } } }).properties.specialistAgentId.enum
      assert.deepEqual(ids, [f.agentId], 'the whole team, minus itself, other managers and paused agents')
      assert.ok(!ids.includes(otherManager) && !ids.includes(paused))
      return toolUse([{ name: 'platform__delegate', input: { specialistAgentId: f.agentId, task: 'Find Ann in the CRM and summarise.' } }])
    },
    text('Ann is a customer since 2024.'), // the specialist's answer
    text('Routed to the CRM agent: Ann is a customer since 2024.'), // the manager's report
  ])
  const run = await runAgent(managerId, 'Who is Ann?', { deps: { createClient: llm.createClient, sleep: async () => undefined } })
  assert.equal(run.status, 'completed', run.error)
  assert.equal(run.childRuns.length, 1)
  assert.equal(run.childRuns[0].agentId, f.agentId)
  assert.match(run.output ?? '', /Routed to the CRM agent/)
})

test('"*" is only for managers: an ordinary agent gets no team-wide delegation and fails validation', async () => {
  const f = await createFixture()
  fixtures.push(f)
  const contract = { ...BASE_CONTRACT, delegation: { enabled: true, allowedSpecialists: ['*'] } }
  const worker = await createAgent(f.tenantId, { contract })
  const llm = scriptedLLM([text('ok')])
  await runAgent(worker, 'hi', { deps: { createClient: llm.createClient, sleep: async () => undefined } })
  assert.ok(!llm.calls[0].params.tools!.some((t) => t.name === 'platform__delegate'))
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: worker } })
  assert.match(validateAgentDefinition(agent, []).errors.join(), /only allowed for a manager agent/)
})
