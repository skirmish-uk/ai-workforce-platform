'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, CircleDashed, Clock, HelpCircle, Inbox, Loader2, Play, UserRound, XCircle } from 'lucide-react'
import { Button, formatDateTime } from '@ai-workforce/ui'
import { AgentText } from '../../../components/AgentText'

interface AgentRef { id: string; name: string; role: string }

interface Task {
  id: string
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'WAITING_APPROVAL' | 'NEEDS_INFO' | 'ESCALATED' | 'FAILED' | 'CANCELLED'
  agent: AgentRef | null
  from: AgentRef | null
  parentTaskId: string | null
  brief: string
  reason: string | null
  result: string | null
  runId: string | null
  approvalId: string | null
  depth: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

interface TeamCase {
  id: string
  title: string
  status: 'OPEN' | 'WAITING' | 'DONE' | 'FAILED'
  source: string
  subject: string | null
  createdAt: string
  updatedAt: string
  tasks: Task[]
}

const TASK = {
  QUEUED: { label: 'Picked up next', icon: CircleDashed, className: 'text-neutral-500' },
  RUNNING: { label: 'Working on it', icon: Loader2, className: 'text-primary-600 dark:text-primary-400' },
  DONE: { label: 'Done', icon: CheckCircle2, className: 'text-green-600 dark:text-green-400' },
  WAITING_APPROVAL: { label: 'Waiting for your approval', icon: Clock, className: 'text-amber-600 dark:text-amber-400' },
  NEEDS_INFO: { label: 'Needs information', icon: HelpCircle, className: 'text-amber-600 dark:text-amber-400' },
  ESCALATED: { label: 'Handed to a person', icon: UserRound, className: 'text-amber-600 dark:text-amber-400' },
  FAILED: { label: 'Stopped', icon: XCircle, className: 'text-red-600 dark:text-red-400' },
  CANCELLED: { label: 'Cancelled', icon: XCircle, className: 'text-neutral-400' },
} as const

const CASE = {
  OPEN: { label: 'In progress', className: 'bg-primary-50 text-primary-800 dark:bg-primary-900/30 dark:text-primary-300' },
  WAITING: { label: 'Waiting for you', className: 'bg-amber-50 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200' },
  DONE: { label: 'Done', className: 'bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300' },
  FAILED: { label: 'Needs a look', className: 'bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300' },
} as const

/** Ready-made work for the demo team (sandbox connections: nothing real is sent). */
const PRESETS = [
  {
    label: 'Sort this morning’s inbox',
    agentId: 'demo-triage-1',
    title: 'Morning inbox',
    brief: 'Go through the unread emails in the shared inbox. Sort each one, flag anything urgent, and hand each piece of work to the teammate who handles it (new enquiries and leads to Sarah, meeting requests to Riley, contact details to update to Casey). Then give me the summary.',
  },
  {
    label: 'New enquiry from the website',
    agentId: 'demo-agent-1',
    title: 'Website enquiry: Stackwise',
    brief: 'New lead from the website form. Daniel Okafor (daniel.okafor@stackwise.example, 0413 555 274), Head of Marketing at Stackwise, a B2B SaaS company in Sydney with about 180 staff. Message: "We are launching in the UK next quarter and want help with account-based marketing and LinkedIn ads. Could we do a call next Tuesday or Wednesday morning?" Follow up with him, get the call booked, and make sure he is in the CRM.',
  },
]

const first = (name?: string | null) => (name ?? 'Someone').split(/\s+[-–]\s+/)[0]
const field = 'w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500'

function seconds(from: string | null, to: string | null): string | null {
  if (!from || !to) return null
  const s = (new Date(to).getTime() - new Date(from).getTime()) / 1000
  return s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`
}

/** Who worked on the case, in order, as a strip of names with arrows (the hand-offs). */
function Flow({ tasks }: { tasks: Task[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Who worked on it">
      {tasks.map((t, i) => {
        const s = TASK[t.status]
        const Icon = s.icon
        return (
          <Fragment key={t.id}>
            {i > 0 && <ArrowRight className="w-3.5 h-3.5 text-neutral-400" aria-hidden="true" />}
            <li className="inline-flex items-center gap-1 rounded-full border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-0.5">
              <Icon className={`w-3.5 h-3.5 ${s.className} ${t.status === 'RUNNING' ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span className="font-medium text-neutral-800 dark:text-neutral-200">{first(t.agent?.name)}</span>
              <span className="sr-only">: {s.label}</span>
            </li>
          </Fragment>
        )
      })}
    </ol>
  )
}

/**
 * Team cases (docs/TEAMWORK.md): one piece of work moving through the agents. Each agent does
 * its part and hands the rest to whoever handles it; this page shows who did what, live.
 */
export default function CasesPage() {
  const [cases, setCases] = useState<TeamCase[] | null>(null)
  const [agents, setAgents] = useState<AgentRef[]>([])
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [starting, setStarting] = useState(false)
  const [draft, setDraft] = useState({ agentId: '', brief: '' })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Answers being typed to tasks that stopped to ask something, by task id. */
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [answering, setAnswering] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/cases')
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setCases(body.cases)
      setAgents(body.agents)
      return body.cases as TeamCase[]
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load cases')
      return null
    }
  }, [])

  // Fast while anything is moving, slow otherwise.
  useEffect(() => {
    let stopped = false
    const tick = async () => {
      const list = document.visibilityState === 'visible' ? await load() : cases
      if (stopped) return
      const busy = (list ?? []).some((c) => c.status === 'OPEN')
      timer.current = setTimeout(tick, busy ? 2000 : 12000)
    }
    void tick()
    return () => { stopped = true; if (timer.current) clearTimeout(timer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  // Open the case named in the URL (links from the memory page), else the newest.
  useEffect(() => {
    if (!cases?.length || open.size) return
    const wanted = window.location.hash.slice(1)
    setOpen(new Set([cases.some((c) => c.id === wanted) ? wanted : cases[0].id]))
  }, [cases, open.size])

  const start = async (body: { agentId: string; brief: string; title?: string }) => {
    setStarting(true)
    setError(null)
    try {
      const res = await fetch('/api/cases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const out = await res.json()
      if (!res.ok) throw new Error(out.error ?? `Request failed (${res.status})`)
      setDraft({ agentId: body.agentId, brief: '' })
      setOpen(new Set([out.caseId]))
      await load()
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(function again() { void load().then((list) => { if ((list ?? []).some((c) => c.status === 'OPEN')) timer.current = setTimeout(again, 2000) }) }, 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start it')
    } finally {
      setStarting(false)
    }
  }

  const answer = async (taskId: string) => {
    setAnswering(taskId)
    setError(null)
    try {
      const res = await fetch('/api/cases', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId, answer: answers[taskId] }) })
      const out = await res.json()
      if (!res.ok) throw new Error(out.error ?? `Request failed (${res.status})`)
      setAnswers((a) => ({ ...a, [taskId]: '' }))
      await load()
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(function again() { void load().then((list) => { if ((list ?? []).some((c) => c.status === 'OPEN')) timer.current = setTimeout(again, 2000) }) }, 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the answer')
    } finally {
      setAnswering(null)
    }
  }

  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const presets = PRESETS.filter((p) => agents.some((a) => a.id === p.agentId))

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">Team cases</h1>
        <p className="text-neutral-600 dark:text-neutral-400 mt-1 max-w-2xl">
          Give one agent a job and watch it move through the team: each does its own part and hands the rest to whoever handles it. Anything that contacts a customer or changes a record still waits for your approval.
        </p>
      </div>

      <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-5 space-y-4" aria-labelledby="start-heading">
        <h2 id="start-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Give the team some work</h2>
        {presets.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <Button key={p.label} variant="outline" size="sm" disabled={starting} onClick={() => start({ agentId: p.agentId, brief: p.brief, title: p.title })}>
                <Play className="w-3.5 h-3.5 mr-1.5" />{p.label} <span className="ml-1 text-neutral-500">({first(agents.find((a) => a.id === p.agentId)?.name)})</span>
              </Button>
            ))}
          </div>
        )}
        <form onSubmit={(e) => { e.preventDefault(); if (draft.agentId && draft.brief.trim()) void start(draft) }} className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-[14rem_1fr]">
            <div>
              <label htmlFor="case-agent" className="block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1">Start with</label>
              <select id="case-agent" value={draft.agentId} onChange={(e) => setDraft({ ...draft, agentId: e.target.value })} className={field}>
                <option value="">Choose an agent</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="case-brief" className="block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1">What needs doing</label>
              <textarea id="case-brief" value={draft.brief} onChange={(e) => setDraft({ ...draft, brief: e.target.value })} rows={2} maxLength={4000} placeholder="e.g. Ana from Silva Design wants to move her monthly report call to next Thursday." className={field} />
            </div>
          </div>
          <Button type="submit" disabled={starting || !draft.agentId || draft.brief.trim().length < 3}>{starting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}Start</Button>
        </form>
        <p className="text-xs text-neutral-500">Needs the worker process running. The demo connections are sandboxes: emails, bookings and CRM changes are prepared for approval, never really sent.</p>
      </section>

      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}

      {!cases ? (
        <div className="p-8 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-neutral-400" /></div>
      ) : cases.length === 0 ? (
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 p-8 text-center space-y-2">
          <Inbox className="w-6 h-6 mx-auto text-neutral-400" aria-hidden="true" />
          <p className="text-sm text-neutral-600 dark:text-neutral-400">No cases yet. Start one above, or they appear here when an agent hands work to a teammate.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {cases.map((c) => {
            const isOpen = open.has(c.id)
            const waitingApproval = c.tasks.some((t) => t.status === 'WAITING_APPROVAL')
            return (
              <li key={c.id} id={c.id} className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800">
                <button onClick={() => toggle(c.id)} aria-expanded={isOpen} className="w-full text-left p-4 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-2">
                    <p className="font-semibold text-neutral-900 dark:text-neutral-50">{c.title}</p>
                    <Flow tasks={c.tasks} />
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`rounded-full px-2.5 py-1 font-medium ${CASE[c.status].className}`}>{CASE[c.status].label}</span>
                    <span className="text-neutral-500 tabular-nums">{formatDateTime(c.updatedAt)}</span>
                    <ChevronDown className={`w-4 h-4 text-neutral-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </div>
                </button>
                {isOpen && (
                  <div className="border-t border-neutral-100 dark:border-neutral-800 px-4 pb-4">
                    {waitingApproval && (
                      <p className="mt-3 flex items-center gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
                        <AlertTriangle className="w-4 h-4" aria-hidden="true" />Part of this is ready and waiting for you. <Link href="/dashboard/approvals" className="font-medium underline">Review it</Link>
                      </p>
                    )}
                    <ol className="mt-3 space-y-4">
                      {c.tasks.map((t) => {
                        const s = TASK[t.status]
                        const Icon = s.icon
                        const took = seconds(t.startedAt, t.finishedAt)
                        return (
                          <li key={t.id} className="relative pl-6">
                            <Icon className={`absolute left-0 top-0.5 w-4 h-4 ${s.className} ${t.status === 'RUNNING' ? 'animate-spin' : ''}`} aria-hidden="true" />
                            <div className="flex flex-wrap items-baseline gap-x-2">
                              {t.agent ? <Link href={`/dashboard/agents/${t.agent.id}`} className="font-medium text-neutral-900 dark:text-neutral-100 hover:text-primary-600">{t.agent.name}</Link> : <span className="font-medium">An agent</span>}
                              <span className={`text-xs ${s.className}`}>{s.label}{took ? ` · ${took}` : ''}</span>
                            </div>
                            <p className="text-xs text-neutral-500 mt-0.5">
                              {t.from ? <>Handed over by {first(t.from.name)}{t.reason ? `: ${t.reason}` : ''}</> : t.reason ?? 'Started by a person'}
                            </p>
                            <details className="mt-1 text-sm">
                              <summary className="cursor-pointer text-xs text-neutral-500">The brief</summary>
                              <p className="mt-1 whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">{t.brief}</p>
                            </details>
                            {t.result && <AgentText text={t.result} className="mt-1.5 text-sm text-neutral-800 dark:text-neutral-200 rounded-lg bg-neutral-50 dark:bg-neutral-800/50 px-3 py-2" />}
                            {t.status === 'WAITING_APPROVAL' && <Link href="/dashboard/approvals" className="mt-1 inline-block text-xs font-medium text-primary-600 underline">Approve or reject it</Link>}
                            {t.status === 'NEEDS_INFO' && (
                              <form onSubmit={(e) => { e.preventDefault(); if (answers[t.id]?.trim()) void answer(t.id) }} className="mt-2 flex flex-wrap gap-2">
                                <label htmlFor={`answer-${t.id}`} className="sr-only">Answer {first(t.agent?.name)}</label>
                                <input id={`answer-${t.id}`} value={answers[t.id] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [t.id]: e.target.value }))} placeholder={`Answer ${first(t.agent?.name)} and they’ll carry on`} maxLength={2000} className={`${field} flex-1 min-w-[14rem]`} />
                                <Button type="submit" size="sm" disabled={answering !== null || !answers[t.id]?.trim()}>{answering === t.id && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}Send</Button>
                              </form>
                            )}
                          </li>
                        )
                      })}
                    </ol>
                    <p className="mt-4 text-xs text-neutral-500">
                      Started {formatDateTime(c.createdAt)}{c.subject ? ` · about ${c.subject}` : ''} · {c.tasks.length} part{c.tasks.length === 1 ? '' : 's'}
                    </p>
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
