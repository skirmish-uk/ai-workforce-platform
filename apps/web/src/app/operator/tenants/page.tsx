import { Suspense } from 'react'
import { Search, MoreVertical, Edit, Trash2, Plus, Building, Users, DollarSign, AlertTriangle, CheckCircle, XCircle } from 'lucide-react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@ai-workforce/ui'
import { formatCurrency } from '@ai-workforce/ui'
import { DataTable, ColumnDef } from '../../../components/data-table'
import { Badge } from '@ai-workforce/ui'

async function getTenants(searchParams: { page?: string; search?: string }) {
  const params = new URLSearchParams()
  if (searchParams.page) params.set('page', searchParams.page)
  if (searchParams.search) params.set('search', searchParams.search)
  
  const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/operator/tenants?${params}`, {
    cache: 'no-store',
  })
  if (!res.ok) return null
  return res.json()
}

function TenantsSkeleton() {
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

const columns: ColumnDef<any>[] = [
  {
    accessorKey: 'name',
    header: 'Tenant',
    cell: ({ row }) => (
      <div>
        <Link href={`/operator/tenants/${row.original.id}`} className="font-medium text-neutral-900 dark:text-neutral-50 hover:text-primary-600">
          {row.getValue('name')}
        </Link>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{row.getValue('slug')}</p>
      </div>
    ),
  },
  {
    accessorKey: 'industry',
    header: 'Industry',
  },
  {
    accessorKey: '_count.users',
    header: 'Users',
    cell: ({ row }) => <span className="font-medium">{row.getValue('_count.users')}</span>,
  },
  {
    accessorKey: '_count.agents',
    header: 'Agents',
    cell: ({ row }) => <span className="font-medium">{row.getValue('_count.agents')}</span>,
  },
  {
    accessorKey: 'subscriptions',
    header: 'Subscription',
    cell: ({ row }) => {
      const subs = row.getValue('subscriptions')
      const sub = subs?.[0]
      if (!sub) return <Badge variant="default">None</Badge>
      const statusColors: Record<string, 'default' | 'success' | 'warning' | 'danger'> = {
        ACTIVE: 'success',
        TRIAL: 'warning',
        PAST_DUE: 'danger',
        CANCELLED: 'default',
        PAUSED: 'default',
      }
      return <Badge variant={statusColors[sub.status] || 'default'}>{sub.status}</Badge>
    },
  },
  {
    accessorKey: 'monthlyRevenue',
    header: 'Monthly Revenue',
    cell: ({ row }) => <span className="font-medium">{formatCurrency(row.getValue('monthlyRevenue') || 0)}</span>,
  },
  {
    accessorKey: 'actions',
    header: '',
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <Link href={`/operator/tenants/${row.original.id}`} className="p-2 text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300" title="View">
          <Edit className="w-4 h-4" />
        </Link>
      </div>
    ),
  },
]

export default async function TenantsPage({ searchParams: searchParamsPromise }: { searchParams: Promise<{ page?: string; search?: string }> }) {
  const searchParams = await searchParamsPromise
  const data = await getTenants(searchParams)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">Tenants</h1>
          <p className="text-neutral-500 dark:text-neutral-400 mt-1">Manage all platform tenants</p>
        </div>
        <Link href="/operator/tenants/new" className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors">
          <Plus className="w-4 h-4" />
          Add Tenant
        </Link>
      </div>

      <Suspense fallback={<TenantsSkeleton />}>
        {data && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>All Tenants ({data.meta.total})</CardTitle>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
                  <input
                    type="search"
                    placeholder="Search tenants..."
                    defaultValue={searchParams.search || ''}
                    className="pl-10 pr-4 py-2 w-64 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-sm"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const params = new URLSearchParams(searchParams as any)
                        params.set('search', (e.target as HTMLInputElement).value)
                        params.set('page', '1')
                        window.location.href = `/operator/tenants?${params.toString()}`
                      }
                    }}
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={columns}
                data={data.tenants}
                pagination={{
                  page: data.meta.page,
                  pageSize: data.meta.pageSize,
                  total: data.meta.total,
                  totalPages: data.meta.totalPages,
                  onPageChange: (page) => {
                    const params = new URLSearchParams(searchParams as any)
                    params.set('page', page.toString())
                    window.location.href = `/operator/tenants?${params.toString()}`
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