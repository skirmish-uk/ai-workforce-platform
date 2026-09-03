'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { ArrowLeft, Play, Pause, RotateCcw, Trash2, Edit, Save, X, CheckCircle, AlertCircle, Clock, FileText } from 'lucide-react'
import Link from 'next/link'
import { Button, Badge, Card, CardContent, CardHeader, CardTitle } from '@ai-workforce/ui'
import { formatDate, formatDateTime } from '@ai-workforce/ui'

interface Workflow {
  id: string
  name: string
  description: string | null
  trigger: Record<string, unknown>
  steps: Array<Record<string, unknown>>
  config: Record<string, unknown>
  retryPolicy: Record<string, unknown>
  timeout: number
  isActive: boolean
  createdAt: string
  updatedAt: string
  agent?: { id: string; name: string } | null
  runs?: Array<{
    id: string
    status: string
    input: Record<string, unknown>
    output: Record<string, unknown> | null
    error: string | null
    createdAt: string
    completedAt: string | null
    approvals: Array<{ id: string; action: string; level: string; decision: string | null; createdAt: string }>
  }>
}

export default function WorkflowDetailPage() {
  const params = useParams()
  const router = useRouter()
  const { data: session } = useSession()
  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)

  const workflowId = params.id as string
  const userRole = session?.user?.role
  const canManage = userRole === 'PLATFORM_ADMIN' || userRole === 'PLATFORM_OPERATOR' || userRole === 'CUSTOMER_ADMIN'

  const fetchWorkflow = async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/workflows/${workflowId}`)
      if (res.ok) {
        const data = await res.json()
        setWorkflow(data)
      }
    } catch (error) {
      console.error('Failed to fetch workflow:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchWorkflow()
  }, [workflowId])

  const handleRun = async () => {
    if (!workflow) return
    setRunning(true)
    try {
      const res = await fetch(`/api/workflows/${workflowId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: {} }),
      })
      if (res.ok) {
        const data = await res.json()
        router.push(`/dashboard/workflows/${workflowId}/runs/${data.runId}`)
      } else {
        alert('Failed to start workflow')
      }
    } catch (error) {
      console.error('Failed to start workflow:', error)
      alert('Failed to start workflow')
    } finally {
      setRunning(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this workflow?')) return
    try {
      const res = await fetch(`/api/workflows/${workflowId}`, { method: 'DELETE' })
      if (res.ok) {
        router.push('/dashboard/workflows')
      } else {
        alert('Failed to delete workflow')
      }
    } catch (error) {
      console.error('Failed to delete workflow:', error)
      alert('Failed to delete workflow')
    }
  }

  if (loading) {
    return (
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-8 text-center">
        <div className="animate-spin w-8 h-8 border-2 border-primary-600 border-t-transparent rounded-full mx-auto"></div>
      </div>
    )
  }

  if (!workflow) {
    return (
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-8 text-center">
        <p className="text-neutral-600 dark:text-neutral-400">Workflow not found</p>
        <Link href="/dashboard/workflows" className="mt-4 inline-flex items-center gap-2 text-primary-600 hover:text-primary-500">
          <ArrowLeft className="w-4 h-4" />
          Back to Workflows
        </Link>
      </div>
    )
  }

  const statusColors: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
    PENDING: 'warning',
    RUNNING: 'info',
    COMPLETED: 'success',
    FAILED: 'danger',
    APPROVAL_REQUIRED: 'warning',
    CANCELLED: 'default',
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/dashboard/workflows" className="p-2 text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">{workflow.name}</h1>
            <p className="text-neutral-600 dark:text-neutral-400">{workflow.description || 'No description'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={workflow.isActive ? 'success' : 'default'}>{workflow.isActive ? 'Active' : 'Inactive'}</Badge>
          {canManage && (
            <>
              <Button variant="outline" size="sm" onClick={handleRun} isLoading={running} disabled={running}>
                <Play className="w-4 h-4 mr-2" />
                Run
              </Button>
              <Button variant="outline" size="sm">
                <Edit className="w-4 h-4 mr-2" />
                Edit
              </Button>
              <Button variant="destructive" size="sm" onClick={handleDelete}>
                <Trash2 className="w-4 h-4 mr-2" />
                Delete
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader><CardTitle>Configuration</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div><p className="text-sm text-neutral-500 dark:text-neutral-400">Agent</p>
                <p className="font-medium">{workflow.agent?.name || 'None'}</p>
              </div>
              <div><p className="text-sm text-neutral-500 dark:text-neutral-400">Timeout</p>
                <p className="font-medium">{workflow.timeout}s</p>
              </div>
              <div><p className="text-sm text-neutral-500 dark:text-neutral-400">Retry Policy</p>
                <p className="font-medium text-sm font-mono">{JSON.stringify(workflow.retryPolicy, null, 2)}</p>
              </div>
              <div><p className="text-sm text-neutral-500 dark:text-neutral-400">Trigger</p>
                <p className="font-medium text-sm font-mono">{JSON.stringify(workflow.trigger, null, 2)}</p>
              </div>
              <div><p className="text-sm text-neutral-500 dark:text-neutral-400">Steps</p>
                <p className="font-medium text-sm font-mono">{JSON.stringify(workflow.steps, null, 2)}</p>
              </div>
            </CardContent>
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Recent Runs</CardTitle></CardHeader>
            <CardContent>
              {workflow.runs?.length === 0 ? (
                <p className="text-neutral-500 dark:text-neutral-400 text-center py-8">No runs yet</p>
              ) : (
                <div className="space-y-3">
                  {workflow.runs!.map((run, i) => (
                    <div key={i} className="flex items-center justify-between p-4 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${run.status === 'COMPLETED' ? 'bg-green-500' : run.status === 'FAILED' ? 'bg-red-500' : run.status === 'RUNNING' ? 'bg-blue-500' : run.status === 'PENDING' ? 'bg-yellow-500' : 'bg-gray-500'}`}></div>
                        <div>
                          <p className="font-medium">Run #{i + 1}</p>
                          <p className="text-sm text-neutral-500 dark:text-neutral-400">{formatDateTime(run.createdAt)}</p>
                        </div>
                      </div>
                      <Badge variant={
                        run.status === 'COMPLETED' ? 'success' :
                        run.status === 'FAILED' ? 'danger' :
                        run.status === 'RUNNING' ? 'info' :
                        run.status === 'PENDING' ? 'warning' : 'default'
                      }>{run.status}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}