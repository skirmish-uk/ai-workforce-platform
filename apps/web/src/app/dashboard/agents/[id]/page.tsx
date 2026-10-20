'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, CheckCircle2, CircleDashed, Loader2, Play, X, XCircle } from 'lucide-react'
import { Badge, Button, formatDateTime } from '@ai-workforce/ui'
import { VoicePanel } from './VoicePanel'
import { VoiceClone } from './VoiceClone'

interface AgentDetail {
  id: string
  name: string
  role: string
  mission: string
  status: string
  version: number
  modelProvider: string
  modelName: string
  config: { contract?: { autonomyStage?: string; allowedTools?: string[]; scope?: { inScope?: string[]; outOfScope?: string[] } }; voice?: { enabled?: boolean } }
  skills: Array<{ skill: { name: string; version: string; requiredTools: string[] } }>
  permissions: Array<{ action: string; level: string }>
}

interface ToolCall { tool: string; status: string; reason?: string; error?: string }
interface Phase { phase: string; at: string; notes: string[] }
interface DodResult { type: string; passed: boolean; detail: string }

interface Run {
  at: string
  runId: string
  status?: string
  trigger?: string
  input?: string
  output?: string | null
  error?: string
  costUsd?: number | null
  durationMs?: number
  iterations?: number
  tokensUsed?: { input: number; output: number }
  model?: { provider: string; model: string }
  stage?: string
  agentVersion?: number
  dryRun?: boolean
  toolCalls?: ToolCall[]
  phases?: Phase[]
  dodPassed?: boolean
  dodResults?: DodResult[]
  approvalId?: string
  clarificationQuestions?: string[]
  escalation?: { reason: string; severity: string; destination: string }
  handover?: { id: string; status: string; resolutionNote: string | null; resolvedAt: string | null } | null
  reasoning?: ReasoningStep[]
}

interface ReasoningStep {
  kind: 'model' | 'tool'
  text?: string
  thinking?: string
  calls?: Array<{ tool: string; input: unknown }>
  tool?: string
  ok?: boolean
  result?: string
}

/** Short, readable version of a tool call's arguments. */
function argsSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const parts = Object.entries(input as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  const text = parts.join(' · ')
  return text.length > 220 ? `${text.slice(0, 217)}…` : text
}

/** The run's reasoning chain: what the model thought and said, what it asked tools for, and what came back. */
function ReasoningChain({ steps }: { steps: ReasoningStep[] }) {
  return (
    <ol className="mt-3 space-y-3 border-l-2 border-primary-200 dark:border-primary-800 pl-4">
      {steps.map((s, i) => (
        <li key={i} className="space-y-1 min-w-0">
          {s.kind === 'model' ? (
            <>
              <p className="text-xs font-medium uppercase tracking-wider text-primary-700 dark:text-primary-300">{s.calls?.length ? 'Decided' : 'Answered'}</p>
              {s.thinking && <p className="text-sm italic text-neutral-600 dark:text-neutral-400 whitespace-pre-wrap break-words">{s.thinking}</p>}
              {s.text && <p className="text-sm text-neutral-800 dark:text-neutral-200 whitespace-pre-wrap break-words">{s.text}</p>}
              {s.calls?.map((c, j) => (
                <p key={j} className="text-sm text-neutral-700 dark:text-neutral-300 break-words">
                  → <span className="font-medium">{toolLabel(c.tool)}</span>
                  {argsSummary(c.input) && <span className="text-neutral-500"> ({argsSummary(c.input)})</span>}
                </p>
              ))}
              {!s.text && !s.thinking && !s.calls?.length && <p className="text-sm text-neutral-500">(no visible text)</p>}
            </>
          ) : (
            <>
              <p className={`text-xs font-medium uppercase tracking-wider ${s.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                {s.ok ? 'Got back' : 'Problem'} from {toolLabel(s.tool ?? 'tool')}
              </p>
              <p className="text-xs font-mono text-neutral-600 dark:text-neutral-400 whitespace-pre-wrap break-all">{s.result}</p>
            </>
          )}
        </li>
      ))}
    </ol>
  )
}

const STATUS: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' }> = {
  completed: { label: 'Completed', variant: 'success' },
  partial: { label: 'Partly done', variant: 'warning' },
  needs_clarification: { label: 'Asked a question', variant: 'info' },
  escalated: { label: 'Handed to a person', variant: 'warning' },
  approval_required: { label: 'Waiting for approval', variant: 'warning' },
  blocked: { label: 'Blocked', variant: 'danger' },
  cancelled: { label: 'Cancelled', variant: 'default' },
  failed: { label: 'Failed', variant: 'danger' },
}

const TOOL_STATUS: Record<string, string> = {
  completed: 'done',
  simulated: 'simulated (sandbox or test run: nothing real happened)',
  denied: 'not allowed',
  error: 'error',
  approval_required: 'sent for approval',
  proposed: 'proposed only',
  duplicate_suppressed: 'skipped: already done',
  unknown_outcome: 'outcome unknown',
}

const PHASE_LABEL: Record<string, string> = {
  diagnose: 'Check the request',
  assemble: 'Gather tools and knowledge',
  act: 'Work on it',
  assess: 'Check the result',
}

function toolLabel(tool: string): string {
  const [adapter, action] = tool.includes('__') ? tool.split('__') : ['', tool]
  const words = action.replace(/_/g, ' ')
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}${adapter && adapter !== 'platform' ? ` (${adapter.replace(/-/g, ' ')})` : ''}`
}

function money(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '—'
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

function RunTrace({ run, agentId, focus }: { run: Run; agentId: string; focus?: boolean }) {
  const status = STATUS[run.status ?? ''] ?? { label: run.status ?? 'Unknown', variant: 'default' as const }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={status.variant}>{status.label}</Badge>
        {run.dryRun && <Badge variant="outline">Test run</Badge>}
        <span className="text-sm text-neutral-500">{formatDateTime(run.at)}</span>
      </div>

      <section>
        <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500 mb-1">Task</h3>
        <p className="text-sm text-neutral-800 dark:text-neutral-200 whitespace-pre-wrap">{run.input}</p>
      </section>

      {(run.output || run.error) && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500 mb-1">{run.output ? 'Answer' : 'What went wrong'}</h3>
          {run.output && <p className="text-sm text-neutral-900 dark:text-neutral-100 whitespace-pre-wrap">{run.output}</p>}
          {run.error && <p className="text-sm text-red-700 dark:text-red-400 whitespace-pre-wrap mt-1">{run.error}</p>}
        </section>
      )}

      {run.approvalId && (
        <p className="text-sm rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 px-4 py-3">
          This run paused for a human decision. <Link href="/dashboard/approvals" className="underline font-medium">Open approvals</Link>
        </p>
      )}
      {run.clarificationQuestions?.length ? (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500 mb-1">Questions for you</h3>
          <ul className="list-disc pl-5 text-sm space-y-1">{run.clarificationQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
        </section>
      ) : null}
      {run.escalation && (
        <section className="rounded-lg bg-amber-50 dark:bg-amber-900/20 px-4 py-3 space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-amber-800 dark:text-amber-300">Handed to {run.escalation.destination}</h3>
          <p className="text-sm text-amber-950 dark:text-amber-100 whitespace-pre-wrap break-words">{run.escalation.reason}</p>
          {run.handover?.status === 'RESOLVED' ? (
            <p className="text-sm text-green-800 dark:text-green-300">
              <CheckCircle2 className="inline w-4 h-4 mr-1 -mt-0.5" aria-hidden="true" />
              Handled{run.handover.resolvedAt ? ` ${formatDateTime(run.handover.resolvedAt)}` : ''}{run.handover.resolutionNote ? `: ${run.handover.resolutionNote}` : ''}
            </p>
          ) : run.handover ? (
            <p className="text-sm text-amber-900 dark:text-amber-200">
              Waiting for someone to deal with it. <Link href="/dashboard/approvals#handovers" className="underline font-medium">Open the handover inbox</Link>
            </p>
          ) : (
            <p className="text-xs text-amber-800/80 dark:text-amber-300/80">{run.dryRun ? 'Test run: no handover was created.' : 'This run is older than the handover inbox.'}</p>
          )}
        </section>
      )}

      {run.toolCalls?.length ? (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500 mb-2">Actions</h3>
          <ol className="space-y-2">
            {run.toolCalls.map((call, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <span className="font-mono text-xs text-neutral-400 tabular-nums">{i + 1}</span>
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{toolLabel(call.tool)}</span>
                <span className="text-neutral-500">{TOOL_STATUS[call.status] ?? call.status}</span>
                {(call.reason || call.error) && <span className="w-full pl-6 text-xs text-neutral-500">{call.error ?? call.reason}</span>}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {run.dodResults?.length ? (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500 mb-2">Checks on the result</h3>
          <ul className="space-y-1.5">
            {run.dodResults.map((r, i) => (
              <li key={i} className="flex gap-2 text-sm">
                {r.passed ? <CheckCircle2 className="w-4 h-4 mt-0.5 text-green-600 shrink-0" aria-label="passed" /> : <XCircle className="w-4 h-4 mt-0.5 text-red-600 shrink-0" aria-label="failed" />}
                <span className="text-neutral-700 dark:text-neutral-300">{r.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {run.reasoning?.length ? (
        <details className="group" open={focus || run.reasoning.length <= 6}>
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wider text-neutral-500">How it got there ({run.reasoning.length} steps)</summary>
          <ReasoningChain steps={run.reasoning} />
        </details>
      ) : null}

      {run.phases?.length ? (
        <details className="group" open={focus && !run.reasoning?.length}>
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wider text-neutral-500">Step-by-step trace</summary>
          <ol className="mt-3 space-y-3 border-l border-neutral-200 dark:border-neutral-700 pl-4">
            {run.phases.map((p, i) => (
              <li key={i}>
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{PHASE_LABEL[p.phase] ?? p.phase}</p>
                <ul className="mt-1 space-y-0.5">
                  {p.notes.map((n, j) => <li key={j} className="text-xs font-mono text-neutral-500 break-words">{n}</li>)}
                </ul>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm border-t border-neutral-200 dark:border-neutral-800 pt-4">
        <div><dt className="text-neutral-500 text-xs">Cost</dt><dd className="tabular-nums">{money(run.costUsd)}</dd></div>
        <div><dt className="text-neutral-500 text-xs">Time</dt><dd className="tabular-nums">{run.durationMs !== undefined ? `${(run.durationMs / 1000).toFixed(1)}s` : '—'}</dd></div>
        <div><dt className="text-neutral-500 text-xs">Model</dt><dd className="truncate">{run.model?.model ?? '—'}</dd></div>
        <div><dt className="text-neutral-500 text-xs">Autonomy</dt><dd>{run.stage?.replace(/_/g, ' ') ?? '—'}</dd></div>
      </dl>
      <p className="text-xs text-neutral-400 font-mono break-all">run {run.runId} · agent {agentId} v{run.agentVersion ?? '?'}</p>
    </div>
  )
}

export default function AgentPage() {
  const { id } = useParams<{ id: string }>()
  const [agent, setAgent] = useState<AgentDetail | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [task, setTask] = useState('')
  const [running, setRunning] = useState<{ jobId: string; state: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  /** A run id, or "all", waiting for the person to confirm its removal from the list. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Removes runs from this list only; the platform keeps the record (costs, audit trail).
  const removeRuns = async (target: string) => {
    setRemoveError(null)
    const query = target === 'all' ? 'all=1' : `run=${encodeURIComponent(target)}`
    try {
      const res = await fetch(`/api/agents/${id}/runs?${query}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(res.status === 403 ? 'You don’t have permission to remove runs.' : 'Could not remove that from the list.')
      const next = target === 'all' ? [] : runs.filter((r) => r.runId !== target)
      setRuns(next)
      // Don't leave the removed run in the address, or a refresh would show it again.
      const inUrl = new URLSearchParams(window.location.search).get('run')
      if (inUrl && (target === 'all' || inUrl === target)) window.history.replaceState(null, '', window.location.pathname)
      setSelected((current) => (current && next.some((r) => r.runId === current) ? current : next[0]?.runId ?? null))
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : 'Could not remove that from the list.')
    } finally {
      setConfirmRemove(null)
    }
  }

  const loadRuns = useCallback(async (select?: string) => {
    const res = await fetch(`/api/agents/${id}/runs?limit=25`)
    if (!res.ok) return
    const body = await res.json()
    let rows: Run[] = body.data ?? []
    // A run asked for by id (a link, or "See how it answered") may be older than the list.
    // One someone removed from the list stays out of it, even when the address still names it.
    if (select && !rows.some((r) => r.runId === select)) {
      const one = await fetch(`/api/agents/${id}/runs?run=${encodeURIComponent(select)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      if (one?.data?.[0] && !one.data[0].hidden) rows = [one.data[0], ...rows]
      else {
        select = undefined
        window.history.replaceState(null, '', window.location.pathname)
      }
    }
    setRuns(rows)
    setSelected((current) => select ?? current ?? rows[0]?.runId ?? null)
  }, [id])

  // "See how it answered" in the voice panel: show that run with its reasoning open, in view.
  const [focusRun, setFocusRun] = useState<string | null>(null)
  const traceRef = useRef<HTMLElement | null>(null)
  const showRun = useCallback(async (runId: string) => {
    await loadRuns(runId)
    setFocusRun(runId)
    window.history.replaceState(null, '', `?run=${encodeURIComponent(runId)}`)
    requestAnimationFrame(() => traceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }, [loadRuns])

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('run')
    fetch(`/api/agents/${id}`).then(async (res) => {
      if (res.status === 404 || res.status === 403) { setNotFound(true); return }
      if (res.ok) setAgent(await res.json())
    })
    loadRuns(fromUrl ?? undefined)
    return () => { if (pollRef.current) clearTimeout(pollRef.current) }
  }, [id, loadRuns])

  const poll = useCallback((jobId: string) => {
    pollRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/agents/${id}/run?jobId=${encodeURIComponent(jobId)}`)
        const body = await res.json()
        if (!res.ok) throw new Error(body.error ?? 'Could not check the run')
        if (body.state === 'completed' || body.state === 'failed') {
          setRunning(null)
          if (body.state === 'failed') setError(body.failedReason ?? 'The run failed before it could finish.')
          await loadRuns(jobId)
          return
        }
        setRunning({ jobId, state: body.state })
        poll(jobId)
      } catch (e) {
        setRunning(null)
        setError(e instanceof Error ? e.message : 'Could not check the run')
      }
    }, 1500)
  }, [id, loadRuns])

  const start = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!task.trim()) return
    setError(null)
    try {
      const res = await fetch(`/api/agents/${id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: task }) })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setRunning({ jobId: body.jobId, state: 'waiting' })
      setTask('')
      poll(body.jobId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the run')
    }
  }

  if (notFound) {
    return (
      <div className="space-y-4">
        <Link href="/dashboard/agents" className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-primary-600"><ArrowLeft className="w-4 h-4" />Agents</Link>
        <p className="text-neutral-700 dark:text-neutral-300">This agent doesn’t exist or you don’t have access to it.</p>
      </div>
    )
  }

  const contract = agent?.config?.contract
  const selectedRun = runs.find((r) => r.runId === selected) ?? null
  const tools = Array.from(new Set(agent?.skills.flatMap((s) => s.skill.requiredTools) ?? []))

  return (
    <div className="space-y-6">
      <Link href="/dashboard/agents" className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-primary-600"><ArrowLeft className="w-4 h-4" />Agents</Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">{agent?.name ?? 'Loading…'}</h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1">{agent?.role}</p>
          {agent?.mission && <p className="text-sm text-neutral-500 mt-2 max-w-2xl">{agent.mission}</p>}
        </div>
        {agent && (
          <div className="flex flex-wrap gap-2">
            <Badge>{agent.status.toLowerCase()}</Badge>
            <Badge variant="info">{(contract?.autonomyStage ?? 'approval_gated').replace(/_/g, ' ')}</Badge>
            <Badge variant="outline">v{agent.version}</Badge>
          </div>
        )}
      </header>

      {/* Voice agents: the conversation sits at the top, so replies never need scrolling to. */}
      {agent?.config?.voice?.enabled && <VoicePanel agentId={id} agentName={agent.name} onShowRun={showRun} />}
      {agent?.config?.voice?.enabled && <VoiceClone agentId={id} agentName={agent.name} />}

      {agent && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-4">
            <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500 mb-2">Can work with</h2>
            <div className="flex flex-wrap gap-1.5">
              {tools.length ? tools.map((t) => <Badge key={t} variant="outline" size="sm">{toolLabel(t)}</Badge>) : <span className="text-sm text-neutral-500">No tools</span>}
            </div>
          </div>
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-4">
            <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500 mb-2">Never does</h2>
            <ul className="text-sm text-neutral-700 dark:text-neutral-300 list-disc pl-5 space-y-0.5">
              {(contract?.scope?.outOfScope ?? ['Not specified']).map((s) => <li key={s}>{s}</li>)}
            </ul>
          </div>
        </div>
      )}

      <form onSubmit={start} className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
        <label htmlFor="task" className="block text-sm font-medium text-neutral-900 dark:text-neutral-100">Give {agent?.name.split(' ')[0] ?? 'the agent'} a task</label>
        <textarea
          id="task"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={3}
          placeholder="e.g. A new lead came in: Priya Shah, priya@example.com, interested in a website refresh. Follow up."
          className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!task.trim() || running !== null}>
            {running ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
            {running ? 'Working…' : 'Run'}
          </Button>
          {running && <span className="text-sm text-neutral-500">{running.state === 'active' ? 'The agent is working on it.' : 'Queued. Is the worker process running?'}</span>}
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
        <p className="text-xs text-neutral-500">Anything that contacts people or changes records waits for your approval first.</p>
      </form>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
            <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">Recent runs</h2>
            {runs.length > 0 && (confirmRemove === 'all' ? (
              <span className="flex items-center gap-2 text-xs">
                <span className="text-neutral-600 dark:text-neutral-300">Remove all from this list?</span>
                <button onClick={() => removeRuns('all')} className="font-medium text-red-600 dark:text-red-400 hover:underline">Remove</button>
                <button onClick={() => setConfirmRemove(null)} className="text-neutral-500 hover:underline">Cancel</button>
              </span>
            ) : (
              <button onClick={() => setConfirmRemove('all')} className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 hover:underline">Clear all</button>
            ))}
          </div>
          {removeError && <p className="px-4 pt-3 text-xs text-red-600 dark:text-red-400" role="alert">{removeError}</p>}
          {runs.length === 0 ? (
            <p className="px-4 py-6 text-sm text-neutral-500 flex items-center gap-2"><CircleDashed className="w-4 h-4" />No runs yet. Give it a task above.</p>
          ) : (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 max-h-[32rem] overflow-auto">
              {runs.map((r) => {
                const s = STATUS[r.status ?? ''] ?? { label: r.status ?? '?', variant: 'default' as const }
                return (
                  <li key={r.runId} className={`relative ${selected === r.runId ? 'bg-primary-50 dark:bg-primary-900/20' : ''}`}>
                    <button
                      onClick={() => setSelected(r.runId)}
                      aria-current={selected === r.runId}
                      className="w-full text-left pl-4 pr-10 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant={s.variant} size="sm">{s.label}</Badge>
                        <span className="text-xs text-neutral-500 tabular-nums">{money(r.costUsd)}</span>
                      </div>
                      <p className="text-sm text-neutral-800 dark:text-neutral-200 mt-1 line-clamp-2">{r.input}</p>
                      <p className="text-xs text-neutral-500 mt-0.5">{formatDateTime(r.at)}</p>
                    </button>
                    {confirmRemove === r.runId ? (
                      <div className="flex flex-wrap items-center gap-3 px-4 pb-3 text-xs">
                        <span className="text-neutral-600 dark:text-neutral-300">Remove from this list?</span>
                        <button onClick={() => removeRuns(r.runId)} className="font-medium text-red-600 dark:text-red-400 hover:underline">Remove</button>
                        <button onClick={() => setConfirmRemove(null)} className="text-neutral-500 hover:underline">Cancel</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmRemove(r.runId)}
                        aria-label="Remove this run from the list"
                        title="Remove from list"
                        className="absolute right-2 top-2.5 rounded-md p-1.5 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 dark:hover:text-neutral-200 dark:hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
                      >
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
        <section ref={traceRef} className="scroll-mt-20 bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-5 min-w-0">
          {selectedRun ? <RunTrace key={selectedRun.runId} run={selectedRun} agentId={id} focus={focusRun === selectedRun.runId} /> : <p className="text-sm text-neutral-500">Select a run to see what the agent did, step by step.</p>}
        </section>
      </div>
    </div>
  )
}
