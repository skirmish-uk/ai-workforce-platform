'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Hand, RotateCcw } from 'lucide-react'
import { Badge, Button, formatDateTime } from '@ai-workforce/ui'

interface Handover {
  id: string
  agentId: string
  agentName: string | null
  runId: string
  task: string
  reason: string
  severity: string
  destination: string
  status: 'OPEN' | 'RESOLVED'
  resolutionNote: string | null
  resolvedAt: string | null
  resolvedBy: string | null
  createdAt: string
}

const SEVERITY: Record<string, 'danger' | 'warning' | 'default'> = { high: 'danger', medium: 'warning', low: 'default' }

/**
 * Work agents handed to a person (they stopped and escalated): what was asked, why the agent
 * stopped, and a way to record that someone dealt with it. Refreshes every 15 seconds.
 */
export function HandoverInbox() {
  const [showHandled, setShowHandled] = useState(false)
  const [items, setItems] = useState<Handover[]>([])
  const [open, setOpen] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/handovers?status=${showHandled ? 'resolved' : 'open'}`)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setItems(body.data ?? [])
      setOpen(body.open ?? 0)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load handovers')
    }
  }, [showHandled])

  useEffect(() => {
    load()
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [load])

  return (
    <section id="handovers" aria-labelledby="handovers-title" className="scroll-mt-20 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id="handovers-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50 flex items-center gap-2">
            <Hand className="w-5 h-5 text-amber-600" aria-hidden="true" />Handed to a person{open ? <Badge variant="warning">{open} open</Badge> : null}
          </h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">Requests an agent stopped on and passed to the team. Deal with each one, then mark it handled.</p>
        </div>
        <button onClick={() => setShowHandled((v) => !v)} className="text-sm text-primary-700 dark:text-primary-300 hover:underline">
          {showHandled ? 'Show open' : 'Show handled'}
        </button>
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 px-4 py-6 text-sm text-neutral-500 text-center">
          {showHandled ? 'Nothing has been marked handled yet.' : 'Nothing handed over. When an agent hits something it shouldn’t decide alone, it appears here.'}
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((h) => <HandoverCard key={h.id} handover={h} onChanged={load} />)}
        </div>
      )}
    </section>
  )
}

function HandoverCard({ handover: h, onChanged }: { handover: Handover; onChanged: () => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const longReason = h.reason.length > 400

  const act = async (action: 'resolve' | 'reopen') => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/handovers/${h.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, note }) })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-white dark:bg-neutral-900 p-4 sm:p-5 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-neutral-900 dark:text-neutral-50">{h.agentName ?? 'An agent'}</span>
        <Badge variant={SEVERITY[h.severity] ?? 'default'} size="sm">{h.severity} priority</Badge>
        <span className="text-neutral-500">{formatDateTime(h.createdAt)}</span>
        <span className="text-neutral-500">· for {h.destination}</span>
      </div>
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500">What was asked</h3>
        <p className="text-sm text-neutral-900 dark:text-neutral-100 whitespace-pre-wrap break-words">{h.task}</p>
      </div>
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500">Why the agent handed it over</h3>
        {longReason ? (
          <details>
            <summary className="cursor-pointer text-sm text-neutral-800 dark:text-neutral-200">{h.reason.slice(0, 280)}… <span className="text-primary-700 dark:text-primary-300">show all</span></summary>
            <p className="mt-2 text-sm text-neutral-800 dark:text-neutral-200 whitespace-pre-wrap break-words">{h.reason}</p>
          </details>
        ) : (
          <p className="text-sm text-neutral-800 dark:text-neutral-200 whitespace-pre-wrap break-words">{h.reason}</p>
        )}
      </div>
      <Link href={`/dashboard/agents/${h.agentId}?run=${encodeURIComponent(h.runId)}`} className="inline-block text-sm text-primary-700 dark:text-primary-300 hover:underline">
        See how the agent got there
      </Link>

      {h.status === 'OPEN' ? (
        <div className="space-y-2 border-t border-neutral-200 dark:border-neutral-800 pt-3">
          <label className="block text-sm">
            <span className="text-neutral-700 dark:text-neutral-300">What did you do? (optional, kept with the handover)</span>
            <textarea id={`handover-note-${h.id}`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={4000}
              className="mt-1 w-full rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm" placeholder="e.g. Called Sam back and sent the revised clause" />
          </label>
          <Button onClick={() => act('resolve')} isLoading={busy} size="sm">
            <CheckCircle2 className="w-4 h-4 mr-2" />Mark as handled
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 dark:border-neutral-800 pt-3 text-sm">
          <p className="text-green-800 dark:text-green-300 min-w-0">
            <CheckCircle2 className="inline w-4 h-4 mr-1 -mt-0.5" aria-hidden="true" />
            Handled{h.resolvedBy ? ` by ${h.resolvedBy}` : ''}{h.resolvedAt ? ` ${formatDateTime(h.resolvedAt)}` : ''}{h.resolutionNote ? `: ${h.resolutionNote}` : ''}
          </p>
          <button onClick={() => act('reopen')} disabled={busy} className="inline-flex items-center gap-1 text-neutral-500 hover:underline">
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />Reopen
          </button>
        </div>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
    </article>
  )
}
