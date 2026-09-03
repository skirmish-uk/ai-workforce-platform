'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { Plus, Search, BookOpen, Play, MoreVertical, Trash2, Pause } from 'lucide-react'
import Link from 'next/link'
import { Button, Badge } from '@ai-workforce/ui'
import { formatDate } from '@ai-workforce/ui'

interface Workflow {
  id: string
  name: string
  description: string | null
  isActive: boolean
  timeout: number
  createdAt: string
  agent?: { id: string; name: string } | null
  _count?: { runs: number }
}

interface WorkflowsResponse {
  data: Workflow[]
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
}

export default function WorkflowsPage() {
  const { data: session } = useSession()
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 0 })
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  const fetchWorkflows = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        pageSize: pagination.pageSize.toString(),
        ...(search && { search }),
      })
      const res = await fetch(`/api/workflows?${params}`)
      if (res.ok) {
        const data: WorkflowsResponse = await res.json()
        setWorkflows(data.data)
        setPagination(data.pagination)
      }
    } catch (error) {
      console.error('Failed to fetch workflows:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchWorkflows() }, [pagination.page, search])

  const userRole = session?.user?.role
  const canManage = userRole === 'PLATFORM_ADMIN' || userRole === 'PLATFORM_OPERATOR' || userRole === 'CUSTOMER_ADMIN'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">Workflows</h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1">Manage automated workflows</p>
        </div>
        {canManage && (
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Create Workflow
          </Button>
        )}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); setPagination(prev => ({ ...prev, page: 1 })); fetchWorkflows(); }} className="flex gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search workflows..."
            className="w-full pl-10 pr-4 py-2.5 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
      </form>

      {loading ? (
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-8 text-center">
          <div className="animate-spin w-8 h-8 border-2 border-primary-600 border-t-transparent rounded-full mx-auto"></div>
        </div>
      ) : (
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
          <table className="w-full">
            <thead className="bg-neutral-50 dark:bg-neutral-800/50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Workflow</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Agent</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Runs</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Timeout</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Created</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {workflows.length === 0 ? (
                <tr><td className="px-6 py-12 text-center text-neutral-500 dark:text-neutral-400" colSpan={7}>No workflows found</td></tr>
              ) : (
                workflows.map((wf) => (
                  <tr key={wf.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
                    <td className="px-6 py-4">
                      <Link href={`/dashboard/workflows/${wf.id}`} className="font-medium text-neutral-900 dark:text-neutral-50 hover:text-primary-600 dark:hover:text-primary-400">
                        {wf.name}
                      </Link>
                      {wf.description && <p className="text-sm text-neutral-500 dark:text-neutral-400 truncate max-w-xs">{wf.description}</p>}
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600 dark:text-neutral-400">{wf.agent?.name || '—'}</td>
                    <td className="px-6 py-4">
                      <Badge variant={wf.isActive ? 'success' : 'default'}>{wf.isActive ? 'Active' : 'Inactive'}</Badge>
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600 dark:text-neutral-400">{wf._count?.runs || 0}</td>
                    <td className="px-6 py-4 text-sm text-neutral-600 dark:text-neutral-400">{wf.timeout}s</td>
                    <td className="px-6 py-4 text-sm text-neutral-600 dark:text-neutral-400">{formatDate(wf.createdAt)}</td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Link href={`/dashboard/workflows/${wf.id}`} className="p-2 text-neutral-500 hover:text-primary-600 dark:hover:text-primary-400 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800" title="Configure">
                          <BookOpen className="w-4 h-4" />
                        </Link>
                        {canManage && wf.isActive && (
                          <button className="p-2 text-neutral-500 hover:text-green-600 dark:hover:text-green-400 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800" title="Test Run">
                            <Play className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {pagination.totalPages > 1 && (
            <div className="px-6 py-4 border-t border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={pagination.page === 1} onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}>Previous</Button>
                <Button variant="outline" size="sm" disabled={pagination.page === pagination.totalPages} onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}