import { prisma } from '@ai-workforce/db'

export interface WatchdogConfig {
  checkIntervalMs: number
  heartbeatTimeoutMs: number
  maxConsecutiveFailures: number
  alertOnFailure: boolean
}

export interface ComponentStatus {
  id: string
  name: string
  type: 'agent' | 'integration' | 'workflow' | 'runtime'
  tenantId: string
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  lastHeartbeat: Date
  consecutiveFailures: number
  lastError?: string
  metadata?: Record<string, unknown>
}

export interface WatchdogEvent {
  type: 'heartbeat_missed' | 'recovered' | 'failure' | 'recovery'
  componentId: string
  componentName: string
  tenantId: string
  timestamp: Date
  message: string
  severity: 'info' | 'warning' | 'critical'
}

export class Watchdog {
  private config: WatchdogConfig
  private components: Map<string, ComponentStatus> = new Map()
  private intervals: Map<string, NodeJS.Timeout> = new Map()
  private eventHandlers: Array<(event: WatchdogEvent) => void> = []

  constructor(config: Partial<WatchdogConfig> = {}) {
    this.config = {
      checkIntervalMs: config.checkIntervalMs || 60000, // 1 minute
      heartbeatTimeoutMs: config.heartbeatTimeoutMs || 300000, // 5 minutes
      maxConsecutiveFailures: config.maxConsecutiveFailures || 3,
      alertOnFailure: config.alertOnFailure !== false,
    }
  }

  registerComponent(component: Omit<ComponentStatus, 'consecutiveFailures'>): void {
    this.components.set(component.id, {
      ...component,
      consecutiveFailures: 0,
    })
  }

  unregisterComponent(componentId: string): void {
    this.components.delete(componentId)
    const interval = this.intervals.get(componentId)
    if (interval) {
      clearInterval(interval)
      this.intervals.delete(componentId)
    }
  }

  recordHeartbeat(componentId: string, metadata?: Record<string, unknown>): void {
    const component = this.components.get(componentId)
    if (!component) return

    component.lastHeartbeat = new Date()
    component.consecutiveFailures = 0
    component.status = 'healthy'
    if (metadata) component.metadata = { ...component.metadata, ...metadata }

    this.emitEvent({
      type: 'recovered',
      componentId,
      componentName: component.name,
      tenantId: component.tenantId,
      timestamp: new Date(),
      message: `Component ${component.name} recovered`,
      severity: 'info',
    })
  }

  recordFailure(componentId: string, error: Error | string): void {
    const component = this.components.get(componentId)
    if (!component) return

    component.consecutiveFailures++
    component.lastError = error instanceof Error ? error.message : error

    if (component.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      component.status = 'unhealthy'
      this.emitEvent({
        type: 'failure',
        componentId,
        componentName: component.name,
        tenantId: component.tenantId,
        timestamp: new Date(),
        message: `Component ${component.name} failed after ${component.consecutiveFailures} consecutive failures`,
        severity: 'critical',
      })
    } else {
      component.status = 'degraded'
      this.emitEvent({
        type: 'failure',
        componentId,
        componentName: component.name,
        tenantId: component.tenantId,
        timestamp: new Date(),
        message: `Component ${component.name} failed (${component.consecutiveFailures}/${this.config.maxConsecutiveFailures})`,
        severity: 'warning',
      })
    }
  }

  startMonitoring(): void {
    // Load components from database and start monitoring
    this.startCheckInterval()
  }

  stopMonitoring(): void {
    for (const interval of this.intervals.values()) {
      clearInterval(interval)
    }
    this.intervals.clear()
  }

  private startCheckInterval(): void {
    const interval = setInterval(() => this.checkComponents(), this.config.checkIntervalMs)
    this.intervals.set('main', interval)
  }

  private async checkComponents(): Promise<void> {
    const now = new Date()

    for (const [id, component] of this.components) {
      const timeSinceHeartbeat = now.getTime() - component.lastHeartbeat.getTime()

      if (timeSinceHeartbeat > this.config.heartbeatTimeoutMs) {
        if (component.status !== 'unhealthy') {
          component.status = 'unhealthy'
          this.emitEvent({
            type: 'heartbeat_missed',
            componentId: id,
            componentName: component.name,
            tenantId: component.tenantId,
            timestamp: now,
            message: `Component ${component.name} missed heartbeat (${Math.round(timeSinceHeartbeat / 1000)}s ago)`,
            severity: 'critical',
          })
        }
      }
    }
  }

  onEvent(handler: (event: WatchdogEvent) => void): void {
    this.eventHandlers.push(handler)
  }

  private emitEvent(event: WatchdogEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (error) {
        console.error('Watchdog event handler error:', error)
      }
    }

    // Also store in database for audit trail
    this.storeEvent(event).catch(console.error)
  }

  private async storeEvent(event: WatchdogEvent): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          action: `WATCHDOG_${event.type.toUpperCase()}`,
          entityType: 'Component',
          entityId: event.componentId,
          tenantId: event.tenantId,
          metadata: {
            componentName: event.componentName,
            message: event.message,
            severity: event.severity,
          },
        },
      })
    } catch (error) {
      console.error('Failed to store watchdog event:', error)
    }
  }

  getComponentStatus(componentId: string): ComponentStatus | undefined {
    return this.components.get(componentId)
  }

  getAllComponents(): ComponentStatus[] {
    return Array.from(this.components.values())
  }

  getComponentsByTenant(tenantId: string): ComponentStatus[] {
    return Array.from(this.components.values()).filter(c => c.tenantId === tenantId)
  }
}

export const globalWatchdog = new Watchdog()

// Convenience functions for common component types
export function registerAgent(agentId: string, name: string, tenantId: string): void {
  globalWatchdog.registerComponent({
    id: `agent_${agentId}`,
    name,
    type: 'agent',
    tenantId,
    status: 'unknown',
    lastHeartbeat: new Date(),
  })
}

export function registerIntegration(integrationId: string, name: string, tenantId: string): void {
  globalWatchdog.registerComponent({
    id: `integration_${integrationId}`,
    name,
    type: 'integration',
    tenantId,
    status: 'unknown',
    lastHeartbeat: new Date(),
  })
}

export function agentHeartbeat(agentId: string, metadata?: Record<string, unknown>): void {
  globalWatchdog.recordHeartbeat(`agent_${agentId}`, metadata)
}

export function agentFailure(agentId: string, error: Error | string): void {
  globalWatchdog.recordFailure(`agent_${agentId}`, error)
}

export function integrationHeartbeat(integrationId: string, metadata?: Record<string, unknown>): void {
  globalWatchdog.recordHeartbeat(`integration_${integrationId}`, metadata)
}

export function integrationFailure(integrationId: string, error: Error | string): void {
  globalWatchdog.recordFailure(`integration_${integrationId}`, error)
}