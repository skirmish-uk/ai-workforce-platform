import { Suspense } from 'react'
import { Search, DollarSign, TrendingUp, TrendingDown, Building2, Bot, Server, CreditCard, Calculator } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@ai-workforce/ui'
import { formatCurrency } from '@ai-workforce/ui'

async function getCosts(searchParams: { page?: string; tenantId?: string }) {
  const params = new URLSearchParams()
  if (searchParams.page) params.set('page', searchParams.page)
  if (searchParams.tenantId) params.set('tenantId', searchParams.tenantId)
  
  const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/operator/costs?${params}`, {
    cache: 'no-store',
  })
  if (!res.ok) return null
  return res.json()
}

function StatCard({ title, value, change, icon: Icon, trend }: { title: string; value: string | number; change?: string; icon: React.ComponentType<{ className?: string }>; trend?: 'up' | 'down' }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{title}</CardTitle>
        <Icon className="h-4 w-4 text-neutral-400" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">{value}</div>
        {change && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            <span className={trend === 'up' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
              {trend === 'up' ? <TrendingUp className="w-3 h-3 inline" /> : <TrendingDown className="w-3 h-3 inline" />}
              {change}
            </span>
            vs last period
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function CostsSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {[1, 2, 3, 4].map((i) => (
        <Card key={i}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <div className="h-4 w-24 bg-neutral-200 dark:bg-neutral-800 animate-pulse rounded" />
          </CardHeader>
          <CardContent>
            <div className="h-8 w-32 bg-neutral-200 dark:bg-neutral-800 animate-pulse rounded mb-2" />
            <div className="h-4 w-20 bg-neutral-200 dark:bg-neutral-800 animate-pulse rounded" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export default async function CostsPage({ searchParams }: { searchParams: { page?: string; tenantId?: string } }) {
  const data = await getCosts(searchParams)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">Costs & Billing</h1>
          <p className="text-neutral-500 dark:text-neutral-400 mt-1">Platform costs and revenue overview</p>
        </div>
      </div>

      <Suspense fallback={<CostsSkeleton />}>
        {data && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title="Monthly Revenue"
              value={formatCurrency(data.monthlyRevenue)}
              change={data.revenueChange}
              trend={data.revenueChange?.startsWith('+') ? 'up' : 'down'}
              icon={DollarSign}
            />
            <StatCard
              title="Total Tenants"
              value={data.totalTenants}
              change={data.tenantsChange}
              trend={data.tenantsChange?.startsWith('+') ? 'up' : 'down'}
              icon={Building2}
            />
            <StatCard
              title="Active Agents"
              value={data.activeAgents}
              change={data.agentsChange}
              trend={data.agentsChange?.startsWith('+') ? 'up' : 'down'}
              icon={Bot}
            />
            <StatCard
              title="Running Runtimes"
              value={data.runningRuntimes}
              change={data.runtimesChange}
              trend={data.runtimesChange?.startsWith('+') ? 'up' : 'down'}
              icon={Server}
            />
            <StatCard
              title="Avg Revenue/Tenant"
              value={formatCurrency(data.avgRevenuePerTenant)}
              change={data.avgRevenueChange}
              trend={data.avgRevenueChange?.startsWith('+') ? 'up' : 'down'}
              icon={Calculator}
            />
            <StatCard
              title="Avg Cost/Agent"
              value={formatCurrency(data.avgCostPerAgent)}
              change={data.avgCostChange}
              trend={data.avgCostChange?.startsWith('+') ? 'down' : 'up'}
              icon={CreditCard}
            />
            <StatCard
              title="Total Costs"
              value={formatCurrency(data.totalCosts)}
              change={data.costsChange}
              trend={data.costsChange?.startsWith('+') ? 'down' : 'up'}
              icon={CreditCard}
            />
            <StatCard
              title="Margin"
              value={`${data.margin}%`}
              change={data.marginChange}
              trend={data.marginChange?.startsWith('+') ? 'up' : 'down'}
              icon={TrendingUp}
            />
          </div>
        )}
      </Suspense>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Revenue by Tenant (Top 10)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {data?.topTenantsByRevenue?.map((tenant: any) => (
                <div key={tenant.id} className="flex items-center justify-between p-3 bg-neutral-50 dark:bg-neutral-800/50 rounded-lg">
                  <div>
                    <p className="font-medium text-neutral-900 dark:text-neutral-50">{tenant.name}</p>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">{tenant.slug}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-neutral-900 dark:text-neutral-50">{formatCurrency(tenant.monthlyRevenue)}</p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">{tenant.activeAgents} agents</p>
                  </div>
                </div>
              )) || <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading...</p>}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Costs by Agent Type</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {data?.costsByAgentType?.map((item: any) => (
                <div key={item.role} className="flex items-center justify-between p-3 bg-neutral-50 dark:bg-neutral-800/50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
                      <Bot className="w-4 h-4 text-primary-600 dark:text-primary-400" />
                    </div>
                    <span className="font-medium text-neutral-900 dark:text-neutral-50">{item.role}</span>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-neutral-900 dark:text-neutral-50">{formatCurrency(item.totalCost)}</p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">{item.count} agents</p>
                  </div>
                </div>
              )) || <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading...</p>}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}