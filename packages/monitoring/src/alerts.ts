import { prisma } from '@ai-workforce/db'
import { z } from 'zod'

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
  tenantId?: string
  labels: Record<string, string>
  annotations: Record<string, string>
  startsAt: Date
  endsAt?: Date
  acknowledgedAt?: Date
  acknowledgedBy?: string
  resolvedAt?: Date
}

export const alertRuleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  severity: z.nativeEnum(AlertSeverity),
  condition: z.string(), // PromQL-like expression or custom logic
  labels: z.record(z.string()).default({}),
  annotations: z.record(z.string()).default({}),
  forDuration: z.string().optional(), // e.g., '5m'
  enabled: z.boolean().default(true),
})

export type AlertRule = z.infer<typeof alertRuleSchema>

export async function createAlert(alert: Omit<Alert, 'id' | 'startsAt'>): Promise<Alert> {
  const id = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  const startsAt = new Date()

  // Store in database (would need an alerts table)
  // For now, return the alert object
  return { ...alert, id, startsAt } as Alert
}

export async function getActiveAlerts(tenantId?: string): Promise<Alert[]> {
  // Query active alerts from database
  // Filter by tenantId if provided
  return []
}

export async function acknowledgeAlert(alertId: string, userId: string): Promise<void> {
  // Update alert status to acknowledged
}

export async function resolveAlert(alertId: string): Promise<void> {
  // Update alert status to resolved
}

export async function evaluateAlertRules(): Promise<void> {
  // Evaluate all alert rules against current metrics
  // This would run periodically (e.g., every minute)
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