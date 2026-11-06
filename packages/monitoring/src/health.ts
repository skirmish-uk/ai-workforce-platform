import { prisma } from '@ai-workforce/db'
import IORedis from 'ioredis'
import { globalWatchdog } from './watchdog'

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy'
  timestamp: Date
  checks: HealthCheck[]
}

export interface HealthCheck {
  name: string
  status: 'healthy' | 'degraded' | 'unhealthy'
  latencyMs?: number
  message?: string
  details?: Record<string, unknown>
}

export interface ComponentHealth {
  component: string
  status: 'healthy' | 'degraded' | 'unhealthy'
  lastCheck: Date
  uptimeSeconds?: number
  errorRate?: number
  avgLatencyMs?: number
}

async function checkDatabase(): Promise<HealthCheck> {
  const start = Date.now()
  try {
    await prisma.$queryRaw`SELECT 1`
    return { name: 'database', status: 'healthy', latencyMs: Date.now() - start, message: 'Database connection successful' }
  } catch (error) {
    return {
      name: 'database',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      message: error instanceof Error ? error.message : 'Database connection failed',
    }
  }
}

/** Ephemeral, short-timeout client so a down Redis can't hang a health check. */
/** The worker process writes this every 30 s (start-workers.ts); nothing runs without the worker. */
export const WORKER_HEARTBEAT_KEY = 'worker:heartbeat'
export const WORKER_HEARTBEAT_EVERY_MS = 30_000
/** No heartbeat for this long: the worker is down (missed about four beats). */
const WORKER_STALE_MS = 150_000

export function workerCheck(lastBeat: string | null, now = Date.now()): HealthCheck {
  const age = lastBeat ? now - Number(lastBeat) : null
  if (age === null || !Number.isFinite(age)) return { name: 'worker', status: 'unhealthy', message: 'No worker heartbeat: agent runs, schedules and approvals will not execute' }
  if (age > WORKER_STALE_MS) return { name: 'worker', status: 'unhealthy', message: `No worker heartbeat for ${Math.round(age / 1000)} s: agent runs will not execute` }
  return { name: 'worker', status: 'healthy', message: `Worker heartbeat ${Math.round(age / 1000)} s ago` }
}

async function checkRedis(): Promise<HealthCheck[]> {
  const start = Date.now()
  const client = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 2000,
  })

  try {
    await client.connect()
    const pong = await client.ping()
    const redis: HealthCheck = {
      name: 'redis',
      status: pong === 'PONG' ? 'healthy' : 'degraded',
      latencyMs: Date.now() - start,
      message: 'Redis connection successful',
    }
    return [redis, workerCheck(await client.get(WORKER_HEARTBEAT_KEY))]
  } catch (error) {
    return [
      {
        name: 'redis',
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        message: error instanceof Error ? error.message : 'Redis connection failed',
      },
      { name: 'worker', status: 'unhealthy', message: 'Unknown: Redis is unreachable' },
    ]
  } finally {
    client.disconnect()
  }
}

export async function runHealthChecks(): Promise<HealthCheckResult> {
  const checks = (await Promise.all([checkDatabase(), checkRedis()])).flat()

  const hasUnhealthy = checks.some((c) => c.status === 'unhealthy')
  const hasDegraded = checks.some((c) => c.status === 'degraded')

  return {
    status: hasUnhealthy ? 'unhealthy' : hasDegraded ? 'degraded' : 'healthy',
    timestamp: new Date(),
    checks,
  }
}

export async function getComponentHealth(tenantId: string): Promise<ComponentHealth[]> {
  return globalWatchdog.getComponentsByTenant(tenantId).map((component) => ({
    component: component.name,
    status: component.status === 'unknown' ? 'degraded' : component.status,
    lastCheck: component.lastHeartbeat,
    errorRate: component.consecutiveFailures > 0 ? component.consecutiveFailures : undefined,
  }))
}

export async function recordHealthCheck(
  component: string,
  status: 'healthy' | 'degraded' | 'unhealthy',
  latencyMs?: number,
  message?: string
): Promise<void> {
  try {
    // Health checks are cross-tenant infra signals with nowhere natural to live in a
    // tenant-scoped AuditLog; attribute them to the platform tenant, or skip if absent.
    const platformTenant = await prisma.tenant.findFirst({ where: { slug: 'platform' } })
    if (!platformTenant) return

    await prisma.auditLog.create({
      data: {
        action: 'HEALTH_CHECK',
        entityType: 'Component',
        entityId: component,
        tenantId: platformTenant.id,
        metadata: { status, latencyMs, message } as never,
      },
    })
  } catch (error) {
    console.error('Failed to record health check:', error)
  }
}
