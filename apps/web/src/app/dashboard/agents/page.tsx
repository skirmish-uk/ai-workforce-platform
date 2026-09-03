'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { Plus, Search, Bot, Zap, Shield, MoreVertical, Edit, Trash2, Play, Pause } from 'lucide-react'
import Link from 'next/link'
import { Button, Badge } from '@ai-workforce/ui'
import { formatDate } from '@ai-workforce/ui'

interface Agent {
  id: string
  name: string
  role: string
  status: string
  modelProvider: string
  modelName: string
  createdAt: string
  _count?: {
    workflows: number
    knowledgeSources: number
  }
  skills?: Array<{ skill: { name: string; version: string } }>
}

interface AgentsResponse {
  data: Agent[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
}

const statusColors: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  DRAFT: 'default',
  EVALUATING: 'warning',
  PRODUCTION: 'success',
  PAUSED: 'warning',
  ARCHIVED: 'danger',
}

export default function AgentsPage() {
  const { data: session } = useSession()
  const [agents, setAgents] = useState<Agent[]>([])
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 0 })
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)

  const fetchAgents = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        pageSize: pagination.pageSize.toString(),
        ...(search && { search }),
        ...(statusFilter && { status: statusFilter }),
      })
      const res = await fetch(`/api/agents?${params}`)
      if (res.ok) {
        const data: AgentsResponse = await res.json()
        setAgents(data.data)
        setPagination(data.pagination)
      }
    } catch (error) {
      console.error('Failed to fetch agents:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAgents()
  }, [pagination.page, search, statusFilter])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setPagination(prev => ({ ...prev, page: 1 }))
    fetchAgents()
  }

  const userRole = session?.user?.role
  const canManage = userRole === 'PLATFORM_ADMIN' || userRole === 'PLATFORM_OPERATOR' || userRole === 'CUSTOMER_ADMIN'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">Agents</h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1">Manage your AI employees</p>
        </div>
        {canManage && (
          <Button onClick={() => setShowCreateModal(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Create Agent
          </Button>
        )}
      </div>

      <form onSubmit={handleSearch} className="flex gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search agents..."
            className="w-full pl-10 pr-4 py-2.5 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPagination(prev => ({ ...prev, page: 1 })); fetchAgents(); }}
          className="px-4 py-2.5 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          <option value="">All Statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="EVALUATING">Evaluating</option>
          <option value="PRODUCTION">Production</option>
          <option value="PAUSED">Paused</option>
          <option value="ARCHIVED">Archived</option>
        </select>
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
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Agent</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Role</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Model</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Skills</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Created</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {agents.length === 0 ? (
                <tr>
                  <td className="px-6 py-12 text-center text-neutral-500 dark:text-neutral-400" colSpan={7}>
                    No agents found
                  </td>
                </tr>
              ) : (
                agents.map((agent) => (
                  <tr key={agent.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
                    <td className="px-6 py-4">
                      <Link href={`/dashboard/agents/${agent.id}`} className="font-medium text-neutral-900 dark:text-neutral-50 hover:text-primary-600 dark:hover:text-primary-400">
                        {agent.name}
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600 dark:text-neutral-400">{agent.role}</td>
                    <td className="px-6 py-4 text-sm text-neutral-600 dark:text-neutral-400">
                      {agent.modelProvider} / {agent.modelName}
                    </td>
                    <td className="px-6 py-4">
                      <Badge variant={statusColors[agent.status] || 'default'}>{agent.status}</Badge>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1">
                        {agent.skills?.map((s, i) => (
                          <Badge key={i} variant="outline" className="text-xs">{s.skill.name} v{s.skill.version}</Badge>
                        ))}
                        {!agent.skills?.length && <span className="text-sm text-neutral-400">None</span>}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600 dark:text-neutral-400">
                      {formatDate(agent.createdAt)}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Link href={`/dashboard/agents/${agent.id}`} className="p-2 text-neutral-500 hover:text-primary-600 dark:hover:text-primary-400 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800" title="Configure">
                          <Bot className="w-4 h-4" />
                        </Link>
                        {canManage && (
                          <>
                            {agent.status !== 'PRODUCTION' && (
                              <button className="p-2 text-neutral-500 hover:text-green-600 dark:hover:text-green-400 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800" title="Deploy">
                                <Play className="w-4 h-4" />
                              </button>
                            )}
                            {agent.status === 'PRODUCTION' && (
                              <button className="p-2 text-neutral-500 hover:text-yellow-600 dark:hover:text-yellow-400 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800" title="Pause">
                                <Pause className="w-4 h-4" />
                              </button>
                            )}
                          </>
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
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.page === 1}
                  onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.page === pagination.totalPages}
                  onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-neutral-900 rounded-xl p-6 w-full max-w-md mx-4">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50 mb-4">Create Agent</h2>
            <form onSubmit={(e) => { e.preventDefault(); setShowCreateModal(false); }} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Name</label>
                <input type="text" required className="w-full px-4 py-2.5 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Role</label>
                <input type="text" required className="w-full px-4 py-2.5 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Mission</label>
                <textarea required rows={3} className="w-full px-4 py-2.5 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">System Prompt</label>
                <textarea required rows={4} className="w-full px-4 py-2.5 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
              <div className="flex gap-3 pt-4">
                <Button type="button" variant="outline" onClick={() => setShowCreateModal(false)} className="flex-1">Cancel</Button>
                <Button type="submit" className="flex-1">Create Agent</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}