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
async function checkRedis(): Promise<HealthCheck> {
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
    return {
      name: 'redis',
      status: pong === 'PONG' ? 'healthy' : 'degraded',
      latencyMs: Date.now() - start,
      message: 'Redis connection successful',
    }
  } catch (error) {
    return {
      name: 'redis',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      message: error instanceof Error ? error.message : 'Redis connection failed',
    }
  } finally {
    client.disconnect()
  }
}

export async function runHealthChecks(): Promise<HealthCheckResult> {
  const checks = await Promise.all([checkDatabase(), checkRedis()])

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
