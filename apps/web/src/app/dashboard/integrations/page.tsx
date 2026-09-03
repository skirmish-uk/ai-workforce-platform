'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { Plus, Search, Shield, Plug, MoreVertical, Trash2, CheckCircle, AlertCircle, Settings } from 'lucide-react'
import Link from 'next/link'
import { Button, Badge } from '@ai-workforce/ui'
import { formatDate } from '@ai-workforce/ui'

interface Integration {
  id: string
  name: string
  provider: string
  isActive: boolean
  scopes: string[]
  createdAt: string
}

interface IntegrationsResponse {
  data: Integration[]
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
}

const providerIcons: Record<string, React.ReactNode> = {
  google: <svg className="w-5 h-5" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>,
  hubspot: <svg className="w-5 h-5 text-[#FF7A59]" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm-1-7h2v2h-2zm0 4h2v2h-2z"/></svg>,
  microsoft: <svg className="w-5 h-5 text-[#0078D4]" viewBox="0 0 24 24"><path fill="currentColor" d="M17.71 6.82H10.98v5.39h3.47c-.16 1.03-.82 2.2-2.13 2.2-1.54 0-2.63-1.12-2.63-2.57 0-1.47 1.06-2.58 2.54-2.58h.02V6.44c0-.82-.48-1.26-1.23-1.26-.82 0-1.37.56-1.54 1.12H4.47C3.61 5 3 5.7 3 6.66v11.28c0 .96.62 1.64 1.49 1.64.87 0 1.5-.66 1.5-1.56v-1.56h4.54c1.07-.16 1.93-.95 2.13-2.1.13-1.12-.73-2.1-2.07-2.1-1.37 0-2.43.98-2.43 2.55 0 1.55 1.1 2.56 2.53 2.56.8 0 1.37-.53 1.54-1.12h.03v1.51c0 .78.48 1.23 1.23 1.23.78 0 1.31-.53 1.51-1.15h3.83c1.09.96 2.13 1.57 3.24 1.57 3.65 0 6.16-3.18 6.16-7.15 0-3.98-2.5-7.12-6.07-7.12-3.32 0-6.22 2.5-6.32 6.09h-.02v1.91h4.64v-1.86c.24-1.4 1.1-2.47 2.56-2.47 1.25 0 2.12.7 2.52 1.57l.64-.88C20.63 5.15 19.31 4 17.58 4c-2.26 0-4.1 1.5-4.52 3.36h-.08V6.82z"/></svg>,
}

export default function IntegrationsPage() {
  const { data: session } = useSession()
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 0 })
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  const fetchIntegrations = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        pageSize: pagination.pageSize.toString(),
        ...(search && { search }),
      })
      const res = await fetch(`/api/integrations?${params}`)
      if (res.ok) {
        const data: IntegrationsResponse = await res.json()
        setIntegrations(data.data)
        setPagination(data.pagination)
      }
    } catch (error) {
      console.error('Failed to fetch integrations:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchIntegrations() }, [pagination.page, search])

  const userRole = session?.user?.role
  const canManage = userRole === 'PLATFORM_ADMIN' || userRole === 'PLATFORM_OPERATOR' || userRole === 'CUSTOMER_ADMIN'

  const getProviderIcon = (provider: string) => providerIcons[provider] || <Plug className="w-5 h-5" />

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">Integrations</h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1">Connect your systems and tools</p>
        </div>
        {canManage && (
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Add Integration
          </Button>
        )}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); setPagination(prev => ({ ...prev, page: 1 })); fetchIntegrations(); }} className="flex gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search integrations..."
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
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Integration</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Provider</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Scopes</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Created</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {integrations.length === 0 ? (
                <tr><td className="px-6 py-12 text-center text-neutral-500 dark:text-neutral-400" colSpan={6}>No integrations found</td></tr>
              ) : (
                integrations.map((int) => (
                  <tr key={int.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
                          {getProviderIcon(int.provider)}
                        </div>
                        <span className="font-medium text-neutral-900 dark:text-neutral-50">{int.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600 dark:text-neutral-400 capitalize">{int.provider}</td>
                    <td className="px-6 py-4">
                      <Badge variant={int.isActive ? 'success' : 'default'}>
                        {int.isActive ? 'Connected' : 'Disconnected'}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600 dark:text-neutral-400">
                      {int.scopes.slice(0, 3).join(', ')}{int.scopes.length > 3 && ` +${int.scopes.length - 3} more`}
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600 dark:text-neutral-400">{formatDate(int.createdAt)}</td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Link href={`/dashboard/integrations/${int.id}`} className="p-2 text-neutral-500 hover:text-primary-600 dark:hover:text-primary-400 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800" title="Configure">
                          <Settings className="w-4 h-4" />
                        </Link>
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