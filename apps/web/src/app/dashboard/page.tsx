'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { AlertTriangle, ArrowRight, CheckCircle2, CircleDashed, Clock, Lightbulb, Loader2, Phone, Sparkles, UserRound, Workflow, XCircle } from 'lucide-react'
import { formatDateTime } from '@ai-workforce/ui'

interface Impact {
  days: number
  tasks: { total: number; finished: number; toPerson: number; failed: number }
  minutesSaved: number
  medianSeconds: number | null
  callAnswerSeconds: number | null
  costUsd: number
  costPerTaskUsd: number | null
  calls: number
  cases: { total: number; done: number }
  waiting: { approvals: number; handovers: number; memories: number }
  learned: { total: number; byAgents: number; byStaff: number; lessons: number }
  improvements: { promoted: number; rolledBack: number; latest: Array<{ at: string; agentName: string; summary: string }> }
  daily: Array<{ day: string; finished: number; minutesSaved: number }>
  agents: Array<{ id: string; name: string; role: string; tasks: number; finished: number; minutesSaved: number; costUsd: number; minutesPerTask: number }>
  activity: Array<{ at: string; agentId: string; agentName: string; kind: 'voice' | 'case' | 'schedule' | 'task'; summary: string; status: string; caseId?: string }>
}

const RANGES = [{ days: 1, label: 'Today' }, { days: 7, label: '7 days' }, { days: 30, label: '30 days' }]

const STATUS: Record<string, { label: string; icon: typeof CheckCircle2; className: string }> = {
  completed: { label: 'Done', icon: CheckCircle2, className: 'text-green-600 dark:text-green-400' },
  partial: { label: 'Partly done', icon: CheckCircle2, className: 'text-green-600 dark:text-green-400' },
  approval_required: { label: 'Ready for your approval', icon: Clock, className: 'text-amber-600 dark:text-amber-400' },
  needs_clarification: { label: 'Asked a question', icon: CircleDashed, className: 'text-amber-600 dark:text-amber-400' },
  escalated: { label: 'Handed to a person', icon: UserRound, className: 'text-amber-600 dark:text-amber-400' },
  failed: { label: 'Stopped', icon: XCircle, className: 'text-red-600 dark:text-red-400' },
  blocked: { label: 'Blocked', icon: XCircle, className: 'text-red-600 dark:text-red-400' },
}

const first = (name: string) => name.split(/\s+[-–]\s+/)[0]

function hours(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = minutes / 60
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`
}

function money(usd: number | null): string {
  if (usd === null) return 'n/a'
  if (usd === 0) return '$0'
  return usd < 0.01 ? `${(usd * 100).toFixed(2)}¢` : `$${usd.toFixed(2)}`
}

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-5">
      <p className="text-sm text-neutral-500 dark:text-neutral-400">{label}</p>
      <p className="text-3xl font-bold text-neutral-900 dark:text-neutral-50 mt-1 tabular-nums">{value}</p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">{detail}</p>
    </div>
  )
}

/** Tasks finished per day: one series, bars from a zero baseline, hover for the day's numbers. */
function DailyChart({ daily }: { daily: Impact['daily'] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...daily.map((d) => d.finished))
  const width = 640
  const height = 220
  const pad = { top: 12, bottom: 22, left: 28, right: 4 }
  const slot = (width - pad.left - pad.right) / daily.length
  const bar = Math.max(3, Math.min(28, slot - 2))
  const y = (v: number) => pad.top + (height - pad.top - pad.bottom) * (1 - v / max)
  const label = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
  const tickEvery = Math.ceil(daily.length / 7)
  const h = hover === null ? null : daily[hover]
  return (
    <figure className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img" aria-label="Tasks finished per day" onMouseLeave={() => setHover(null)}>
        {[0, Math.round(max / 2), max].filter((v, i, all) => all.indexOf(v) === i).map((v) => (
          <g key={v}>
            <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} className="stroke-neutral-200 dark:stroke-neutral-800" strokeWidth={1} />
            <text x={pad.left - 6} y={y(v) + 3} textAnchor="end" className="fill-neutral-500 text-[10px] tabular-nums">{v}</text>
          </g>
        ))}
        {daily.map((d, i) => {
          const x = pad.left + i * slot + (slot - bar) / 2
          const top = y(d.finished)
          const base = y(0)
          const r = Math.min(4, bar / 2, base - top)
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${label(d.day)}: ${d.finished} tasks finished`}>
              <rect x={pad.left + i * slot} y={pad.top} width={slot} height={base - pad.top} fill="transparent" />
              {d.finished > 0 && (
                <path d={`M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bar - r} Q${x + bar},${top} ${x + bar},${top + r} V${base} Z`} fill="#0284c7" opacity={hover === null || hover === i ? 1 : 0.55} />
              )}
              {i % tickEvery === 0 && <text x={x + bar / 2} y={height - 6} textAnchor="middle" className="fill-neutral-500 text-[10px]">{label(d.day)}</text>}
            </g>
          )
        })}
      </svg>
      {h && hover !== null && (
        <div className="pointer-events-none absolute top-0 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-xs shadow-sm" style={{ left: `min(calc(${((pad.left + hover * slot + slot / 2) / width) * 100}% - 4rem), calc(100% - 8rem))` }}>
          <p className="font-medium text-neutral-900 dark:text-neutral-100">{label(h.day)}</p>
          <p className="text-neutral-600 dark:text-neutral-300 tabular-nums whitespace-nowrap">{h.finished} finished · {hours(h.minutesSaved)} saved</p>
        </div>
      )}
      <table className="sr-only">
        <caption>Tasks finished and time saved per day</caption>
        <thead><tr><th>Day</th><th>Finished</th><th>Minutes saved</th></tr></thead>
        <tbody>{daily.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.finished}</td><td>{d.minutesSaved}</td></tr>)}</tbody>
      </table>
    </figure>
  )
}

/**
 * Dashboard home: what the AI team did and what it was worth (GET /api/impact; docs/IMPACT.md).
 * Time saved is each agent's manual-effort estimate per finished task, said next to the number.
 */
export default function DashboardPage() {
  const { data: session } = useSession()
  const [days, setDays] = useState(7)
  const [data, setData] = useState<Impact | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/impact?days=${days}`)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setData(body)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load')
    }
  }, [days])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 30_000)
    return () => clearInterval(t)
  }, [load])

  const waiting = data ? data.waiting.approvals + data.waiting.handovers + data.waiting.memories : 0
  const period = days === 1 ? 'today' : `in the last ${days} days`

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-neutral-900 dark:text-neutral-50">Welcome back, {session?.user?.name?.split(' ')[0] || 'there'}</h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1">What your AI team did {period}.</p>
        </div>
        <div className="inline-flex rounded-lg border border-neutral-200 dark:border-neutral-800 p-0.5 bg-white dark:bg-neutral-900" role="group" aria-label="Period">
          {RANGES.map((r) => (
            <button key={r.days} onClick={() => setDays(r.days)} aria-pressed={days === r.days} className={`px-3 py-1.5 text-sm rounded-md ${days === r.days ? 'bg-primary-600 text-white' : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'}`}>{r.label}</button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {!data ? (
        <div className="p-8 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-neutral-400" /></div>
      ) : (
        <>
          {waiting > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
              <AlertTriangle className="w-4 h-4" aria-hidden="true" />
              <span className="font-medium">Waiting for you:</span>
              {data.waiting.approvals > 0 && <Link href="/dashboard/approvals" className="underline">{data.waiting.approvals} to approve</Link>}
              {data.waiting.handovers > 0 && <Link href="/dashboard/approvals#handovers" className="underline">{data.waiting.handovers} handed to a person</Link>}
              {data.waiting.memories > 0 && <Link href="/dashboard/memory" className="underline">{data.waiting.memories} thing{data.waiting.memories === 1 ? '' : 's'} learned to confirm</Link>}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Tasks finished" value={String(data.tasks.finished)} detail={`${data.tasks.total} taken on${data.calls ? `, including ${data.calls} call${data.calls === 1 ? '' : 's'}` : ''}${data.tasks.toPerson ? `; ${data.tasks.toPerson} handed to a person` : ''}`} />
            <Tile label="Time saved (estimate)" value={hours(data.minutesSaved)} detail="Each agent's minutes per task, the time a person would take" />
            <Tile label="Typical time to finish" value={data.medianSeconds === null ? 'n/a' : data.medianSeconds < 90 ? `${Math.round(data.medianSeconds)} s` : `${Math.round(data.medianSeconds / 60)} min`} detail={`Median, from the request to the answer${data.callAnswerSeconds !== null ? `; on calls, answers in ${data.callAnswerSeconds.toFixed(1)} s` : ''}`} />
            <Tile label="Cost per task" value={money(data.costPerTaskUsd)} detail={`${money(data.costUsd)} in model costs ${period}`} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <section className="min-w-0 lg:col-span-2 bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-5" aria-labelledby="daily-heading">
              <h2 id="daily-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Tasks finished per day</h2>
              {data.tasks.total ? <DailyChart daily={data.daily} /> : <p className="mt-6 mb-4 text-sm text-neutral-500">No work yet {period}. Give the team something on <Link href="/dashboard/cases" className="underline">Team cases</Link>.</p>}
            </section>

            <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-5 space-y-4" aria-labelledby="growing-heading">
              <h2 id="growing-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Getting better</h2>
              <div className="flex items-start gap-3">
                <Lightbulb className="w-5 h-5 text-primary-600 mt-0.5" aria-hidden="true" />
                <p className="text-sm text-neutral-700 dark:text-neutral-300"><Link href="/dashboard/memory" className="font-semibold tabular-nums hover:underline">{data.learned.total} thing{data.learned.total === 1 ? '' : 's'} learned</Link> about the business{data.learned.total ? ` (${data.learned.byAgents} by agents while working, ${data.learned.byStaff} from staff${data.learned.lessons ? `, ${data.learned.lessons} lessons from rejected work` : ''})` : ''}.</p>
              </div>
              <div className="flex items-start gap-3">
                <Sparkles className="w-5 h-5 text-primary-600 mt-0.5" aria-hidden="true" />
                <div className="text-sm text-neutral-700 dark:text-neutral-300">
                  <p><Link href="/dashboard/improvements" className="font-semibold tabular-nums hover:underline">{data.improvements.promoted} tested improvement{data.improvements.promoted === 1 ? '' : 's'}</Link> went live{data.improvements.rolledBack ? `, ${data.improvements.rolledBack} rolled back` : ''}.</p>
                  {data.improvements.latest.slice(0, 2).map((l) => <p key={l.at} className="mt-1 text-xs text-neutral-500">{first(l.agentName)}: {l.summary}</p>)}
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Workflow className="w-5 h-5 text-primary-600 mt-0.5" aria-hidden="true" />
                <p className="text-sm text-neutral-700 dark:text-neutral-300"><Link href="/dashboard/cases" className="font-semibold tabular-nums hover:underline">{data.cases.total} team case{data.cases.total === 1 ? '' : 's'}</Link>{data.cases.total ? `, ${data.cases.done} done` : ''}: work passed between agents.</p>
              </div>
            </section>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <section className="min-w-0 lg:col-span-3 bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800" aria-labelledby="activity-heading">
              <div className="px-5 pt-5 pb-2 flex items-center justify-between">
                <h2 id="activity-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Latest work</h2>
                <Link href="/dashboard/cases" className="text-xs text-primary-600 inline-flex items-center gap-1">Team cases <ArrowRight className="w-3 h-3" /></Link>
              </div>
              {data.activity.length === 0 ? <p className="px-5 pb-5 text-sm text-neutral-500">Nothing yet.</p> : (
                <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {data.activity.map((a, i) => {
                    const s = STATUS[a.status] ?? STATUS.failed
                    const Icon = s.icon
                    return (
                      <li key={i} className="px-5 py-3 flex gap-3">
                        {a.kind === 'voice' ? <Phone className="w-4 h-4 mt-0.5 text-neutral-400" aria-label="Call" /> : <Icon className={`w-4 h-4 mt-0.5 ${s.className}`} aria-hidden="true" />}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-neutral-900 dark:text-neutral-100 truncate">
                            <Link href={a.kind === 'case' && a.caseId ? `/dashboard/cases#${a.caseId}` : `/dashboard/agents/${a.agentId}`} className="font-medium hover:underline">{first(a.agentName)}</Link>
                            <span className="text-neutral-600 dark:text-neutral-400"> · {a.kind === 'voice' ? 'call: ' : ''}{a.summary || '(no message)'}</span>
                          </p>
                          <p className="text-xs text-neutral-500"><span className={s.className}>{a.kind === 'voice' && a.status === 'completed' ? 'Answered' : s.label}</span> · {formatDateTime(a.at)}</p>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            <section className="lg:col-span-2 bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-5" aria-labelledby="agents-heading">
              <h2 id="agents-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 mb-3">By agent</h2>
              {data.agents.length === 0 ? <p className="text-sm text-neutral-500">No work yet {period}.</p> : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-neutral-500"><th className="font-normal pb-2">Agent</th><th className="font-normal pb-2 text-right">Finished</th><th className="font-normal pb-2 text-right">Saved</th><th className="font-normal pb-2 text-right">Cost</th></tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                    {data.agents.map((a) => (
                      <tr key={a.id}>
                        <td className="py-2"><Link href={`/dashboard/agents/${a.id}`} className="font-medium text-neutral-900 dark:text-neutral-100 hover:underline">{first(a.name)}</Link><span className="block text-xs text-neutral-500">{a.minutesPerTask} min per task</span></td>
                        <td className="py-2 text-right tabular-nums">{a.finished}</td>
                        <td className="py-2 text-right tabular-nums">{hours(a.minutesSaved)}</td>
                        <td className="py-2 text-right tabular-nums">{money(a.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}
