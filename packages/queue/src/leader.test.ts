import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getRedisConnection } from './connection'
import { holdLead, releaseLead } from './leader'

const redis = getRedisConnection()
after(() => redis.disconnect())

test('one worker leads the scheduler tick; another takes over when it stops or dies', async () => {
  const key = `test:scheduler:leader:${randomUUID()}`
  assert.equal(await holdLead(redis, 'worker-a', 5_000, key), true, 'the first to ask leads')
  assert.equal(await holdLead(redis, 'worker-b', 5_000, key), false, 'a second worker stands by')
  assert.equal(await holdLead(redis, 'worker-a', 5_000, key), true, 'the leader keeps the lead each tick')

  await releaseLead(redis, 'worker-b', key)
  assert.equal(await holdLead(redis, 'worker-b', 5_000, key), false, 'only the leader can give the lead up')

  await releaseLead(redis, 'worker-a', key)
  assert.equal(await holdLead(redis, 'worker-b', 5_000, key), true, 'a stopped leader is replaced at once')

  // A leader that dies without letting go: its lead runs out.
  assert.equal(await holdLead(redis, 'worker-b', 150, key), true)
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(await holdLead(redis, 'worker-c', 5_000, key), true, 'an expired lead is taken over')
  await redis.del(key)
})
