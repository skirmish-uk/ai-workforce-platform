'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { Activity, AlertTriangle, CheckCircle, Server, Database, Zap, TrendingUp, AlertCircle, Clock, RefreshCw } from 'lucide-react'
import { Button, Badge, Card, CardContent, CardHeader, CardTitle } from '@ai-workforce/ui'
import { formatDateTime } from '@ai-workforce/ui'

interface HealthCheck {
  name: string
  status: 'healthy' | 'degraded' | 'unhealthy'
  latencyMs?: number
  message?: string
}

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy'
  timestamp: string
  checks: HealthCheck[]
}

interface Alert {
  id: string
  action: string
  metadata: Record<string, unknown>
  createdAt: string
}

interface Component {
  id: string
  name: string
  status: string
  updatedAt: string
}

export default function MonitoringPage() {
  const { data: session } = useSession()
  const [activeTab, setActiveTab] = useState<'health' | 'alerts' | 'metrics' | 'components'>('health')
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [components, setComponents] = useState<Component[]>([])
  const [loading, setLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)

  const fetchHealth = async () => {
    try {
      const res = await fetch('/api/monitoring?type=health')
      if (res.ok) setHealth(await res.json())
    } catch (error) {
      console.error('Failed to fetch health:', error)
    }
  }

  const fetchAlerts = async () => {
    try {
      const res = await fetch('/api/monitoring?type=alerts')
      if (res.ok) {
        const data = await res.json()
        setAlerts(data.alerts || [])
      }
    } catch (error) {
      console.error('Failed to fetch alerts:', error)
    }
  }

  const fetchComponents = async () => {
    try {
      const res = await fetch('/api/monitoring?type=components')
      if (res.ok) {
        const data = await res.json()
        setComponents(data.components || [])
      }
    } catch (error) {
      console.error('Failed to fetch components:', error)
    }
  }

  const fetchAll = async () => {
    setLoading(true)
    await Promise.all([fetchHealth(), fetchAlerts(), fetchComponents()])
    setLoading(false)
  }

  useEffect(() => {
    fetchAll()
    if (activeTab === 'health') fetchHealth()
    else if (activeTab === 'alerts') fetchAlerts()
    else if (activeTab === 'components') fetchComponents()
  }, [activeTab])

  useEffect(() => {
    if (!autoRefresh) return
    const interval = setInterval(fetchAll, 30000)
    return () => clearInterval(interval)
  }, [autoRefresh])

  const statusColors: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
    healthy: 'success',
    degraded: 'warning',
    unhealthy: 'danger',
    unknown: 'default',
  }

  const statusIcons: Record<string, React.ReactNode> = {
    healthy: <CheckCircle className="w-5 h-5 text-green-500" />,
    degraded: <AlertTriangle className="w-5 h-5 text-yellow-500" />,
    unhealthy: <AlertCircle className="w-5 h-5 text-red-500" />,
    unknown: <Clock className="w-5 h-5 text-gray-500" />,
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">Monitoring</h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1">System health, alerts, and performance metrics</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={fetchAll} isLoading={loading}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
          <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              className="w-4 h-4 text-primary-600 border-neutral-300 rounded focus:ring-primary-500"
            />
            Auto-refresh (30s)
          </label>
        </div>
      </div>

      <div className="flex gap-2 border-b border-neutral-200 dark:border-neutral-800">
        {['health', 'alerts', 'metrics', 'components'].map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab as any)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab
                ? 'border-primary-600 text-primary-600'
                : 'border-transparent text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {activeTab === 'health' && (
        <div className="space-y-6">
          {health && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>System Health</CardTitle>
                <Badge variant={statusColors[health.status] || 'default'} className="text-lg">
                  {health.status.charAt(0).toUpperCase() + health.status.slice(1)}
                </Badge>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-4">
                  Last checked: {formatDateTime(health.timestamp)}
                </p>
                <div className="space-y-3">
                  {health.checks.map((check, i) => (
                    <div key={i} className="flex items-center justify-between p-4 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
                      <div className="flex items-center gap-3">
                        {statusIcons[check.status]}
                        <div>
                          <p className="font-medium capitalize">{check.name}</p>
                          <p className="text-sm text-neutral-500 dark:text-neutral-400">{check.message}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <Badge variant={statusColors[check.status] || 'default'}>
                          {check.status.charAt(0).toUpperCase() + check.status.slice(1)}
                        </Badge>
                        {check.latencyMs && (
                          <span className="text-sm text-neutral-500 dark:text-neutral-400">
                            {check.latencyMs}ms
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {activeTab === 'alerts' && (
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Active Alerts (Last 24h)</CardTitle></CardHeader>
            <CardContent>
              {alerts.length === 0 ? (
                <p className="text-neutral-500 dark:text-neutral-400 text-center py-8">No active alerts</p>
              ) : (
                <div className="space-y-3">
                  {alerts.map((alert, i) => (
                    <div key={i} className="flex items-center justify-between p-4 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
                      <div className="flex items-center gap-3">
                        <AlertTriangle className="w-5 h-5 text-yellow-500" />
                        <div>
                          <p className="font-medium">{alert.metadata?.summary as string || 'Alert'}</p>
                          <p className="text-sm text-neutral-500 dark:text-neutral-400">
                            {alert.action.replace('ALERT_', '').toLowerCase().replace('_', ' ')}
                          </p>
                        </div>
                      </div>
                      <span className="text-sm text-neutral-500 dark:text-neutral-400">
                        {formatDateTime(alert.createdAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === 'components' && (
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Component Status</CardTitle></CardHeader>
            <CardContent>
              {components.length === 0 ? (
                <p className="text-neutral-500 dark:text-neutral-400 text-center py-8">No components found</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-left text-sm text-neutral-500 dark:text-neutral-400">
                        <th className="pb-2">Component</th>
                        <th className="pb-2">Type</th>
                        <th className="pb-2">Status</th>
                        <th className="pb-2">Last Updated</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                      {components.map((comp, i) => (
                        <tr key={i}>
                          <td className="py-3 font-medium">{comp.name}</td>
                          <td className="py-3 text-sm text-neutral-500 dark:text-neutral-400">Agent</td>
                          <td className="py-3">
                            <Badge variant={statusColors[comp.status.toLowerCase()] || 'default'}>
                              {comp.status}
                            </Badge>
                          </td>
                          <td className="py-3 text-sm text-neutral-500 dark:text-neutral-400">
                            {formatDateTime(comp.updatedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === 'metrics' && (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">CPU Usage</p>
                    <p className="text-3xl font-bold text-neutral-900 dark:text-neutral-50">—</p>
                  </div>
                  <Server className="w-12 h-12 text-blue-500" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">Memory</p>
                    <p className="text-3xl font-bold text-neutral-900 dark:text-neutral-50">—</p>
                  </div>
                  <Database className="w-12 h-12 text-green-500" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">Disk</p>
                    <p className="text-3xl font-bold text-neutral-900 dark:text-neutral-50">—</p>
                  </div>
                  <Zap className="w-12 h-12 text-yellow-500" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">Requests/sec</p>
                    <p className="text-3xl font-bold text-neutral-900 dark:text-neutral-50">—</p>
                  </div>
                  <Activity className="w-12 h-12 text-purple-500" />
                </div>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader><CardTitle>System Metrics</CardTitle></CardHeader>
            <CardContent>
              <p className="text-neutral-500 dark:text-neutral-400 text-center py-8">
                Metrics collection not yet configured. Connect Prometheus/Grafana for detailed metrics.
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

