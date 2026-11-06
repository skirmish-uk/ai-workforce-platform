import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'

/**
 * One leader among the worker processes for the scheduler tick (scheduled runs, approval and
 * hand-over emails, task and revision dispatch, the revision watch, repair reviews), so a second
 * worker doesn't do all of it twice. The leader holds a Redis key that expires and renews it on
 * every tick; if it dies, another worker takes over once the key expires.
 */
export const SCHEDULER_LEADER_KEY = 'scheduler:leader'

const RENEW = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

/** This process's identity as a candidate leader. */
export const processLeaderId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`

/** Takes the lead if nobody holds it, or keeps it for another `ttlMs` if we do. */
export async function holdLead(redis: Redis, id: string, ttlMs: number, key = SCHEDULER_LEADER_KEY): Promise<boolean> {
  if ((await redis.set(key, id, 'PX', ttlMs, 'NX')) === 'OK') return true
  return (await redis.eval(RENEW, 1, key, id, String(ttlMs))) === 1
}

/** Gives the lead up (on shutdown), so another worker takes over at its next tick. */
export async function releaseLead(redis: Redis, id: string, key = SCHEDULER_LEADER_KEY): Promise<void> {
  await redis.eval(RELEASE, 1, key, id)
}
