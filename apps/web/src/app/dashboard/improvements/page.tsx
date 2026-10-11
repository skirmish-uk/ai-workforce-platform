'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, RotateCcw, Sparkles } from 'lucide-react'
import { Badge, Button, formatDateTime } from '@ai-workforce/ui'

interface RevisionRow {
  id: string
  changeType: 'create' | 'update' | 'retire'
  status: string
  agentId: string | null
  agentName: string | null
  proposedByAgentId: string | null
  proposedByUserId: string | null
  proposedByName: string | null
  rationale: string
  risk: { riskIncreases?: string[]; violations?: string[] }
  error: string | null
  baseVersion: number | null
  promotedVersion: number | null
  approvalId: string | null
  promotedAt: string | null
  watchUntil: string | null
  createdAt: string
}

interface RevisionDetail extends RevisionRow {
  changes: { changes?: Record<string, unknown>; addEvaluationCases?: unknown[] }
  results: {
    evaluation?: { passed: boolean; passRate: number; failures: Array<{ name: string; failures: string[] }> }
    baseline?: { score: number | null } | null
    replay?: { runs: number; liveBad: number; candidateBad: number } | null
    rollback?: { reason: string; automatic: boolean; at: string }
    watch?: { verdict?: string; runs?: number; degraded?: string[] }
  }
}

const STATUS: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info'; help: string }> = {
  PROPOSED: { label: 'Queued for testing', variant: 'info', help: 'Waiting for the worker to build a test copy.' },
  EVALUATING: { label: 'Testing', variant: 'info', help: 'Running the test suite and replaying recent real requests on a copy of the agent.' },
  AWAITING_APPROVAL: { label: 'Needs your approval', variant: 'warning', help: 'Passed its tests, but it gives the agent more power, so a person must agree.' },
  PROMOTING: { label: 'Going live', variant: 'info', help: '' },
  PROMOTED: { label: 'Live', variant: 'success', help: 'In use. Watched for 72 hours and rolled back automatically if results get worse.' },
  ROLLING_BACK: { label: 'Rolling back', variant: 'warning', help: '' },
  ROLLED_BACK: { label: 'Rolled back', variant: 'default', help: 'The previous version was restored.' },
  FAILED: { label: 'Did not pass', variant: 'danger', help: 'The live agent was not changed.' },
  REJECTED: { label: 'Rejected', variant: 'default', help: 'A person said no. Nothing changed.' },
  EXPIRED: { label: 'Expired', variant: 'default', help: 'Nobody decided in time. Nothing changed.' },
  SUPERSEDED: { label: 'Out of date', variant: 'default', help: 'The agent was edited while this was pending. Nothing changed.' },
  BLOCKED: { label: 'Blocked', variant: 'danger', help: 'Self-management or agents were switched off. Nothing changed.' },
}

const CHANGE_FIELD: Record<string, string> = {
  systemPrompt: 'instructions',
  mission: 'mission',
  role: 'role',
  name: 'name',
  contract: 'rules and limits',
  skills: 'playbooks',
  permissions: 'permissions',
  modelProvider: 'model provider',
  modelName: 'model',
}

function headline(r: RevisionRow): string {
  const who = r.proposedByName ?? (r.proposedByUserId ? 'A team member' : 'Someone')
  if (r.changeType === 'create') return `${who} proposed a new agent`
  if (r.changeType === 'retire') return `${who} proposed pausing ${r.agentName ?? 'an agent'}`
  return `${who} proposed a change to ${r.agentName ?? 'an agent'}`
}

function Detail({ id, canRollBack, onChanged }: { id: string; canRollBack: boolean; onChanged: () => void }) {
  const [detail, setDetail] = useState<RevisionDetail | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/revisions/${id}`).then(async (res) => { if (res.ok) setDetail(await res.json()) })
  }, [id])

  const rollBack = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/revisions/${id}/rollback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not roll back')
    } finally {
      setBusy(false)
    }
  }

  if (!detail) return <p className="text-sm text-neutral-500">Loading…</p>
  const changed = Object.keys(detail.changes?.changes ?? {})
  const newCases = detail.changes?.addEvaluationCases?.length ?? 0
  const ev = detail.results?.evaluation
  const replay = detail.results?.replay

  return (
    <div className="space-y-4 text-sm">
      {detail.changeType !== 'retire' && (
        <p className="text-neutral-700 dark:text-neutral-300">
          Changes: {changed.length ? changed.map((k) => CHANGE_FIELD[k] ?? k).join(', ') : 'none listed'}
          {newCases ? ` · adds ${newCases} test case${newCases === 1 ? '' : 's'}` : ''}
        </p>
      )}
      {ev && (
        <div>
          <p className="font-medium text-neutral-900 dark:text-neutral-100">
            Tests: {Math.round(ev.passRate * 100)}% passed
            {detail.results.baseline?.score != null ? ` (live version: ${Math.round(detail.results.baseline.score * 100)}%)` : ''}
          </p>
          {ev.failures.length > 0 && (
            <ul className="mt-1 list-disc pl-5 space-y-0.5 text-neutral-600 dark:text-neutral-400">
              {ev.failures.slice(0, 6).map((f, i) => <li key={i}><span className="font-medium">{f.name}:</span> {f.failures.join('; ')}</li>)}
            </ul>
          )}
        </div>
      )}
      {replay && replay.runs > 0 && (
        <p className="text-neutral-700 dark:text-neutral-300">
          Replay of {replay.runs} recent real request{replay.runs === 1 ? '' : 's'}: {replay.candidateBad} went wrong with the change, {replay.liveBad} with the live version.
        </p>
      )}
      {detail.results?.rollback && (
        <p className="text-neutral-700 dark:text-neutral-300">
          {detail.results.rollback.automatic ? 'Rolled back automatically' : 'Rolled back'} on {formatDateTime(detail.results.rollback.at)}: {detail.results.rollback.reason}
        </p>
      )}
      {detail.error && <p className="text-red-700 dark:text-red-400">{detail.error}</p>}
      {detail.approvalId && detail.status === 'AWAITING_APPROVAL' && (
        <Link href="/dashboard/approvals" className="inline-block font-medium text-primary-600 hover:underline">Review it in Approvals</Link>
      )}
      {canRollBack && detail.status === 'PROMOTED' && (
        <div className="border-t border-neutral-200 dark:border-neutral-800 pt-4 space-y-2">
          <label htmlFor={`rb-${id}`} className="block text-neutral-600 dark:text-neutral-400">Undo this change</label>
          <div className="flex flex-wrap gap-2">
            <input
              id={`rb-${id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why? e.g. Replies got too long"
              maxLength={1000}
              className="flex-1 min-w-[12rem] px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <Button variant="outline" onClick={rollBack} isLoading={busy} disabled={busy || reason.trim().length < 3}>
              <RotateCcw className="w-4 h-4 mr-2" />Roll back
            </Button>
          </div>
          <p className="text-xs text-neutral-500">Restores the previous version as a new version. Refused if the agent has been changed again since.</p>
          {error && <p className="text-red-600 dark:text-red-400" role="alert">{error}</p>}
        </div>
      )}
    </div>
  )
}

export default function ImprovementsPage() {
  const [rows, setRows] = useState<RevisionRow[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/revisions')
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setRows(body.data ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load improvements')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const hash = window.location.hash.slice(1)
    if (hash) setOpen(hash)
    load()
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [load])

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">Improvements</h1>
        <p className="text-neutral-600 dark:text-neutral-400 mt-1">
          Changes your Workforce Manager proposes. Each one is tested on a copy of the agent first; only changes that do at least as well go live, and anything that gives an agent more power waits for you.
        </p>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}

      {loading ? (
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-8 text-center">
          <div className="animate-spin w-8 h-8 border-2 border-primary-600 border-t-transparent rounded-full mx-auto" />
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-10 text-center space-y-2">
          <Sparkles className="w-8 h-8 mx-auto text-neutral-400" aria-hidden="true" />
          <p className="font-medium text-neutral-900 dark:text-neutral-100">No proposed changes yet</p>
          <p className="text-sm text-neutral-500">Give your Workforce Manager a task like “Weekly workforce review” from the <Link href="/dashboard/agents" className="underline">Agents</Link> page.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => {
            const s = STATUS[r.status] ?? { label: r.status, variant: 'default' as const, help: '' }
            const isOpen = open === r.id
            return (
              <li key={r.id} id={r.id} className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 scroll-mt-4">
                <button onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen} className="w-full text-left p-5 flex gap-3">
                  {isOpen ? <ChevronDown className="w-5 h-5 mt-0.5 text-neutral-400 shrink-0" /> : <ChevronRight className="w-5 h-5 mt-0.5 text-neutral-400 shrink-0" />}
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-neutral-900 dark:text-neutral-50">{headline(r)}</span>
                      <Badge variant={s.variant}>{s.label}</Badge>
                    </div>
                    <p className="text-sm text-neutral-700 dark:text-neutral-300">{r.rationale}</p>
                    {r.risk?.riskIncreases?.length ? (
                      <p className="text-sm text-amber-700 dark:text-amber-400">Adds risk: {r.risk.riskIncreases.join(' ')}</p>
                    ) : null}
                    <p className="text-xs text-neutral-500">
                      {formatDateTime(r.createdAt)}
                      {r.promotedVersion ? ` · now version ${r.promotedVersion}` : ''}
                      {s.help ? ` · ${s.help}` : ''}
                    </p>
                  </div>
                </button>
                {isOpen && (
                  <div className="pb-5 pr-5 pl-[3.25rem]">
                    <Detail id={r.id} canRollBack onChanged={load} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
