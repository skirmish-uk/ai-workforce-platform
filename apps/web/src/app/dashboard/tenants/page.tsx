'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { Plus, Search, MoreVertical, Edit, Trash2, Users, Bot, Zap, FileText, Settings } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@ai-workforce/ui'
import { formatDate } from '@ai-workforce/ui'

interface Tenant {
  id: string
  name: string
  slug: string
  industry: string | null
  geography: string | null
  createdAt: string
  _count?: {
    users: number
    agents: number
    skills: number
    workflows: number
  }
}

interface TenantsResponse {
  data: Tenant[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
}

export default function TenantsPage() {
  const { data: session } = useSession()
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 0 })
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newTenant, setNewTenant] = useState({ name: '', slug: '', industry: '', geography: '' })
  const [creating, setCreating] = useState(false)

  const fetchTenants = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        pageSize: pagination.pageSize.toString(),
        ...(search && { search }),
      })
      const res = await fetch(`/api/tenants?${params}`)
      if (res.ok) {
        const data: TenantsResponse = await res.json()
        setTenants(data.data)
        setPagination(data.pagination)
      }
    } catch (error) {
      console.error('Failed to fetch tenants:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchTenants()
  }, [pagination.page, search])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setPagination(prev => ({ ...prev, page: 1 }))
    fetchTenants()
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreating(true)
    try {
      const res = await fetch('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTenant),
      })
      if (res.ok) {
        setShowCreateModal(false)
        setNewTenant({ name: '', slug: '', industry: '', geography: '' })
        fetchTenants()
      } else {
        const error = await res.json()
        alert(error.error || 'Failed to create tenant')
      }
    } catch (error) {
      console.error('Failed to create tenant:', error)
      alert('Failed to create tenant')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (tenantId: string) => {
    if (!confirm('Are you sure you want to delete this tenant? This action cannot be undone.')) return
    try {
      const res = await fetch(`/api/tenants/${tenantId}`, { method: 'DELETE' })
      if (res.ok) {
        fetchTenants()
      } else {
        alert('Failed to delete tenant')
      }
    } catch (error) {
      console.error('Failed to delete tenant:', error)
      alert('Failed to delete tenant')
    }
  }

  const userRole = session?.user?.role

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">Tenants</h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1">Manage customer tenants and workspaces</p>
        </div>
        {(userRole === 'PLATFORM_ADMIN' || userRole === 'PLATFORM_OPERATOR') && (
          <Button onClick={() => setShowCreateModal(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Add Tenant
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
            placeholder="Search tenants..."
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
          <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-neutral-50 dark:bg-neutral-800/50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Tenant</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Industry / Geography</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Resources</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Created</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {tenants.length === 0 ? (
                <tr>
                  <td className="px-6 py-12 text-center text-neutral-500 dark:text-neutral-400" colSpan={5}>
                    No tenants found
                  </td>
                </tr>
              ) : (
                tenants.map((tenant) => (
                  <tr key={tenant.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
                    <td className="px-6 py-4">
                      <Link href={`/dashboard/tenants/${tenant.id}`} className="font-medium text-neutral-900 dark:text-neutral-50 hover:text-primary-600 dark:hover:text-primary-400">
                        {tenant.name}
                      </Link>
                      <p className="text-sm text-neutral-500 dark:text-neutral-400">{tenant.slug}</p>
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600 dark:text-neutral-400">
                      {tenant.industry || '—'} / {tenant.geography || '—'}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-4 text-sm text-neutral-600 dark:text-neutral-400">
                        {tenant._count && (
                          <>
                            <span className="flex items-center gap-1"><Users className="w-4 h-4" /> {tenant._count.users}</span>
                            <span className="flex items-center gap-1"><Bot className="w-4 h-4" /> {tenant._count.agents}</span>
                            <span className="flex items-center gap-1"><Zap className="w-4 h-4" /> {tenant._count.skills}</span>
                            <span className="flex items-center gap-1"><FileText className="w-4 h-4" /> {tenant._count.workflows}</span>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600 dark:text-neutral-400">
                      {formatDate(tenant.createdAt)}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Link href={`/dashboard/tenants/${tenant.id}`} className="p-2 text-neutral-500 hover:text-primary-600 dark:hover:text-primary-400 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800" title="View details">
                          <Settings className="w-4 h-4" />
                        </Link>
                        {(userRole === 'PLATFORM_ADMIN' || userRole === 'PLATFORM_OPERATOR') && (
                          <>
                            <button onClick={() => handleDelete(tenant.id)} className="p-2 text-neutral-500 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800" title="Delete">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          </div>

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
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50 mb-4">Create Tenant</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Name</label>
                <input
                  type="text"
                  value={newTenant.name}
                  onChange={(e) => setNewTenant(prev => ({ ...prev, name: e.target.value }))}
                  required
                  className="w-full px-4 py-2.5 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Slug</label>
                <input
                  type="text"
                  value={newTenant.slug}
                  onChange={(e) => setNewTenant(prev => ({ ...prev, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))}
                  required
                  pattern="[a-z0-9-]+"
                  className="w-full px-4 py-2.5 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">Lowercase, numbers, hyphens only</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Industry (optional)</label>
                <input
                  type="text"
                  value={newTenant.industry}
                  onChange={(e) => setNewTenant(prev => ({ ...prev, industry: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Geography (optional)</label>
                <input
                  type="text"
                  value={newTenant.geography}
                  onChange={(e) => setNewTenant(prev => ({ ...prev, geography: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div className="flex gap-3 pt-4">
                <Button type="button" variant="outline" onClick={() => setShowCreateModal(false)} className="flex-1">
                  Cancel
                </Button>
                <Button type="submit" isLoading={creating} className="flex-1">
                  Create Tenant
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}