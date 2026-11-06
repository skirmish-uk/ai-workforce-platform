import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { evaluateAlertRules, getActiveAlerts, getComponentHealth, runHealthChecks } from '@ai-workforce/monitoring'
import { getAgentRunMetrics } from '@ai-workforce/executor'
import { UserRole } from '@prisma/client'

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const type = searchParams.get('type') || 'health'
    const tenantId = session.user.tenantId
    const userRole = session.user.role as UserRole

    if (!hasPermission(userRole, 'monitoring:read')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (!canAccessTenant(userRole, session.user.tenantId, tenantId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    switch (type) {
      case 'health': {
        const result = await runHealthChecks()
        return NextResponse.json(result, { status: result.status === 'unhealthy' ? 503 : 200 })
      }

      case 'alerts': {
        // Evaluate rules on read so this stays current without a separate cron process for the demo;
        // the worker process (packages/queue) additionally runs Watchdog checks continuously.
        await evaluateAlertRules()
        const alerts = await getActiveAlerts(tenantId)
        return NextResponse.json({ alerts })
      }

      case 'agent-runs': {
        // Brief §13 run metrics (completion/failure/DoD/escalation/override rates, latency, cost per
        // successful run, tool errors, denials, duplicates) from the AuditLog trail.
        const isPlatform = userRole === 'PLATFORM_ADMIN' || userRole === 'PLATFORM_OPERATOR'
        const scopeTenant = isPlatform && searchParams.get('tenantId') ? searchParams.get('tenantId')! : tenantId
        const days = Math.min(Math.max(Number(searchParams.get('days') ?? 7) || 7, 1), 90)
        const metrics = await getAgentRunMetrics({
          tenantId: scopeTenant,
          agentId: searchParams.get('agentId') ?? undefined,
          since: new Date(Date.now() - days * 86_400_000),
        })
        return NextResponse.json(metrics)
      }

      case 'metrics': {
        const [activeAgents, workflowsLastHour] = await Promise.all([
          prisma.agent.count({ where: { tenantId, status: 'PRODUCTION' } }),
          prisma.workflowRun.count({ where: { tenantId, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } } }),
        ])

        return NextResponse.json({
          timestamp: new Date(),
          // No APM/infra metrics collector is wired up yet; these stay at 0 rather than faking data.
          system: { cpuUsagePercent: 0, memoryUsagePercent: 0, diskUsagePercent: 0 },
          application: { requestsPerSecond: 0, errorRate: 0, avgLatencyMs: 0 },
          business: {
            activeTenants: userRole === 'PLATFORM_ADMIN' || userRole === 'PLATFORM_OPERATOR' ? await prisma.tenant.count() : 1,
            activeAgents,
            workflowsPerHour: workflowsLastHour,
          },
        })
      }

      case 'components': {
        const agents = await prisma.agent.findMany({
          where: { tenantId, isCandidate: false },
          select: { id: true, name: true, status: true, updatedAt: true },
        })
        const watchdogHealth = await getComponentHealth(tenantId)

        return NextResponse.json({
          components: agents.map((agent) => ({
            ...agent,
            runtime: watchdogHealth.find((c) => c.component === agent.name) ?? null,
          })),
        })
      }

      default:
        return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
    }
  } catch (error) {
    console.error('Monitoring API error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}