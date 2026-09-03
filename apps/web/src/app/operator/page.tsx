import { Suspense } from 'react'
import { Users, Bot, Server, AlertTriangle, DollarSign, TrendingUp, ClipboardList, ArrowUpRight, ArrowDownRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@ai-workforce/ui'
import { formatCurrency } from '@ai-workforce/ui'

async function getStats() {
  const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/operator/stats`, {
    headers: { 'Content-Type': 'application/json' },
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
              {trend === 'up' ? <ArrowUpRight className="w-3 h-3 inline" /> : <ArrowDownRight className="w-3 h-3 inline" />}
              {change}
            </span>
            vs last period
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function StatsSkeleton() {
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

export default async function OperatorDashboard() {
  const stats = await getStats()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">Operator Console</h1>
          <p className="text-neutral-500 dark:text-neutral-400 mt-1">Platform operations overview</p>
        </div>
      </div>

      <Suspense fallback={<StatsSkeleton />}>
        {stats && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title="Total Tenants"
              value={stats.totalTenants}
              change={stats.tenantsChange}
              trend={stats.tenantsChange?.startsWith('+') ? 'up' : 'down'}
              icon={Users}
            />
            <StatCard
              title="Active Agents"
              value={stats.activeAgents}
              change={stats.agentsChange}
              trend={stats.agentsChange?.startsWith('+') ? 'up' : 'down'}
              icon={Bot}
            />
            <StatCard
              title="Running Runtimes"
              value={stats.runningRuntimes}
              change={stats.runtimesChange}
              trend={stats.runtimesChange?.startsWith('+') ? 'up' : 'down'}
              icon={Server}
            />
            <StatCard
              title="Open Incidents"
              value={stats.openIncidents}
              change={stats.incidentsChange}
              trend={stats.incidentsChange?.startsWith('+') ? 'down' : 'up'}
              icon={AlertTriangle}
            />
            <StatCard
              title="Monthly Revenue"
              value={formatCurrency(stats.monthlyRevenue)}
              change={stats.revenueChange}
              trend={stats.revenueChange?.startsWith('+') ? 'up' : 'down'}
              icon={DollarSign}
            />
            <StatCard
              title="Avg Agent Uptime"
              value={`${stats.avgUptime}%`}
              change={stats.uptimeChange}
              trend={stats.uptimeChange?.startsWith('+') ? 'up' : 'down'}
              icon={TrendingUp}
            />
            <StatCard
              title="Pending Requests"
              value={stats.pendingRequests}
              change={stats.requestsChange}
              trend={stats.requestsChange?.startsWith('+') ? 'down' : 'up'}
              icon={ClipboardList}
            />
            <StatCard
              title="Cost per Agent"
              value={formatCurrency(stats.costPerAgent)}
              change={stats.costChange}
              trend={stats.costChange?.startsWith('+') ? 'down' : 'up'}
              icon={DollarSign}
            />
          </div>
        )}
      </Suspense>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent Incidents</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading incidents...</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Top Tenants by Agent Count</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading tenant data...</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}