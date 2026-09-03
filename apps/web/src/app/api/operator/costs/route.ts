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

    const searchParams = request.nextUrl.searchParams
    const tenantId = searchParams.get('tenantId') || undefined

    const now = new Date()
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    const [
      totalTenants,
      activeAgents,
      runningRuntimes,
      monthlyRevenue,
      totalCosts,
      avgRevenuePerTenant,
      avgCostPerAgent,
      margin,
      tenantsLastMonth,
      agentsLastMonth,
      runtimesLastMonth,
      revenueLastMonth,
      costsLastMonth,
      marginLastMonth,
      topTenantsByRevenue,
    ] = await Promise.all([
      prisma.tenant.count(),
      prisma.agent.count({ where: { status: 'PRODUCTION' } }),
      prisma.deployment.count({ where: { status: 'RUNNING' } }),
      prisma.invoice.aggregate({
        where: { status: 'PAID', createdAt: { gte: thisMonth } },
        _sum: { amount: true },
      }),
      prisma.deployment.aggregate({
        _sum: { costPerMonth: true },
      }),
      prisma.tenant.count(),
      prisma.deployment.aggregate({
        where: { status: 'RUNNING' },
        _avg: { costPerMonth: true },
      }),
      prisma.$queryRaw`SELECT 
        CASE 
          WHEN COALESCE(SUM(i.amount), 0) > 0 
          THEN ROUND(((COALESCE(SUM(i.amount), 0) - COALESCE(SUM(d.cost_per_month), 0)) / COALESCE(SUM(i.amount), 0)) * 100, 1)
          ELSE 0 
        END as margin
      FROM "Invoice" i
      FULL OUTER JOIN "Deployment" d ON d.status = 'RUNNING'
      WHERE i.status = 'PAID' AND i."createdAt" >= ${thisMonth}`,
      prisma.tenant.count({ where: { createdAt: { gte: lastMonth, lt: thisMonth } } }),
      prisma.agent.count({ where: { status: 'PRODUCTION', createdAt: { gte: lastMonth, lt: thisMonth } } }),
      prisma.deployment.count({ where: { status: 'RUNNING', createdAt: { gte: lastMonth, lt: thisMonth } } }),
      prisma.invoice.aggregate({
        where: { status: 'PAID', createdAt: { gte: lastMonth, lt: thisMonth } },
        _sum: { amount: true },
      }),
      prisma.deployment.aggregate({
        where: { createdAt: { gte: lastMonth, lt: thisMonth } },
        _sum: { costPerMonth: true },
      }),
      prisma.$queryRaw`SELECT 
        CASE 
          WHEN COALESCE(SUM(i.amount), 0) > 0 
          THEN ROUND(((COALESCE(SUM(i.amount), 0) - COALESCE(SUM(d.cost_per_month), 0)) / COALESCE(SUM(i.amount), 0)) * 100, 1)
          ELSE 0 
        END as margin
      FROM "Invoice" i
      FULL OUTER JOIN "Deployment" d ON d.status = 'RUNNING'
      WHERE i.status = 'PAID' AND i."createdAt" >= ${lastMonth} AND i."createdAt" < ${thisMonth}`,
      prisma.tenant.findMany({
        include: {
          subscriptions: { select: { status: true, plan: true }, take: 1, orderBy: { createdAt: 'desc' } },
          _count: { select: { agents: true } },
          invoices: {
            where: { status: 'PAID', createdAt: { gte: thisMonth } },
            select: { amount: true },
            orderBy: { createdAt: 'desc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
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
      monthlyRevenue: monthlyRevenue._sum.amount || 0,
      totalCosts: totalCosts._sum.costPerMonth || 0,
      avgRevenuePerTenant: totalTenants > 0 ? Math.round((monthlyRevenue._sum.amount || 0) / totalTenants) : 0,
      avgCostPerAgent: Math.round(avgCostPerAgent._avg.costPerMonth || 0),
      margin: Number((margin as any)[0]?.margin || 0),
      topTenantsByRevenue: (topTenantsByRevenue as any).map((t: any) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        monthlyRevenue: t.invoices[0]?.amount || 0,
        activeAgents: t._count.agents,
      })),
      tenantsChange: calcChange(totalTenants, tenantsLastMonth),
      agentsChange: calcChange(activeAgents, agentsLastMonth),
      runtimesChange: calcChange(runningRuntimes, runtimesLastMonth),
      revenueChange: calcChange(monthlyRevenue._sum.amount || 0, revenueLastMonth._sum.amount || 0),
      costsChange: calcChange(totalCosts._sum.costPerMonth || 0, costsLastMonth._sum.costPerMonth || 0),
      marginChange: calcChange(Number((margin as any)[0]?.margin || 0), Number((marginLastMonth as any)[0]?.margin || 0)),
    })
  } catch (error) {
    console.error('Operator costs error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}