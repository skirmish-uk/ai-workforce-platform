'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, CheckCircle2, CircleDashed, Loader2, Play, XCircle } from 'lucide-react'
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

function RunTrace({ run, agentId }: { run: Run; agentId: string }) {
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
        <p className="text-sm text-neutral-700 dark:text-neutral-300">Handed to {run.escalation.destination}: {run.escalation.reason}</p>
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

      {run.phases?.length ? (
        <details className="group">
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
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadRuns = useCallback(async (select?: string) => {
    const res = await fetch(`/api/agents/${id}/runs?limit=25`)
    if (!res.ok) return
    const body = await res.json()
    const rows: Run[] = body.data ?? []
    setRuns(rows)
    setSelected((current) => select ?? current ?? rows[0]?.runId ?? null)
  }, [id])

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
      {agent?.config?.voice?.enabled && <VoicePanel agentId={id} agentName={agent.name} />}
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
          <h2 className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-neutral-500 border-b border-neutral-200 dark:border-neutral-800">Recent runs</h2>
          {runs.length === 0 ? (
            <p className="px-4 py-6 text-sm text-neutral-500 flex items-center gap-2"><CircleDashed className="w-4 h-4" />No runs yet. Give it a task above.</p>
          ) : (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 max-h-[32rem] overflow-auto">
              {runs.map((r) => {
                const s = STATUS[r.status ?? ''] ?? { label: r.status ?? '?', variant: 'default' as const }
                return (
                  <li key={r.runId}>
                    <button
                      onClick={() => setSelected(r.runId)}
                      aria-current={selected === r.runId}
                      className={`w-full text-left px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 ${selected === r.runId ? 'bg-primary-50 dark:bg-primary-900/20' : ''}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant={s.variant} size="sm">{s.label}</Badge>
                        <span className="text-xs text-neutral-500 tabular-nums">{money(r.costUsd)}</span>
                      </div>
                      <p className="text-sm text-neutral-800 dark:text-neutral-200 mt-1 line-clamp-2">{r.input}</p>
                      <p className="text-xs text-neutral-500 mt-0.5">{formatDateTime(r.at)}</p>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
        <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-5 min-w-0">
          {selectedRun ? <RunTrace run={selectedRun} agentId={id} /> : <p className="text-sm text-neutral-500">Select a run to see what the agent did, step by step.</p>}
        </section>
      </div>
    </div>
  )
}
