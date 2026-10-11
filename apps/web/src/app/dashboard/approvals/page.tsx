'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Clock, ShieldAlert, XCircle } from 'lucide-react'
import { Badge, Button, formatDateTime } from '@ai-workforce/ui'

interface ApprovalSummary {
  action: string
  target: string
  riskClass: string
  sideEffects: string
  material: unknown
  rationale?: string
  policyReason: string
  evidence?: Record<string, unknown>
}

interface Approval {
  id: string
  action: string
  level: string
  status: string
  kind: string
  expiresAt: string | null
  agentId: string | null
  agentName: string | null
  runId: string | null
  revisionId?: string
  decidedAt: string | null
  reason: string | null
  createdAt: string
  summary: ApprovalSummary | null
}

const RISK_LABEL: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' }> = {
  read: { label: 'Read only', variant: 'default' },
  draft: { label: 'Draft', variant: 'info' },
  write_reversible: { label: 'Reversible change', variant: 'info' },
  external_communication: { label: 'Contacts someone outside', variant: 'warning' },
  destructive: { label: 'Deletes data', variant: 'danger' },
  write_irreversible: { label: 'Permanent change', variant: 'danger' },
  agent_revision: { label: 'Changes an agent', variant: 'warning' },
}

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  PENDING: 'warning',
  APPROVED: 'info',
  EXECUTING: 'info',
  EXECUTED: 'success',
  REJECTED: 'default',
  EXPIRED: 'default',
  EXECUTION_FAILED: 'danger',
}

/** "gmail__send_email" → "Send email" */
function actionLabel(action: string): string {
  if (action === 'agent_revision') return 'Change an agent'
  const name = action.includes('__') ? action.split('__')[1] : action
  const words = name.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function timeLeft(expiresAt: string | null): string | null {
  if (!expiresAt) return null
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (ms <= 0) return 'expired'
  const hours = Math.floor(ms / 3_600_000)
  if (hours >= 24) return `expires in ${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours >= 1) return `expires in ${hours}h`
  return `expires in ${Math.max(1, Math.round(ms / 60_000))} min`
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(', ')
  return JSON.stringify(value, null, 2)
}

/** Shows what will actually happen: an email preview for email actions, otherwise the fields. */
function Material({ material }: { material: unknown }) {
  if (!material || typeof material !== 'object') {
    return <pre className="whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-300">{stringify(material)}</pre>
  }
  const m = material as Record<string, unknown>
  if ('to' in m && ('body' in m || 'subject' in m)) {
    return (
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 px-4 py-3 text-sm bg-neutral-50 dark:bg-neutral-800/50 border-b border-neutral-200 dark:border-neutral-700">
          <dt className="text-neutral-500">To</dt>
          <dd className="text-neutral-900 dark:text-neutral-100 break-words">{stringify(m.to)}</dd>
          {m.cc !== undefined && (<><dt className="text-neutral-500">Cc</dt><dd className="break-words">{stringify(m.cc)}</dd></>)}
          <dt className="text-neutral-500">Subject</dt>
          <dd className="font-medium text-neutral-900 dark:text-neutral-100 break-words">{stringify(m.subject ?? '')}</dd>
        </dl>
        <pre className="px-4 py-3 whitespace-pre-wrap font-sans text-sm text-neutral-800 dark:text-neutral-200 max-h-80 overflow-auto">{stringify(m.body ?? '')}</pre>
      </div>
    )
  }
  if ('riskIncreases' in m) {
    const risks = Array.isArray(m.riskIncreases) ? (m.riskIncreases as string[]) : []
    return (
      <ul className="list-disc pl-5 space-y-1 text-sm text-neutral-800 dark:text-neutral-200">
        {risks.map((r, i) => <li key={i}>{r}</li>)}
      </ul>
    )
  }
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
      {Object.entries(m).map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-neutral-500">{key}</dt>
          <dd className="min-w-0"><pre className="whitespace-pre-wrap break-words font-sans text-neutral-800 dark:text-neutral-200">{stringify(value)}</pre></dd>
        </div>
      ))}
    </dl>
  )
}

function ApprovalCard({ approval, onDecided }: { approval: Approval; onDecided: () => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const s = approval.summary
  const risk = RISK_LABEL[s?.riskClass ?? ''] ?? { label: s?.riskClass ?? 'Unknown risk', variant: 'default' as const }
  const pending = approval.status === 'PENDING'
  const left = pending ? timeLeft(approval.expiresAt) : null
  const isRevision = approval.kind === 'agent_revision'
  const title = isRevision
    ? approval.agentId ? `Proposed change to ${approval.agentName ?? 'an agent'}` : 'Proposed new agent'
    : `${approval.agentName ?? 'An agent'} wants to ${actionLabel(approval.action).toLowerCase()}`

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision)
    setError(null)
    try {
      const res = await fetch(`/api/approvals/${approval.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      onDecided()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setBusy(null)
    }
  }

  return (
    <article className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-5 space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">{title}</h2>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">
            {s?.target && !isRevision ? `${s.target} · ` : ''}{isRevision ? 'proposed by your Workforce Manager · ' : ''}requested {formatDateTime(approval.createdAt)}
            {left ? ` · ${left}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={risk.variant}>{risk.label}</Badge>
          {!pending && <Badge variant={STATUS_VARIANT[approval.status] ?? 'default'}>{approval.status.replace(/_/g, ' ').toLowerCase()}</Badge>}
        </div>
      </header>

      {s?.sideEffects && (
        <p className="flex gap-2 text-sm text-neutral-700 dark:text-neutral-300">
          <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" aria-hidden="true" />
          <span><span className="font-medium">If approved:</span> {s.sideEffects}</span>
        </p>
      )}

      {s?.material !== undefined && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500 mb-2">
            {isRevision ? 'What this change adds' : 'Exactly what will run'}
          </h3>
          <Material material={s.material} />
        </section>
      )}

      {s?.rationale && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500 mb-1">{isRevision ? 'Why it was proposed' : 'The agent’s reasoning'}</h3>
          <p className="text-sm text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap">{s.rationale}</p>
        </section>
      )}

      <p className="text-xs text-neutral-500">
        Why it needs you: {s?.policyReason ?? approval.level}
        {approval.runId && approval.agentId && !isRevision && (
          <> · <Link className="underline hover:text-primary-600" href={`/dashboard/agents/${approval.agentId}?run=${encodeURIComponent(approval.runId)}`}>View the run</Link></>
        )}
        {approval.revisionId && (
          <> · <Link className="underline hover:text-primary-600" href={`/dashboard/improvements#${approval.revisionId}`}>View the proposed change</Link></>
        )}
      </p>

      {pending ? (
        <div className="space-y-3 border-t border-neutral-200 dark:border-neutral-800 pt-4">
          <label htmlFor={`reason-${approval.id}`} className="block text-sm text-neutral-600 dark:text-neutral-400">Note for the record (optional)</label>
          <input
            id={`reason-${approval.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
            placeholder="e.g. Checked the price with the account manager"
            className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => decide('approve')} isLoading={busy === 'approve'} disabled={busy !== null}>
              <CheckCircle2 className="w-4 h-4 mr-2" />{isRevision ? 'Approve change' : 'Approve and run'}
            </Button>
            <Button variant="outline" onClick={() => decide('reject')} isLoading={busy === 'reject'} disabled={busy !== null}>
              <XCircle className="w-4 h-4 mr-2" />Reject
            </Button>
          </div>
          <p className="text-xs text-neutral-500">
            {isRevision ? 'Approving puts this tested change live as a new version. You can roll it back from Improvements.' : 'Approving runs this exact action once. Nothing else is approved.'}
          </p>
        </div>
      ) : (
        approval.decidedAt && (
          <p className="text-sm text-neutral-500 border-t border-neutral-200 dark:border-neutral-800 pt-3">
            Decided {formatDateTime(approval.decidedAt)}{approval.reason ? ` · “${approval.reason}”` : ''}
          </p>
        )
      )}
    </article>
  )
}

export default function ApprovalsPage() {
  const [tab, setTab] = useState<'waiting' | 'history'>('waiting')
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(tab === 'waiting' ? '/api/approvals?status=PENDING' : '/api/approvals')
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      const rows: Approval[] = body.data ?? []
      setApprovals(tab === 'waiting' ? rows : rows.filter((a) => a.status !== 'PENDING'))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load approvals')
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => {
    setLoading(true)
    load()
    // Agents can ask for approval at any time; refresh while the page is open.
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [load])

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">Approvals</h1>
        <p className="text-neutral-600 dark:text-neutral-400 mt-1">Actions your agents want to take that need a person to say yes first.</p>
      </div>

      <div className="flex gap-2" role="tablist" aria-label="Approvals">
        {(['waiting', 'history'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === t ? 'bg-primary-600 text-white' : 'bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800'}`}
          >
            {t === 'waiting' ? 'Waiting for you' : 'Decided'}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}

      {loading ? (
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-8 text-center">
          <div className="animate-spin w-8 h-8 border-2 border-primary-600 border-t-transparent rounded-full mx-auto" />
        </div>
      ) : approvals.length === 0 ? (
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-10 text-center space-y-2">
          <Clock className="w-8 h-8 mx-auto text-neutral-400" aria-hidden="true" />
          <p className="font-medium text-neutral-900 dark:text-neutral-100">{tab === 'waiting' ? 'Nothing is waiting for you' : 'No decisions yet'}</p>
          <p className="text-sm text-neutral-500">
            {tab === 'waiting' ? 'When an agent wants to send an email, book a meeting or change a record, the request appears here.' : 'Approved and rejected requests appear here.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {approvals.map((a) => <ApprovalCard key={a.id} approval={a} onDecided={load} />)}
        </div>
      )}
    </div>
  )
}
