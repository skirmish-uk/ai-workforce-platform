import IORedis from 'ioredis'

let connection: IORedis | null = null

/** Shared Redis connection for all queues/workers. BullMQ requires maxRetriesPerRequest: null. */
export function getRedisConnection(): IORedis {
  if (!connection) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379'
    connection = new IORedis(url, { maxRetriesPerRequest: null })
  }
  return connection
}

export async function pingRedis(): Promise<boolean> {
  try {
    const pong = await getRedisConnection().ping()
    return pong === 'PONG'
  } catch {
    return false
  }
}
