import { Suspense } from 'react'
import { Search, Server, MoreVertical, Edit, Trash2, RefreshCw, Play, Pause, Square, AlertTriangle } from 'lucide-react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@ai-workforce/ui'
import { DataTable } from '../../../components/data-table'
import { Badge } from '@ai-workforce/ui'

interface RuntimeRow {
  id: string
  agentId: string
  tenantId: string
  agent: { name: string }
  tenant: { name: string }
  version: number
  status: string
  uptime?: number | null
  costPerMonth?: number | null
  deployedAt?: string | null
}

async function getRuntimes(searchParams: { page?: string; search?: string; tenantId?: string }) {
  const params = new URLSearchParams()
  if (searchParams.page) params.set('page', searchParams.page)
  if (searchParams.search) params.set('search', searchParams.search)
  if (searchParams.tenantId) params.set('tenantId', searchParams.tenantId)
  
  const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/operator/runtimes?${params}`, {
    cache: 'no-store',
  })
  if (!res.ok) return null
  return res.json()
}

function RuntimesSkeleton() {
  return (
    <Card>
      <CardContent className="pt-0">
        <div className="space-y-3">
          <div className="flex items-center gap-4 p-4">
            <div className="h-10 w-10 bg-neutral-200 dark:bg-neutral-800 animate-pulse rounded-lg" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-48 bg-neutral-200 dark:bg-neutral-800 animate-pulse rounded" />
              <div className="h-3 w-64 bg-neutral-200 dark:bg-neutral-800 animate-pulse rounded" />
            </div>
            <div className="h-4 w-24 bg-neutral-200 dark:bg-neutral-800 animate-pulse rounded" />
            <div className="h-4 w-24 bg-neutral-200 dark:bg-neutral-800 animate-pulse rounded" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

const columns = [
  {
    accessorKey: 'agent.name',
    header: 'Agent',
    cell: ({ row }: { row: { original: RuntimeRow; getValue: (key: string) => any } }) => (
      <Link href={`/operator/agents/${row.original.agentId}`} className="font-medium text-neutral-900 dark:text-neutral-50 hover:text-primary-600">
        {row.getValue('agent.name')}
      </Link>
    ),
  },
  {
    accessorKey: 'tenant.name',
    header: 'Tenant',
    cell: ({ row }: { row: { original: RuntimeRow; getValue: (key: string) => any } }) => (
      <Link href={`/operator/tenants/${row.original.tenantId}`} className="text-sm text-primary-600 hover:underline">
        {row.getValue('tenant.name')}
      </Link>
    ),
  },
  {
    accessorKey: 'version',
    header: 'Version',
    cell: ({ row }: { row: { original: RuntimeRow; getValue: (key: string) => any } }) => <code className="text-sm bg-neutral-100 dark:bg-neutral-800 px-2 py-1 rounded">{row.getValue('version')}</code>,
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }: { row: { original: RuntimeRow; getValue: (key: string) => any } }) => {
      const status = row.getValue('status')
      const statusColors: Record<string, 'default' | 'success' | 'warning' | 'danger'> = {
        RUNNING: 'success',
        PENDING: 'warning',
        STOPPED: 'default',
        FAILED: 'danger',
        ROLLING_BACK: 'warning',
      }
      const statusIcons: Record<string, React.ReactNode> = {
        RUNNING: <Play className="w-3 h-3" />,
        PENDING: <RefreshCw className="w-3 h-3 animate-spin" />,
        STOPPED: <Square className="w-3 h-3" />,
        FAILED: <AlertTriangle className="w-3 h-3" />,
        ROLLING_BACK: <RefreshCw className="w-3 h-3 animate-spin" />,
      }
      return (
        <Badge variant={statusColors[status] || 'default'} className="gap-1">
          {statusIcons[status] || null}
          {status}
        </Badge>
      )
    },
  },
  {
    accessorKey: 'uptime',
    header: 'Uptime',
    cell: ({ row }: { row: { original: RuntimeRow; getValue: (key: string) => any } }) => {
      const uptime = row.getValue('uptime')
      if (uptime === null || uptime === undefined) return '-'
      return `${uptime.toFixed(1)}%`
    },
  },
  {
    accessorKey: 'costPerMonth',
    header: 'Cost/Month',
    cell: ({ row }: { row: { original: RuntimeRow; getValue: (key: string) => any } }) => {
      const cost = row.getValue('costPerMonth')
      return cost ? `$${cost.toFixed(2)}` : '-'
    },
  },
  {
    accessorKey: 'deployedAt',
    header: 'Deployed',
    cell: ({ row }: { row: { original: RuntimeRow; getValue: (key: string) => any } }) => {
      const date = row.getValue('deployedAt')
      return date ? new Date(date).toLocaleDateString() : '-'
    },
  },
  {
    accessorKey: 'actions',
    header: '',
    cell: ({ row }: { row: { original: RuntimeRow; getValue: (key: string) => any } }) => (
      <div className="flex items-center gap-2">
        <Link href={`/operator/runtimes/${row.original.id}`} className="p-2 text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300" title="View">
          <Edit className="w-4 h-4" />
        </Link>
      </div>
    ),
  },
]

export default async function RuntimesPage({ searchParams }: { searchParams: { page?: string; search?: string; tenantId?: string } }) {
  const data = await getRuntimes(searchParams)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">Runtimes</h1>
          <p className="text-neutral-500 dark:text-neutral-400 mt-1">Agent deployments across tenants</p>
        </div>
      </div>

      <Suspense fallback={<RuntimesSkeleton />}>
        {data && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>All Runtimes ({data.meta.total})</CardTitle>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
                  <input
                    type="search"
                    placeholder="Search runtimes..."
                    defaultValue={searchParams.search || ''}
                    className="pl-10 pr-4 py-2 w-64 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-sm"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const params = new URLSearchParams(searchParams as any)
                        params.set('search', (e.target as HTMLInputElement).value)
                        params.set('page', '1')
                        window.location.href = `/operator/runtimes?${params.toString()}`
                      }
                    }}
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={columns}
                data={data.runtimes}
                pagination={{
                  page: data.meta.page,
                  pageSize: data.meta.pageSize,
                  total: data.meta.total,
                  totalPages: data.meta.totalPages,
                  onPageChange: (page) => {
                    const params = new URLSearchParams(searchParams as any)
                    params.set('page', page.toString())
                    window.location.href = `/operator/runtimes?${params.toString()}`
                  },
                }}
              />
            </CardContent>
          </Card>
        )}
      </Suspense>
    </div>
  )
}