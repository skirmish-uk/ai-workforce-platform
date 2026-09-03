import { Suspense } from 'react'
import { Search, Bot, Zap, Brain, MoreVertical, Edit, Trash2, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@ai-workforce/ui'
import { DataTable } from '../../../components/data-table'
import { Badge } from '@ai-workforce/ui'

async function getAgents(searchParams: { page?: string; search?: string; tenantId?: string }) {
  const params = new URLSearchParams()
  if (searchParams.page) params.set('page', searchParams.page)
  if (searchParams.search) params.set('search', searchParams.search)
  if (searchParams.tenantId) params.set('tenantId', searchParams.tenantId)
  
  const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/operator/agents?${params}`, {
    cache: 'no-store',
  })
  if (!res.ok) return null
  return res.json()
}

function AgentsSkeleton() {
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

interface AgentRow {
  id: string
  name: string
  description: string
  tenantId: string
  tenant: { name: string }
  status: string
  _count: { deployments: number; skills: number }
  updatedAt: string
}

const columns = [
  {
    accessorKey: 'name',
    header: 'Agent',
    cell: ({ row }: { row: { original: AgentRow; getValue: (key: string) => any } }) => (
      <div>
        <Link href={`/operator/agents/${row.original.id}`} className="font-medium text-neutral-900 dark:text-neutral-50 hover:text-primary-600">
          {row.getValue('name')}
        </Link>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{row.getValue('description')}</p>
      </div>
    ),
  },
  {
    accessorKey: 'tenant.name',
    header: 'Tenant',
    cell: ({ row }: { row: { original: AgentRow; getValue: (key: string) => any } }) => (
      <Link href={`/operator/tenants/${row.original.tenantId}`} className="text-sm text-primary-600 hover:underline">
        {row.getValue('tenant.name')}
      </Link>
    ),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }: { row: { original: AgentRow; getValue: (key: string) => any } }) => {
      const status = row.getValue('status')
      const statusColors: Record<string, 'default' | 'success' | 'warning' | 'danger'> = {
        PRODUCTION: 'success',
        EVALUATING: 'warning',
        DRAFT: 'default',
        PAUSED: 'warning',
        ARCHIVED: 'default',
      }
      return <Badge variant={statusColors[status] || 'default'}>{status}</Badge>
    },
  },
  {
    accessorKey: '_count.deployments',
    header: 'Deployments',
    cell: ({ row }: { row: { original: AgentRow; getValue: (key: string) => any } }) => <span className="font-medium">{row.getValue('_count.deployments')}</span>,
  },
  {
    accessorKey: '_count.skills',
    header: 'Skills',
    cell: ({ row }: { row: { original: AgentRow; getValue: (key: string) => any } }) => <span className="font-medium">{row.getValue('_count.skills')}</span>,
  },
  {
    accessorKey: 'updatedAt',
    header: 'Last Updated',
    cell: ({ row }: { row: { original: AgentRow; getValue: (key: string) => any } }) => new Date(row.getValue('updatedAt')).toLocaleDateString(),
  },
  {
    accessorKey: 'actions',
    header: '',
    cell: ({ row }: { row: { original: AgentRow; getValue: (key: string) => any } }) => (
      <div className="flex items-center gap-2">
        <Link href={`/operator/agents/${row.original.id}`} className="p-2 text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300" title="View">
          <Edit className="w-4 h-4" />
        </Link>
      </div>
    ),
  },
]

export default async function AgentsPage({ searchParams }: { searchParams: { page?: string; search?: string; tenantId?: string } }) {
  const data = await getAgents(searchParams)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">Agents</h1>
          <p className="text-neutral-500 dark:text-neutral-400 mt-1">All agents across tenants</p>
        </div>
      </div>

      <Suspense fallback={<AgentsSkeleton />}>
        {data && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>All Agents ({data.meta.total})</CardTitle>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
                  <input
                    type="search"
                    placeholder="Search agents..."
                    defaultValue={searchParams.search || ''}
                    className="pl-10 pr-4 py-2 w-64 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-sm"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const params = new URLSearchParams(searchParams as any)
                        params.set('search', (e.target as HTMLInputElement).value)
                        params.set('page', '1')
                        window.location.href = `/operator/agents?${params.toString()}`
                      }
                    }}
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={columns}
                data={data.agents}
                pagination={{
                  page: data.meta.page,
                  pageSize: data.meta.pageSize,
                  total: data.meta.total,
                  totalPages: data.meta.totalPages,
                  onPageChange: (page) => {
                    const params = new URLSearchParams(searchParams as any)
                    params.set('page', page.toString())
                    window.location.href = `/operator/agents?${params.toString()}`
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