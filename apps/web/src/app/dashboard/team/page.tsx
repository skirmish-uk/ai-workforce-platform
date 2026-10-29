'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, CircleDashed, Eye, Loader2, PauseCircle, Send, Sparkles, Stethoscope } from 'lucide-react'
import { Button, formatDateTime } from '@ai-workforce/ui'
import { KillSwitch } from './KillSwitch'

interface TeamAgent {
  id: string
  name: string
  role: string
  status: string
  version: number
  stage: string
  model: string
  health: 'healthy' | 'attention' | 'watching' | 'idle' | 'paused'
  reasons: string[]
  metrics: { runs: number; completionRate: number | null; escalationRate: number | null; qualityFlaggedRuns: number; rejectionRate: number | null; costUsd: number }
  openRevision: { id: string; status: string } | null
  lastChange: { at: string; version: number; by: string } | null
}

interface TeamResponse {
  selfManagement: { enabled: boolean; autoReview: { enabled: boolean; maxPerDay: number } }
  manager: {
    id: string
    name: string
    status: string
    model: string
    schedule: { cron: string; timezone: string; isActive: boolean } | null
    lastRun: { at: string; status: string; trigger: string; input: string; output: string; costUsd: number | null; runId: string } | null
  } | null
  team: TeamAgent[]
  waiting: { actions: number; changes: number; revisionsInProgress: number; handovers?: number }
  activity: Array<{ action: string; at: string; agentName: string | null; revisionId: string | null; detail: string | null; kind: string | null }>
}

interface RunResult {
  status: string
  output: string | null
  error?: string
  approvalId?: string
  escalation?: { reason: string }
  clarificationQuestions?: string[]
  childRuns: Array<{ agentId: string; status: string }>
  costUsd: number | null
}

const HEALTH = {
  healthy: { label: 'Healthy', icon: CheckCircle2, className: 'text-green-600 dark:text-green-400' },
  attention: { label: 'Needs attention', icon: AlertTriangle, className: 'text-amber-600 dark:text-amber-400' },
  watching: { label: 'Fixed, being watched', icon: Eye, className: 'text-primary-600 dark:text-primary-400' },
  idle: { label: 'No work this week', icon: CircleDashed, className: 'text-neutral-400' },
  paused: { label: 'Paused', icon: PauseCircle, className: 'text-neutral-400' },
} as const

const ACTIVITY: Record<string, string> = {
  MANAGER_REVIEW_TRIGGERED: 'Automatic review started',
  AGENT_REVISION_PROPOSED: 'Change proposed',
  AGENT_REVISION_PROMOTED: 'Change went live',
  AGENT_REVISION_FAILED: 'Change failed its tests',
  AGENT_REVISION_AWAITING_APPROVAL: 'Change needs your approval',
  AGENT_REVISION_ROLLED_BACK: 'Change rolled back',
  AGENT_REVISION_REJECTED: 'Change rejected',
}

const TRIGGER: Record<string, string> = { event: 'automatic repair review', schedule: 'weekly review', manual: 'started by hand', api: 'request from the dashboard' }

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)
const REVIEW_INPUT = 'Weekly workforce review: inspect every agent, fix the most costly recurring problem, report what you proposed and why.'

export default function TeamPage() {
  const [data, setData] = useState<TeamResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [request, setRequest] = useState('')
  const [running, setRunning] = useState<{ label: string } | null>(null)
  const [result, setResult] = useState<RunResult | null>(null)
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/team')
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setData(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the team')
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 30_000)
    return () => { clearInterval(timer); if (poll.current) clearTimeout(poll.current) }
  }, [load])

  const names = new Map((data?.team ?? []).map((a) => [a.id, a.name]))

  const ask = async (input: string, label: string) => {
    if (!data?.manager) return
    setError(null)
    setResult(null)
    setRunning({ label })
    try {
      const res = await fetch(`/api/agents/${data.manager.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      const check = async () => {
        const r = await fetch(`/api/agents/${data.manager!.id}/run?jobId=${encodeURIComponent(body.jobId)}`)
        const s = await r.json()
        if (s.state === 'completed' || s.state === 'failed') {
          setRunning(null)
          if (s.state === 'failed') setError(s.failedReason ?? 'The run failed')
          else setResult(s.result)
          load()
          return
        }
        poll.current = setTimeout(check, 2000)
      }
      poll.current = setTimeout(check, 1500)
    } catch (e) {
      setRunning(null)
      setError(e instanceof Error ? e.message : 'Could not reach the manager')
    }
  }

  if (!data) {
    return error ? <p className="text-red-600" role="alert">{error}</p> : <div className="p-8 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-neutral-400" /></div>
  }
  const m = data.manager
  const waitingTotal = data.waiting.actions + data.waiting.changes

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">Team</h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1">Your AI agents, their health this week, and what the manager is doing about it.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/dashboard/approvals" className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${waitingTotal ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200' : 'border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-400'}`}>
            {data.waiting.actions} action{data.waiting.actions === 1 ? '' : 's'} waiting for you
          </Link>
          {data.waiting.handovers ? (
            <Link href="/dashboard/approvals#handovers" className="px-3 py-1.5 rounded-lg text-sm font-medium border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
              {data.waiting.handovers} handed to a person
            </Link>
          ) : null}
          <Link href="/dashboard/improvements" className="px-3 py-1.5 rounded-lg text-sm font-medium border border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-400">
            {data.waiting.changes} change{data.waiting.changes === 1 ? '' : 's'} to approve · {data.waiting.revisionsInProgress} being tested
          </Link>
          <KillSwitch onChange={load} />
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}

      {m ? (
        <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50 flex items-center gap-2"><Sparkles className="w-5 h-5 text-primary-600" />{m.name}</h2>
              <p className="text-sm text-neutral-500">
                Manages the team: routes requests, reviews results, proposes tested fixes.{' '}
                {data.selfManagement.autoReview.enabled ? `Starts a repair review automatically when an agent has problems (up to ${data.selfManagement.autoReview.maxPerDay} a day).` : 'Automatic reviews are off.'}
                {m.schedule ? ` Weekly review ${m.schedule.isActive ? 'on' : 'off'}.` : ''}
              </p>
            </div>
            <Button variant="outline" onClick={() => ask(REVIEW_INPUT, 'Reviewing the team')} disabled={running !== null}>
              <Stethoscope className="w-4 h-4 mr-2" />Review the team now
            </Button>
          </div>

          <form onSubmit={(e) => { e.preventDefault(); if (request.trim()) { ask(request, 'Routing your request'); setRequest('') } }} className="space-y-2">
            <label htmlFor="team-request" className="block text-sm font-medium text-neutral-900 dark:text-neutral-100">Ask the team</label>
            <div className="flex flex-wrap gap-2">
              <input
                id="team-request"
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                placeholder="e.g. Follow up with Maria at CloudNine about her SEO enquiry"
                className="flex-1 min-w-[16rem] px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <Button type="submit" disabled={!request.trim() || running !== null}><Send className="w-4 h-4 mr-2" />Send</Button>
            </div>
            <p className="text-xs text-neutral-500">{m.name.split(' ')[0]} picks the right agent and reports back. Anything that contacts people or changes records still waits for your approval.</p>
          </form>

          {running && <p className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400" role="status"><Loader2 className="w-4 h-4 animate-spin" />{running.label}… (needs the worker process running)</p>}

          {result && (
            <div className="rounded-lg bg-neutral-50 dark:bg-neutral-800/50 p-4 space-y-2 text-sm">
              {result.childRuns.length > 0 && <p className="text-neutral-500">Handled by: {result.childRuns.map((c) => names.get(c.agentId) ?? c.agentId).join(', ')}</p>}
              {result.output && <p className="whitespace-pre-wrap text-neutral-900 dark:text-neutral-100">{result.output}</p>}
              {result.approvalId && <p><Link href="/dashboard/approvals" className="font-medium text-primary-600 underline">An action is waiting for your approval</Link></p>}
              {result.escalation && <p className="text-amber-700 dark:text-amber-300">Passed to a person: {result.escalation.reason}</p>}
              {result.clarificationQuestions?.length ? <p className="text-neutral-700 dark:text-neutral-300">Needs more information: {result.clarificationQuestions.join(' ')}</p> : null}
              {result.error && <p className="text-red-600 dark:text-red-400">{result.error}</p>}
            </div>
          )}

          {m.lastRun && !result && (
            <details className="text-sm">
              <summary className="cursor-pointer text-neutral-600 dark:text-neutral-400">Latest report · {TRIGGER[m.lastRun.trigger] ?? m.lastRun.trigger} · {formatDateTime(m.lastRun.at)}</summary>
              <p className="mt-2 whitespace-pre-wrap text-neutral-800 dark:text-neutral-200">{m.lastRun.output || m.lastRun.status}</p>
            </details>
          )}
        </section>
      ) : (
        <p className="text-sm text-neutral-500">No manager agent yet. A manager is an agent with management switched on in its contract.</p>
      )}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data.team.map((a) => {
          const h = HEALTH[a.health]
          const Icon = h.icon
          return (
            <article key={a.id} className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/dashboard/agents/${a.id}`} className="font-semibold text-neutral-900 dark:text-neutral-50 hover:text-primary-600">{a.name}</Link>
                  <p className="text-xs text-neutral-500">{a.role} · v{a.version} · {a.stage.replace(/_/g, ' ')}</p>
                </div>
                <span className={`flex items-center gap-1 text-xs font-medium whitespace-nowrap ${h.className}`}><Icon className="w-4 h-4" aria-hidden="true" />{h.label}</span>
              </div>
              {a.reasons.length > 0 && <ul className="text-xs text-amber-700 dark:text-amber-300 list-disc pl-4">{a.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
              <dl className="grid grid-cols-3 gap-2 text-xs">
                <div><dt className="text-neutral-500">Runs (7d)</dt><dd className="font-medium tabular-nums">{a.metrics.runs}</dd></div>
                <div><dt className="text-neutral-500">Completed</dt><dd className="font-medium tabular-nums">{pct(a.metrics.completionRate)}</dd></div>
                <div><dt className="text-neutral-500">To a person</dt><dd className="font-medium tabular-nums">{pct(a.metrics.escalationRate)}</dd></div>
                <div><dt className="text-neutral-500">Flagged</dt><dd className="font-medium tabular-nums">{a.metrics.qualityFlaggedRuns}</dd></div>
                <div><dt className="text-neutral-500">Rejected</dt><dd className="font-medium tabular-nums">{pct(a.metrics.rejectionRate)}</dd></div>
                <div><dt className="text-neutral-500">Cost</dt><dd className="font-medium tabular-nums">${a.metrics.costUsd.toFixed(2)}</dd></div>
              </dl>
              <p className="text-xs text-neutral-500">
                {a.openRevision ? <Link href={`/dashboard/improvements#${a.openRevision.id}`} className="underline">A change is {a.openRevision.status === 'AWAITING_APPROVAL' ? 'waiting for your approval' : 'being tested'}</Link>
                  : a.lastChange ? `Last improved ${formatDateTime(a.lastChange.at)} by ${a.lastChange.by} (v${a.lastChange.version})` : 'No changes yet'}
              </p>
            </article>
          )
        })}
      </section>

      <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-5">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500 mb-3">Recent manager activity</h2>
        {data.activity.length === 0 ? (
          <p className="text-sm text-neutral-500">Nothing yet. Reviews, proposed changes, promotions and rollbacks appear here.</p>
        ) : (
          <ol className="space-y-2">
            {data.activity.map((e, i) => (
              <li key={i} className="text-sm flex flex-wrap gap-x-2">
                <span className="text-neutral-500 tabular-nums">{formatDateTime(e.at)}</span>
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{ACTIVITY[e.action] ?? e.action}</span>
                {e.agentName && <span className="text-neutral-600 dark:text-neutral-400">· {e.agentName}</span>}
                {e.detail && <span className="w-full text-xs text-neutral-500">{String(e.detail).slice(0, 220)}</span>}
                {e.revisionId && <Link href={`/dashboard/improvements#${e.revisionId}`} className="text-xs underline text-primary-600">details</Link>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
