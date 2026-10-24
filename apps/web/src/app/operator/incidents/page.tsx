import { Suspense } from 'react'
import { Search, AlertTriangle, MoreVertical, Edit, Trash2, Clock, User, Building2 } from 'lucide-react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@ai-workforce/ui'
import { DataTable } from '../../../components/data-table'
import { Badge } from '@ai-workforce/ui'
import { formatDateTime } from '@ai-workforce/ui'

interface IncidentRow {
  id: string
  title: string
  description: string
  tenantId: string
  tenant: { name: string }
  severity: string
  status: string
  assignee?: { name?: string; email: string } | null
  createdAt: string
}

async function getIncidents(searchParams: { page?: string; search?: string; tenantId?: string; status?: string }) {
  const params = new URLSearchParams()
  if (searchParams.page) params.set('page', searchParams.page)
  if (searchParams.search) params.set('search', searchParams.search)
  if (searchParams.tenantId) params.set('tenantId', searchParams.tenantId)
  if (searchParams.status) params.set('status', searchParams.status)
  
  const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/operator/incidents?${params}`, {
    cache: 'no-store',
  })
  if (!res.ok) return null
  return res.json()
}

function IncidentsSkeleton() {
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

const statusOptions = ['OPEN', 'INVESTIGATING', 'IDENTIFIED', 'RESOLVED', 'CLOSED']

const columns = [
  {
    accessorKey: 'title',
    header: 'Incident',
    cell: ({ row }: { row: { original: IncidentRow; getValue: (key: string) => any } }) => (
      <div>
        <Link href={`/operator/incidents/${row.original.id}`} className="font-medium text-neutral-900 dark:text-neutral-50 hover:text-primary-600">
          {row.getValue('title')}
        </Link>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 line-clamp-1">{row.getValue('description')}</p>
      </div>
    ),
  },
  {
    accessorKey: 'tenant.name',
    header: 'Tenant',
    cell: ({ row }: { row: { original: IncidentRow; getValue: (key: string) => any } }) => (
      <Link href={`/operator/tenants/${row.original.tenantId}`} className="text-sm text-primary-600 hover:underline">
        {row.getValue('tenant.name')}
      </Link>
    ),
  },
  {
    accessorKey: 'severity',
    header: 'Severity',
    cell: ({ row }: { row: { original: IncidentRow; getValue: (key: string) => any } }) => {
      const severity = row.getValue('severity')
      const severityColors: Record<string, 'default' | 'success' | 'warning' | 'danger'> = {
        LOW: 'default',
        MEDIUM: 'warning',
        HIGH: 'danger',
        CRITICAL: 'danger',
      }
      return <Badge variant={severityColors[severity] || 'default'}>{severity}</Badge>
    },
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }: { row: { original: IncidentRow; getValue: (key: string) => any } }) => {
      const status = row.getValue('status')
      const statusColors: Record<string, 'default' | 'success' | 'warning' | 'danger'> = {
        OPEN: 'danger',
        INVESTIGATING: 'warning',
        IDENTIFIED: 'warning',
        RESOLVED: 'success',
        CLOSED: 'default',
      }
      return <Badge variant={statusColors[status] || 'default'}>{status}</Badge>
    },
  },
  {
    accessorKey: 'assignee.name',
    header: 'Assignee',
    cell: ({ row }: { row: { original: IncidentRow; getValue: (key: string) => any } }) => {
      const assignee = row.getValue('assignee')
      return assignee ? (
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
            <User className="w-3 h-3 text-primary-600 dark:text-primary-400" />
          </div>
          <span className="text-sm">{assignee.name || assignee.email}</span>
        </div>
      ) : (
        <span className="text-neutral-400 dark:text-neutral-500">Unassigned</span>
      )
    },
  },
  {
    accessorKey: 'createdAt',
    header: 'Created',
    cell: ({ row }: { row: { original: IncidentRow; getValue: (key: string) => any } }) => formatDateTime(row.getValue('createdAt')),
  },
  {
    accessorKey: 'actions',
    header: '',
    cell: ({ row }: { row: { original: IncidentRow; getValue: (key: string) => any } }) => (
      <div className="flex items-center gap-2">
        <Link href={`/operator/incidents/${row.original.id}`} className="p-2 text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300" title="View">
          <Edit className="w-4 h-4" />
        </Link>
      </div>
    ),
  },
]

export default async function IncidentsPage({ searchParams: searchParamsPromise }: { searchParams: Promise<{ page?: string; search?: string; tenantId?: string; status?: string }> }) {
  const searchParams = await searchParamsPromise
  const data = await getIncidents(searchParams)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">Incidents</h1>
          <p className="text-neutral-500 dark:text-neutral-400 mt-1">Platform incidents and issues</p>
        </div>
      </div>

      <Suspense fallback={<IncidentsSkeleton />}>
        {data && (
          <Card>
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <CardTitle>All Incidents ({data.meta.total})</CardTitle>
                <div className="flex items-center gap-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
                    <input
                      type="search"
                      placeholder="Search incidents..."
                      defaultValue={searchParams.search || ''}
                      className="pl-10 pr-4 py-2 w-64 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-sm"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const params = new URLSearchParams(searchParams as any)
                          params.set('search', (e.target as HTMLInputElement).value)
                          params.set('page', '1')
                          window.location.href = `/operator/incidents?${params.toString()}`
                        }
                      }}
                    />
                  </div>
                  <select
                    defaultValue={searchParams.status || ''}
                    className="px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-sm"
                    onChange={(e) => {
                      const params = new URLSearchParams(searchParams as any)
                      if (e.target.value) {
                        params.set('status', e.target.value)
                      } else {
                        params.delete('status')
                      }
                      params.set('page', '1')
                      window.location.href = `/operator/incidents?${params.toString()}`
                    }}
                  >
                    <option value="">All Statuses</option>
                    {statusOptions.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={columns}
                data={data.incidents}
                pagination={{
                  page: data.meta.page,
                  pageSize: data.meta.pageSize,
                  total: data.meta.total,
                  totalPages: data.meta.totalPages,
                  onPageChange: (page) => {
                    const params = new URLSearchParams(searchParams as any)
                    params.set('page', page.toString())
                    window.location.href = `/operator/incidents?${params.toString()}`
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