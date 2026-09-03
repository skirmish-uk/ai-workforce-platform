import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@ai-workforce/db'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user || !['PLATFORM_ADMIN', 'PLATFORM_OPERATOR'].includes(session.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const now = new Date()
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    const [
      totalTenants,
      activeAgents,
      runningRuntimes,
      openIncidents,
      monthlyRevenue,
      avgUptime,
      pendingRequests,
      costPerAgent,
      tenantsLastMonth,
      agentsLastMonth,
      runtimesLastMonth,
      incidentsLastMonth,
      revenueLastMonth,
      uptimeLastMonth,
      requestsLastMonth,
      costLastMonth,
    ] = await Promise.all([
      prisma.tenant.count(),
      prisma.agent.count({ where: { status: 'PRODUCTION' } }),
      prisma.deployment.count({ where: { status: 'RUNNING' } }),
      prisma.incident.count({ where: { status: { in: ['OPEN', 'INVESTIGATING', 'IDENTIFIED'] } } }),
      prisma.invoice.aggregate({
        where: { status: 'PAID', createdAt: { gte: thisMonth } },
        _sum: { amount: true },
      }),
      prisma.deployment.aggregate({
        where: { status: 'RUNNING' },
        _avg: { uptime: true },
      }),
      prisma.changeRequest.count({ where: { status: 'BACKLOG' } }),
      prisma.deployment.aggregate({
        _avg: { costPerMonth: true },
      }),
      prisma.tenant.count({ where: { createdAt: { gte: lastMonth, lt: thisMonth } } }),
      prisma.agent.count({ where: { status: 'PRODUCTION', createdAt: { gte: lastMonth, lt: thisMonth } } }),
      prisma.deployment.count({ where: { status: 'RUNNING', createdAt: { gte: lastMonth, lt: thisMonth } } }),
      prisma.incident.count({ where: { status: { in: ['OPEN', 'INVESTIGATING', 'IDENTIFIED'] }, createdAt: { gte: lastMonth, lt: thisMonth } } }),
      prisma.invoice.aggregate({
        where: { status: 'PAID', createdAt: { gte: lastMonth, lt: thisMonth } },
        _sum: { amount: true },
      }),
      prisma.deployment.aggregate({
        where: { status: 'RUNNING', createdAt: { gte: lastMonth, lt: thisMonth } },
        _avg: { uptime: true },
      }),
      prisma.changeRequest.count({ where: { status: 'BACKLOG', createdAt: { gte: lastMonth, lt: thisMonth } } }),
      prisma.deployment.aggregate({
        where: { createdAt: { gte: lastMonth, lt: thisMonth } },
        _avg: { costPerMonth: true },
      }),
    ])

    const calcChange = (current: number, previous: number) => {
      if (previous === 0) return current > 0 ? '+100%' : '0%'
      const change = ((current - previous) / previous) * 100
      return `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`
    }

    return NextResponse.json({
      totalTenants,
      activeAgents,
      runningRuntimes,
      openIncidents,
      monthlyRevenue: monthlyRevenue._sum.amount || 0,
      avgUptime: Math.round(avgUptime._avg.uptime || 0),
      pendingRequests,
      costPerAgent: Math.round(costPerAgent._avg.costPerMonth || 0),
      tenantsChange: calcChange(totalTenants, tenantsLastMonth),
      agentsChange: calcChange(activeAgents, agentsLastMonth),
      runtimesChange: calcChange(runningRuntimes, runtimesLastMonth),
      incidentsChange: calcChange(openIncidents, incidentsLastMonth),
      revenueChange: calcChange(monthlyRevenue._sum.amount || 0, revenueLastMonth._sum.amount || 0),
      uptimeChange: calcChange(Math.round(avgUptime._avg.uptime || 0), Math.round(uptimeLastMonth._avg.uptime || 0)),
      requestsChange: calcChange(pendingRequests, requestsLastMonth),
      costChange: calcChange(Math.round(costPerAgent._avg.costPerMonth || 0), Math.round(costLastMonth._avg.costPerMonth || 0)),
    })
  } catch (error) {
    console.error('Operator stats error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}