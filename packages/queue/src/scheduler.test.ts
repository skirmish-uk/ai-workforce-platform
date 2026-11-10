import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '@ai-workforce/db'
import { getRedisConnection } from './connection'
import { dispatchDueSchedules, type ScheduleWithAgent, type SchedulerDeps } from './scheduler'

after(async () => {
  // queues.ts opens a Redis connection at import time; close it so the test process can exit.
  await getRedisConnection().quit().catch(() => undefined)
  await prisma.$disconnect()
})

const CONTRACT = {
  rationale: 'Daily digest of new leads for the sales team.',
  definitionOfDone: { summary: 'A digest message is produced.' },
  scope: { inScope: ['Lead digest'], outOfScope: ['Contacting leads'] },
  risk: { classification: 'low' },
  owner: { name: 'Ops', contact: 'ops@example.test' },
  escalation: { destination: 'ops@example.test' },
}

function schedule(over: Partial<ScheduleWithAgent> & { contractSchedule?: Record<string, unknown>; status?: ScheduleWithAgent['agent']['status']; config?: unknown } = {}): ScheduleWithAgent {
  return {
    id: over.id ?? 'sched-1',
    name: 'daily',
    cron: over.cron ?? '0 9 * * *',
    timezone: over.timezone ?? 'UTC',
    payload: over.payload ?? { task: 'digest' },
    isActive: true,
    lastRunAt: over.lastRunAt ?? null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    agentId: 'agent-1',
    agent: {
      status: over.status ?? 'PRODUCTION',
      mission: 'Send a daily lead digest.',
      config: (over.config ?? { contract: { ...CONTRACT, ...(over.contractSchedule ? { schedule: over.contractSchedule } : {}) } }) as never,
    },
  }
}

function fakeDeps(rows: ScheduleWithAgent[], inFlight = 0) {
  const enqueued: Array<{ jobId: string; data: unknown }> = []
  const handled: string[] = []
  const deps: SchedulerDeps = {
    findSchedules: async () => rows,
    enqueue: async (data, jobId) => {
      if (!enqueued.some((e) => e.jobId === jobId)) enqueued.push({ jobId, data }) // BullMQ jobId dedupe
    },
    inFlight: async () => inFlight,
    markHandled: async (id) => void handled.push(id),
  }
  return { deps, enqueued, handled }
}

test('fires inside the window, honours timezone, and is idempotent across repeated polls/instances', async () => {
  // Sydney is on AEDT (UTC+11) from 4 Oct 2026, so 09:00 local on 13 Oct is 22:00 UTC on 12 Oct.
  const sydney = schedule({ cron: '0 9 * * *', timezone: 'Australia/Sydney' })
  const { deps, enqueued } = fakeDeps([sydney])
  const at = new Date('2026-10-12T22:00:30Z') // 09:00:30 AEDT on 13 Oct
  assert.equal((await dispatchDueSchedules(at, deps)).dispatched, 1)
  await dispatchDueSchedules(new Date(at.getTime() + 10_000), deps) // second poll / second instance, same minute
  assert.equal(enqueued.length, 1)
  assert.deepEqual(enqueued[0].data, { agentId: 'agent-1', input: JSON.stringify({ task: 'digest' }), trigger: 'schedule', scheduleId: 'sched-1' })

  const utc = fakeDeps([schedule({ cron: '0 9 * * *', timezone: 'UTC' })])
  assert.equal((await dispatchDueSchedules(at, utc.deps)).dispatched, 0, 'same instant is not 09:00 in UTC')
})

test('missed runs are skipped by default and run once when the contract says run_once', async () => {
  const now = new Date('2026-10-10T12:00:00Z') // 09:00 UTC fire was missed (workers were down)
  const lastRunAt = new Date('2026-10-09T09:00:05Z')

  const skipDeps = fakeDeps([schedule({ lastRunAt })])
  const skipped = await dispatchDueSchedules(now, skipDeps.deps)
  assert.equal(skipped.dispatched, 0)
  assert.match(skipped.skipped[0].reason, /missedRunPolicy=skip/)
  assert.deepEqual(skipDeps.handled, ['sched-1'], 'missed fire acknowledged so it is not re-reported every tick')

  const onceDeps = fakeDeps([schedule({ lastRunAt, contractSchedule: { missedRunPolicy: 'run_once' } })])
  assert.equal((await dispatchDueSchedules(now, onceDeps.deps)).dispatched, 1)
  assert.equal((await dispatchDueSchedules(new Date(now.getTime() + 60_000), onceDeps.deps)).dispatched, 1)
  assert.equal(onceDeps.enqueued.length, 1, 'catch-up happens once, not every tick')

  const neverRan = fakeDeps([schedule({ lastRunAt: null, contractSchedule: { missedRunPolicy: 'run_once' } })])
  assert.equal((await dispatchDueSchedules(now, neverRan.deps)).dispatched, 0, 'no history → nothing to catch up')
})

test('concurrency limit applies backpressure; paused agents and invalid contracts are never dispatched', async () => {
  const at = new Date('2026-10-10T09:00:10Z')
  const busy = fakeDeps([schedule()], 1)
  const r = await dispatchDueSchedules(at, busy.deps)
  assert.equal(r.dispatched, 0)
  assert.match(r.skipped[0].reason, /concurrency limit 1/)

  const allowTwo = fakeDeps([schedule({ contractSchedule: { maxConcurrentRuns: 2 } })], 1)
  assert.equal((await dispatchDueSchedules(at, allowTwo.deps)).dispatched, 1)

  const paused = fakeDeps([schedule({ status: 'PAUSED' })])
  assert.match((await dispatchDueSchedules(at, paused.deps)).skipped[0].reason, /PAUSED/)

  const invalid = fakeDeps([schedule({ config: { contract: { nonsense: true } } })])
  assert.match((await dispatchDueSchedules(at, invalid.deps)).skipped[0].reason, /invalid/)
  assert.equal(paused.enqueued.length + invalid.enqueued.length, 0)
})

test('a malformed cron expression is reported, not thrown', async () => {
  const bad = fakeDeps([schedule({ cron: 'every tuesday-ish' })])
  const r = await dispatchDueSchedules(new Date('2026-10-10T09:00:10Z'), bad.deps)
  assert.equal(r.dispatched, 0)
  assert.equal(r.skipped[0].reason, 'evaluation error')
})
