import { prisma } from '@ai-workforce/db'
import { z } from 'zod'
import { globalWatchdog } from './watchdog'

export enum AlertSeverity {
  INFO = 'info',
  WARNING = 'warning',
  CRITICAL = 'critical',
}

export enum AlertStatus {
  FIRING = 'firing',
  ACKNOWLEDGED = 'acknowledged',
  RESOLVED = 'resolved',
}

export interface Alert {
  id: string
  name: string
  severity: AlertSeverity
  status: AlertStatus
  message: string
  source: string
  tenantId: string
  labels: Record<string, string>
  annotations: Record<string, string>
  startsAt: Date
}

export const alertRuleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  severity: z.nativeEnum(AlertSeverity),
  condition: z.string(),
  labels: z.record(z.string()).default({}),
  annotations: z.record(z.string()).default({}),
  forDuration: z.string().optional(),
  enabled: z.boolean().default(true),
})

export type AlertRule = z.infer<typeof alertRuleSchema>

const ALERT_LIFECYCLE_ACTIONS = ['ALERT_ACKNOWLEDGED', 'ALERT_RESOLVED']

/** Persists an alert as an AuditLog entry (action ALERT_<SEVERITY>) so it shows up
 *  in GET /api/monitoring?type=alerts, which already reads audit logs this way. */
export async function createAlert(alert: Omit<Alert, 'id' | 'startsAt' | 'status'>): Promise<Alert> {
  const id = `alert_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  const startsAt = new Date()
  const full: Alert = { ...alert, id, startsAt, status: AlertStatus.FIRING }

  try {
    await prisma.auditLog.create({
      data: {
        action: `ALERT_${alert.severity.toUpperCase()}`,
        entityType: 'Alert',
        entityId: id,
        tenantId: alert.tenantId,
        newData: full as never,
      },
    })
  } catch (error) {
    console.error('Failed to persist alert:', error)
  }

  return full
}

export async function getActiveAlerts(tenantId?: string): Promise<Alert[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const logs = await prisma.auditLog.findMany({
    where: {
      action: { startsWith: 'ALERT_' },
      ...(tenantId ? { tenantId } : {}),
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  const resolvedIds = new Set(logs.filter((log) => log.action === 'ALERT_RESOLVED').map((log) => log.entityId))

  return logs
    .filter((log) => !ALERT_LIFECYCLE_ACTIONS.includes(log.action) && !resolvedIds.has(log.entityId))
    .map((log) => ({ ...(log.newData as object), status: AlertStatus.FIRING }) as Alert)
}

export async function acknowledgeAlert(alertId: string, tenantId: string, userId: string): Promise<void> {
  await prisma.auditLog.create({
    data: { action: 'ALERT_ACKNOWLEDGED', entityType: 'Alert', entityId: alertId, tenantId, userId },
  })
}

export async function resolveAlert(alertId: string, tenantId: string): Promise<void> {
  await prisma.auditLog.create({
    data: { action: 'ALERT_RESOLVED', entityType: 'Alert', entityId: alertId, tenantId },
  })
}

/**
 * Evaluates the rules we have real signal for: Watchdog component health
 * (Agent Down / Integration Failure) and recent WorkflowRun failure rate
 * (High Error Rate), per tenant. High Latency / Disk Space Low stay defined
 * in DEFAULT_ALERT_RULES but need an APM/infra metrics source this platform
 * doesn't have yet, so they intentionally don't fire.
 */
export async function evaluateAlertRules(): Promise<Alert[]> {
  const fired: Alert[] = []

  for (const component of globalWatchdog.getAllComponents()) {
    if (component.status !== 'unhealthy') continue
    if (component.type !== 'agent' && component.type !== 'integration') continue

    fired.push(
      await createAlert({
        name: component.type === 'agent' ? 'Agent Down' : 'Integration Failure',
        severity: AlertSeverity.CRITICAL,
        message: `${component.name} is unhealthy after ${component.consecutiveFailures} consecutive failures`,
        source: component.type,
        tenantId: component.tenantId,
        labels: { component: component.type, componentId: component.id },
        annotations: { lastError: component.lastError ?? '' },
      })
    )
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const recentRuns = await prisma.workflowRun.findMany({
    where: { createdAt: { gte: oneHourAgo } },
    select: { status: true, tenantId: true },
  })

  const byTenant = new Map<string, { total: number; failed: number }>()
  for (const run of recentRuns) {
    const bucket = byTenant.get(run.tenantId) ?? { total: 0, failed: 0 }
    bucket.total++
    if (run.status === 'FAILED') bucket.failed++
    byTenant.set(run.tenantId, bucket)
  }

  for (const [tenantId, bucket] of byTenant) {
    if (bucket.total < 10) continue
    const errorRate = bucket.failed / bucket.total
    if (errorRate <= 0.05) continue

    fired.push(
      await createAlert({
        name: 'High Error Rate',
        severity: AlertSeverity.CRITICAL,
        message: `Workflow error rate is ${(errorRate * 100).toFixed(1)}% over the last hour (${bucket.failed}/${bucket.total})`,
        source: 'workflow',
        tenantId,
        labels: { component: 'workflow' },
        annotations: {},
      })
    )
  }

  return fired
}

export const DEFAULT_ALERT_RULES: AlertRule[] = [
  {
    name: 'High Error Rate',
    description: 'Error rate exceeds 5% for 5 minutes',
    severity: AlertSeverity.CRITICAL,
    condition: 'error_rate > 0.05',
    labels: { component: 'workflow' },
    annotations: { summary: 'High workflow error rate detected' },
    forDuration: '5m',
    enabled: true,
  },
  {
    name: 'Agent Down',
    description: 'Agent heartbeat missing for 10 minutes',
    severity: AlertSeverity.CRITICAL,
    condition: 'agent_heartbeat_missing > 10m',
    labels: { component: 'agent' },
    annotations: { summary: 'Agent is not responding' },
    forDuration: '10m',
    enabled: true,
  },
  {
    name: 'High Latency',
    description: 'API latency exceeds 5 seconds',
    severity: AlertSeverity.WARNING,
    condition: 'api_latency_p95 > 5s',
    labels: { component: 'api' },
    annotations: { summary: 'High API latency detected' },
    forDuration: '5m',
    enabled: true,
  },
  {
    name: 'Integration Failure',
    description: 'Integration authentication failed',
    severity: AlertSeverity.CRITICAL,
    condition: 'integration_auth_failed == 1',
    labels: { component: 'integration' },
    annotations: { summary: 'Integration authentication failure' },
    forDuration: '1m',
    enabled: true,
  },
  {
    name: 'Disk Space Low',
    description: 'Disk usage exceeds 85%',
    severity: AlertSeverity.WARNING,
    condition: 'disk_usage_percent > 85',
    labels: { component: 'infrastructure' },
    annotations: { summary: 'Disk space running low' },
    forDuration: '15m',
    enabled: true,
  },
]
