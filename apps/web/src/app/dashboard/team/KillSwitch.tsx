'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { Loader2, Octagon, Play } from 'lucide-react'
import { Button } from '@ai-workforce/ui'

interface KillSwitchState { agentsDisabled: boolean; reason?: string }

/**
 * Stop every agent at once (Tenant.settings.killSwitch via PUT /api/tenants/[id]/kill-switch):
 * new runs are refused and approved actions don't execute until agents are turned back on.
 * Shown only to people allowed to change it; `onChange` lets the page refresh its health view.
 */
export function KillSwitch({ onChange }: { onChange?: () => void }) {
  const { data: session } = useSession()
  const tenantId = (session?.user as { tenantId?: string } | undefined)?.tenantId
  const [state, setState] = useState<KillSwitchState | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!tenantId) return
    const res = await fetch(`/api/tenants/${tenantId}/kill-switch`).catch(() => null)
    if (res?.ok) setState(await res.json())
  }, [tenantId])

  useEffect(() => { load() }, [load])

  const set = async (agentsDisabled: boolean) => {
    if (!tenantId) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/tenants/${tenantId}/kill-switch`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agentsDisabled ? { agentsDisabled, reason: 'stopped from the Team page' } : { agentsDisabled }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setState(body)
      setConfirming(false)
      onChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the switch')
    } finally {
      setSaving(false)
    }
  }

  // Not allowed to change it (or not loaded yet): show nothing.
  if (!state) return null

  if (state.agentsDisabled) {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-900/20 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium text-red-900 dark:text-red-200">
          <Octagon className="w-5 h-5 shrink-0" aria-hidden="true" />
          Every agent is stopped. New work is refused and approved actions won’t run until you turn them back on.
        </p>
        <Button variant="outline" onClick={() => set(false)} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}Turn agents back on
        </Button>
        {error && <p className="w-full text-sm text-red-700 dark:text-red-300">{error}</p>}
      </div>
    )
  }

  return confirming ? (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-300 dark:border-red-800 px-3 py-2 text-sm">
      <span className="text-neutral-800 dark:text-neutral-200">Stop every agent now?</span>
      <Button variant="destructive" size="sm" onClick={() => set(true)} disabled={saving}>
        {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Octagon className="w-4 h-4 mr-1" />}Stop all
      </Button>
      <button onClick={() => setConfirming(false)} className="text-neutral-500 hover:underline">Cancel</button>
      {error && <span className="w-full text-red-600 dark:text-red-400">{error}</span>}
    </div>
  ) : (
    <button
      onClick={() => setConfirming(true)}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/20"
    >
      <Octagon className="w-4 h-4" aria-hidden="true" />Stop all agents
    </button>
  )
}
