import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
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
        // Run health checks
        const dbStart = Date.now()
        try {
          await prisma.$queryRaw`SELECT 1`
          return NextResponse.json({
            status: 'healthy',
            timestamp: new Date(),
            checks: [
              { name: 'database', status: 'healthy', latencyMs: Date.now() - dbStart },
            ],
          })
        } catch {
          return NextResponse.json({
            status: 'unhealthy',
            timestamp: new Date(),
            checks: [
              { name: 'database', status: 'unhealthy', latencyMs: Date.now() - dbStart },
            ],
          }, { status: 503 })
        }
      }

      case 'alerts': {
        // Get active alerts
        const auditLogs = await prisma.auditLog.findMany({
          where: {
            tenantId,
            action: { startsWith: 'ALERT_' },
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        })

        return NextResponse.json({ alerts: auditLogs })
      }

      case 'metrics': {
        // Get system metrics
        // In a real implementation, this would query a metrics database
        return NextResponse.json({
          timestamp: new Date(),
          system: {
            cpuUsagePercent: 0,
            memoryUsagePercent: 0,
            diskUsagePercent: 0,
          },
          application: {
            requestsPerSecond: 0,
            errorRate: 0,
            avgLatencyMs: 0,
          },
          business: {
            activeTenants: 0,
            activeAgents: 0,
            workflowsPerHour: 0,
          },
        })
      }

      case 'components': {
        // Get component health status
        const components = await prisma.agent.findMany({
          where: { tenantId },
          select: {
            id: true,
            name: true,
            status: true,
            updatedAt: true,
          },
        })

        return NextResponse.json({ components })
      }

      default:
        return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
    }
  } catch (error) {
    console.error('Monitoring API error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}