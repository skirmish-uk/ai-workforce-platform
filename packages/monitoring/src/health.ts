import { prisma } from '@ai-workforce/db'

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

export async function runHealthChecks(): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []
  const startTime = Date.now()

  // Database check
  const dbStart = Date.now()
  try {
    await prisma.$queryRaw`SELECT 1`
    checks.push({
      name: 'database',
      status: 'healthy',
      latencyMs: Date.now() - dbStart,
      message: 'Database connection successful',
    })
  } catch (error) {
    checks.push({
      name: 'database',
      status: 'unhealthy',
      latencyMs: Date.now() - dbStart,
      message: error instanceof Error ? error.message : 'Database connection failed',
    })
  }

  // Redis check (if configured)
  // TODO: Add Redis health check when BullMQ is implemented

  // Overall status
  const hasUnhealthy = checks.some(c => c.status === 'unhealthy')
  const hasDegraded = checks.some(c => c.status === 'degraded')

  return {
    status: hasUnhealthy ? 'unhealthy' : hasDegraded ? 'degraded' : 'healthy',
    timestamp: new Date(),
    checks,
  }
}

export async function getComponentHealth(tenantId: string): Promise<ComponentHealth[]> {
  // Get health for tenant-specific components
  // This would check agent runtime, integrations, etc.
  return []
}

export async function recordHealthCheck(
  component: string,
  status: 'healthy' | 'degraded' | 'unhealthy',
  latencyMs?: number,
  message?: string
): Promise<void> {
  // Store health check result for historical tracking
  // This would be stored in a health_checks table
}