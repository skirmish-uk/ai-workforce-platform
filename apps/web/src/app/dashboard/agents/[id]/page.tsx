'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, CheckCircle2, CircleDashed, Loader2, MessageSquare, Mic, Play, Send, X, XCircle } from 'lucide-react'
import { Badge, Button, formatDateTime } from '@ai-workforce/ui'
import { VoicePanel } from './VoicePanel'
import { VoiceClone } from './VoiceClone'
import { agentStatus } from '../../../../lib/agent-status'

interface AgentDetail {
  id: string
  name: string
  role: string
  mission: string
  status: string
  version: number
  modelProvider: string
  modelName: string
  config: { contract?: { autonomyStage?: string; allowedTools?: string[]; scope?: { inScope?: string[]; outOfScope?: string[] }; management?: { enabled?: boolean }; handoffs?: { enabled?: boolean }; delegation?: { enabled?: boolean }; memory?: { mode?: string } }; voice?: { enabled?: boolean } }
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
  /** The person's own words in this run (the input can also carry the conversation so far). */
  message?: string
  conversationId?: string
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
  approval?: { id: string; status: string; action: string; material: unknown } | null
  reasoning?: ReasoningStep[]
}

interface Conversation {
  id: string
  /** False for a conversation guessed from older runs that weren't recorded with one. */
  recorded: boolean
  kind: 'voice' | 'text'
  title: string
  startedAt: string
  lastAt: string
  costUsd: number
  /** Oldest first. */
  runs: Run[]
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
        <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500 mb-1">{run.trigger === 'voice' ? 'Heard' : 'Task'}</h3>
        <p className="text-sm text-neutral-800 dark:text-neutral-200 whitespace-pre-wrap">{run.message || run.input}</p>
        {run.input && run.message && run.input !== run.message && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-neutral-500">What the agent was given (with the conversation so far)</summary>
            <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400 whitespace-pre-wrap break-words">{run.input}</p>
          </details>
        )}
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

/** What the agent said back in a run, or what happened instead. */
function answerText(run: Run): string {
  if (run.output) return run.output
  if (run.clarificationQuestions?.length) return run.clarificationQuestions.join('\n')
  if (run.escalation) return `Handed to ${run.escalation.destination}: ${run.escalation.reason}`
  if (run.approvalId) return 'Waiting for your approval before going ahead.'
  if (run.error) return run.error
  return STATUS[run.status ?? '']?.label ?? 'No answer'
}

const APPROVAL_STATE: Record<string, string> = {
  PENDING: 'Waiting for your approval',
  APPROVED: 'Approved',
  EXECUTING: 'Approved, running now',
  EXECUTED: 'Approved and done',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  EXECUTION_FAILED: 'Approved, but it failed',
}

/** What a run proposed and is waiting on (or was decided): an email draft, or the action's details. */
function ProposedAction({ approval }: { approval: NonNullable<Run['approval']> }) {
  const m = approval.material && typeof approval.material === 'object' ? approval.material as Record<string, unknown> : null
  const text = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(text).join(', ') : v === undefined || v === null ? '' : JSON.stringify(v))
  return (
    <div className="max-w-[85%] w-full rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10 text-sm overflow-hidden">
      <p className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b border-amber-200 dark:border-amber-800">
        <span className="font-medium text-amber-900 dark:text-amber-200">{toolLabel(approval.action)}: {APPROVAL_STATE[approval.status] ?? approval.status.toLowerCase()}</span>
        {approval.status === 'PENDING' && <Link href="/dashboard/approvals" className="text-xs font-medium text-amber-900 dark:text-amber-200 underline">Open approvals</Link>}
      </p>
      {m && 'body' in m ? (
        <div className="px-4 py-3 space-y-1">
          {m.to !== undefined && <p className="text-xs text-neutral-500 break-words">To {text(m.to)}</p>}
          {m.subject !== undefined && <p className="font-medium text-neutral-900 dark:text-neutral-100 break-words">{text(m.subject)}</p>}
          <p className="whitespace-pre-wrap break-words text-neutral-800 dark:text-neutral-200 max-h-64 overflow-auto">{text(m.body)}</p>
        </div>
      ) : m ? (
        <dl className="px-4 py-3 grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-1">
          {Object.entries(m).slice(0, 8).map(([k, v]) => (
            <div key={k} className="contents"><dt className="text-neutral-500">{k}</dt><dd className="break-words text-neutral-800 dark:text-neutral-200">{text(v)}</dd></div>
          ))}
        </dl>
      ) : null}
    </div>
  )
}

/** One conversation as an exchange of messages; each answer opens to show how the agent got there. */
function ConversationView({ conversation, agentId, agentName, openRun, onToggleRun, focusRun, pending, onReply, replying }: {
  conversation: Conversation
  agentId: string
  agentName: string
  openRun: string | null
  onToggleRun: (runId: string) => void
  focusRun: string | null
  pending: string | null
  onReply: (message: string) => Promise<boolean>
  replying: boolean
}) {
  const [reply, setReply] = useState('')
  const firstName = agentName.split(' ')[0]
  const canReply = conversation.kind === 'text' && conversation.recorded
  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!reply.trim()) return
    if (await onReply(reply.trim())) setReply('')
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-200 dark:border-neutral-800 pb-3">
        {conversation.kind === 'voice' ? <Mic className="w-4 h-4 text-neutral-500" aria-hidden="true" /> : <MessageSquare className="w-4 h-4 text-neutral-500" aria-hidden="true" />}
        <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{conversation.kind === 'voice' ? 'Voice call' : 'Conversation'}</span>
        <span className="text-sm text-neutral-500">{formatDateTime(conversation.startedAt)}</span>
        <span className="text-sm text-neutral-500">{conversation.runs.length} {conversation.runs.length === 1 ? 'exchange' : 'exchanges'} · {money(conversation.costUsd)}</span>
      </div>

      <ol className="space-y-4">
        {conversation.runs.map((run) => {
          const s = STATUS[run.status ?? ''] ?? { label: run.status ?? 'Unknown', variant: 'default' as const }
          const open = openRun === run.runId
          return (
            <li key={run.runId} className="space-y-2">
              <div className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary-600 text-white px-4 py-2 text-sm whitespace-pre-wrap break-words">{run.message || run.input}</p>
              </div>
              <div className="flex flex-col items-start gap-1">
                {(run.output || !run.approval) && (
                  <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-neutral-100 dark:bg-neutral-800 px-4 py-2 text-sm text-neutral-900 dark:text-neutral-100 whitespace-pre-wrap break-words">
                    {answerText(run)}
                  </div>
                )}
                {run.approval && <ProposedAction approval={run.approval} />}
                <div className="flex flex-wrap items-center gap-2 pl-1">
                  {run.status !== 'completed' && <Badge variant={s.variant} size="sm">{s.label}</Badge>}
                  {run.dryRun && <Badge variant="outline" size="sm">Test run</Badge>}
                  <span className="text-xs text-neutral-500">{formatDateTime(run.at)}</span>
                  <button onClick={() => onToggleRun(run.runId)} aria-expanded={open} className="text-xs text-primary-700 dark:text-primary-300 hover:underline">
                    {open ? 'Hide details' : 'How it got there'}
                  </button>
                </div>
              </div>
              {open && (
                <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4">
                  <RunTrace run={run} agentId={agentId} focus={focusRun === run.runId || open} />
                </div>
              )}
            </li>
          )
        })}
        {pending && (
          <li className="space-y-2">
            <div className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary-600/80 text-white px-4 py-2 text-sm whitespace-pre-wrap break-words">{pending}</p>
            </div>
            <p className="flex items-center gap-2 text-sm text-neutral-500"><Loader2 className="w-4 h-4 animate-spin" />{firstName} is working on it…</p>
          </li>
        )}
      </ol>

      {canReply ? (
        <form onSubmit={send} className="flex items-end gap-2 border-t border-neutral-200 dark:border-neutral-800 pt-3">
          <label htmlFor="reply" className="sr-only">Reply to {firstName}</label>
          <textarea
            id="reply"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(e) } }}
            rows={2}
            placeholder={`Reply to ${firstName}…`}
            className="flex-1 min-w-0 px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          <Button type="submit" disabled={!reply.trim() || replying} aria-label="Send reply">
            {replying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </form>
      ) : (
        <p className="text-xs text-neutral-500 border-t border-neutral-200 dark:border-neutral-800 pt-3">
          {conversation.kind === 'voice' ? 'A voice call: continue by talking in the panel above.' : 'This conversation is from before replies were possible. Start a new one above.'}
        </p>
      )}
    </div>
  )
}

/** How often the conversation list checks for new conversations while the page is visible. */
const CONVERSATIONS_REFRESH_MS = 10_000

export default function AgentPage() {
  const { id } = useParams<{ id: string }>()
  const [agent, setAgent] = useState<AgentDetail | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [task, setTask] = useState('')
  /** The run in progress, which conversation it belongs to (null: a new one) and what was asked. */
  const [running, setRunning] = useState<{ jobId: string; state: string; conversationId: string; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  /** A conversation id, or "all", waiting for the person to confirm its removal from the list. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Removes conversations from this list only; the platform keeps the record (costs, audit trail).
  const removeConversation = async (target: string) => {
    setRemoveError(null)
    const conversation = conversations.find((c) => c.id === target)
    const query = target === 'all'
      ? 'all=1'
      : conversation?.recorded
        ? `conversation=${encodeURIComponent(target)}`
        : `runs=${encodeURIComponent((conversation?.runs ?? []).map((r) => r.runId).join(','))}`
    try {
      const res = await fetch(`/api/agents/${id}/runs?${query}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(res.status === 403 ? 'You don’t have permission to remove conversations.' : 'Could not remove that from the list.')
      const next = target === 'all' ? [] : conversations.filter((c) => c.id !== target)
      setConversations(next)
      // Don't leave a removed run in the address, or a refresh would show it again.
      const inUrl = new URLSearchParams(window.location.search).get('run')
      if (inUrl && (target === 'all' || conversation?.runs.some((r) => r.runId === inUrl))) window.history.replaceState(null, '', window.location.pathname)
      setSelected((current) => (current && next.some((c) => c.id === current) ? current : next[0]?.id ?? null))
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : 'Could not remove that from the list.')
    } finally {
      setConfirmRemove(null)
    }
  }

  /** Loads the conversation list; `select` picks a conversation by id, or the one holding a run id. */
  const lastList = useRef('')
  const loadConversations = useCallback(async (select?: { runId?: string; conversationId?: string }) => {
    const res = await fetch(`/api/agents/${id}/runs?view=conversations&limit=25`)
    if (!res.ok) return
    const body = await res.json()
    let rows: Conversation[] = body.data ?? []
    // A background refresh that found nothing new changes nothing on screen.
    const fingerprint = JSON.stringify(rows)
    if (!select && fingerprint === lastList.current) return
    lastList.current = fingerprint
    let runId = select?.runId
    // A run asked for by id (a link, or "See how it answered") may be older than the list.
    // One someone removed from the list stays out of it, even when the address still names it.
    if (runId && !rows.some((c) => c.runs.some((r) => r.runId === runId))) {
      const one = await fetch(`/api/agents/${id}/runs?run=${encodeURIComponent(runId)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      const run: Run | undefined = one?.data?.[0]
      if (run && !(run as { hidden?: boolean }).hidden) {
        rows = [{
          id: run.conversationId ?? `run-${run.runId}`,
          recorded: Boolean(run.conversationId),
          kind: run.trigger === 'voice' ? 'voice' : 'text',
          title: run.message || run.input || '',
          startedAt: run.at,
          lastAt: run.at,
          costUsd: run.costUsd ?? 0,
          runs: [run],
        }, ...rows]
      } else {
        runId = undefined
        window.history.replaceState(null, '', window.location.pathname)
      }
    }
    setConversations(rows)
    const holding = runId ? rows.find((c) => c.runs.some((r) => r.runId === runId)) : undefined
    const wanted = holding?.id ?? (select?.conversationId && rows.some((c) => c.id === select.conversationId) ? select.conversationId : undefined)
    setSelected((current) => wanted ?? (current && rows.some((c) => c.id === current) ? current : rows[0]?.id ?? null))
    if (runId) setOpenRun(runId)
  }, [id])

  // "See how it answered" in the voice panel: show that run's conversation with its details open, in view.
  const [focusRun, setFocusRun] = useState<string | null>(null)
  const traceRef = useRef<HTMLElement | null>(null)
  const showRun = useCallback(async (runId: string) => {
    await loadConversations({ runId })
    setFocusRun(runId)
    window.history.replaceState(null, '', `?run=${encodeURIComponent(runId)}`)
    requestAnimationFrame(() => traceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }, [loadConversations])

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('run')
    fetch(`/api/agents/${id}`).then(async (res) => {
      if (res.status === 404 || res.status === 403) { setNotFound(true); return }
      if (res.ok) setAgent(await res.json())
    })
    loadConversations(fromUrl ? { runId: fromUrl } : undefined)
    return () => { if (pollRef.current) clearTimeout(pollRef.current) }
  }, [id, loadConversations])

  // The list keeps itself current (calls, scheduled runs, other tabs) while the page is in view.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') void loadConversations() }
    const timer = setInterval(refresh, CONVERSATIONS_REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [loadConversations])

  const poll = useCallback((jobId: string, conversationId: string, message: string) => {
    pollRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/agents/${id}/run?jobId=${encodeURIComponent(jobId)}`)
        const body = await res.json()
        if (!res.ok) throw new Error(body.error ?? 'Could not check the run')
        if (body.state === 'completed' || body.state === 'failed') {
          if (body.state === 'failed') setError(body.failedReason ?? 'The run failed before it could finish.')
          await loadConversations({ conversationId })
          setRunning(null)
          return
        }
        setRunning({ jobId, state: body.state, conversationId, message })
        poll(jobId, conversationId, message)
      } catch (e) {
        setRunning(null)
        setError(e instanceof Error ? e.message : 'Could not check the run')
      }
    }, 1500)
  }, [id, loadConversations])

  /** Sends a message: a new conversation, or the next one in an existing conversation. */
  const sendMessage = async (message: string, conversationId?: string): Promise<boolean> => {
    setError(null)
    try {
      const res = await fetch(`/api/agents/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conversationId ? { input: message, conversationId } : { input: message }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setRunning({ jobId: body.jobId, state: 'waiting', conversationId: body.conversationId, message })
      poll(body.jobId, body.conversationId, message)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the run')
      return false
    }
  }

  const start = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!task.trim()) return
    if (await sendMessage(task)) setTask('')
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
  const selectedConversation = conversations.find((c) => c.id === selected) ?? null
  const newConversationRunning = running !== null && !conversations.some((c) => c.id === running.conversationId)
  const tools = Array.from(new Set(agent?.skills.flatMap((s) => s.skill.requiredTools) ?? []))
  const firstName = agent?.name.split(' ')[0] ?? 'the agent'
  // Platform abilities that aren't integration tools, so a manager doesn't read as "No tools".
  const teamAbilities = [
    contract?.management?.enabled && 'Reviews and improves the team',
    (contract?.handoffs?.enabled || contract?.delegation?.enabled) && 'Passes work to teammates',
    contract?.memory?.mode === 'tenant' && 'Shared team notes',
  ].filter((a): a is string => Boolean(a))

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
            <Badge variant={agentStatus(agent.status).variant}>{agentStatus(agent.status).label}</Badge>
            <Badge variant="info">{(contract?.autonomyStage ?? 'approval_gated').replace(/_/g, ' ')}</Badge>
            <Badge variant="outline">v{agent.version}</Badge>
          </div>
        )}
      </header>

      {/* Voice agents: the conversation sits at the top, so replies never need scrolling to. */}
      {agent?.config?.voice?.enabled && <VoicePanel agentId={id} agentName={agent.name} onShowRun={showRun} onTurnDone={() => void loadConversations()} />}
      {agent?.config?.voice?.enabled && <VoiceClone agentId={id} agentName={agent.name} />}

      {agent && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-4">
            <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500 mb-2">Can work with</h2>
            <div className="flex flex-wrap gap-1.5">
              {tools.map((t) => <Badge key={t} variant="outline" size="sm">{toolLabel(t)}</Badge>)}
              {teamAbilities.map((a) => <Badge key={a} variant="info" size="sm">{a}</Badge>)}
              {!tools.length && !teamAbilities.length && <span className="text-sm text-neutral-500">No tools</span>}
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
        <label htmlFor="task" className="block text-sm font-medium text-neutral-900 dark:text-neutral-100">Give {firstName} a task</label>
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
            {newConversationRunning ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
            {newConversationRunning ? 'Working…' : 'Start'}
          </Button>
          {running && <span className="text-sm text-neutral-500">{running.state === 'active' ? 'The agent is working on it.' : 'Queued. Is the worker process running?'}</span>}
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
        <p className="text-xs text-neutral-500">Starts a new conversation; reply to it below to follow up. Anything that contacts people or changes records waits for your approval first.</p>
      </form>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
            <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">Conversations</h2>
            {conversations.length > 0 && (confirmRemove === 'all' ? (
              <span className="flex items-center gap-2 text-xs">
                <span className="text-neutral-600 dark:text-neutral-300">Remove all from this list?</span>
                <button onClick={() => removeConversation('all')} className="font-medium text-red-600 dark:text-red-400 hover:underline">Remove</button>
                <button onClick={() => setConfirmRemove(null)} className="text-neutral-500 hover:underline">Cancel</button>
              </span>
            ) : (
              <button onClick={() => setConfirmRemove('all')} className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 hover:underline">Clear all</button>
            ))}
          </div>
          {removeError && <p className="px-4 pt-3 text-xs text-red-600 dark:text-red-400" role="alert">{removeError}</p>}
          {newConversationRunning && (
            <p className="px-4 py-3 text-sm text-neutral-500 flex items-center gap-2 border-b border-neutral-100 dark:border-neutral-800"><Loader2 className="w-4 h-4 animate-spin shrink-0" /><span className="line-clamp-2">{running?.message}</span></p>
          )}
          {conversations.length === 0 && !newConversationRunning ? (
            <p className="px-4 py-6 text-sm text-neutral-500 flex items-center gap-2"><CircleDashed className="w-4 h-4" />No conversations yet. Give it a task above.</p>
          ) : (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 max-h-[32rem] overflow-auto">
              {conversations.map((c) => {
                const last = c.runs[c.runs.length - 1]
                const s = STATUS[last?.status ?? ''] ?? { label: last?.status ?? '?', variant: 'default' as const }
                return (
                  <li key={c.id} className={`relative ${selected === c.id ? 'bg-primary-50 dark:bg-primary-900/20' : ''}`}>
                    <button
                      onClick={() => { setSelected(c.id); setOpenRun(null) }}
                      aria-current={selected === c.id}
                      className="w-full text-left pl-4 pr-10 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 min-w-0">
                          {c.kind === 'voice' ? <Mic className="w-3.5 h-3.5 text-neutral-500 shrink-0" aria-label="Voice call" /> : <MessageSquare className="w-3.5 h-3.5 text-neutral-500 shrink-0" aria-label="Typed" />}
                          <Badge variant={s.variant} size="sm">{s.label}</Badge>
                        </span>
                        <span className="text-xs text-neutral-500 tabular-nums">{money(c.costUsd)}</span>
                      </div>
                      <p className="text-sm text-neutral-800 dark:text-neutral-200 mt-1 line-clamp-2">{c.title}</p>
                      <p className="text-xs text-neutral-500 mt-0.5">{formatDateTime(c.lastAt)} · {c.runs.length} {c.runs.length === 1 ? 'exchange' : 'exchanges'}</p>
                    </button>
                    {confirmRemove === c.id ? (
                      <div className="flex flex-wrap items-center gap-3 px-4 pb-3 text-xs">
                        <span className="text-neutral-600 dark:text-neutral-300">Remove this conversation from the list?</span>
                        <button onClick={() => removeConversation(c.id)} className="font-medium text-red-600 dark:text-red-400 hover:underline">Remove</button>
                        <button onClick={() => setConfirmRemove(null)} className="text-neutral-500 hover:underline">Cancel</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmRemove(c.id)}
                        aria-label="Remove this conversation from the list"
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
          {selectedConversation ? (
            <ConversationView
              key={selectedConversation.id}
              conversation={selectedConversation}
              agentId={id}
              agentName={agent?.name ?? 'Agent'}
              openRun={openRun}
              onToggleRun={(runId) => setOpenRun((current) => (current === runId ? null : runId))}
              focusRun={focusRun}
              pending={running?.conversationId === selectedConversation.id ? running.message : null}
              onReply={(message) => sendMessage(message, selectedConversation.id)}
              replying={running !== null}
            />
          ) : (
            <p className="text-sm text-neutral-500">Select a conversation to read it and see how the agent answered.</p>
          )}
        </section>
      </div>
    </div>
  )
}
