'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Archive, Check, Lightbulb, Loader2, Pencil, Plus, RotateCcw, Search, ShieldCheck, Trash2 } from 'lucide-react'
import { Button, formatDateTime } from '@ai-workforce/ui'

interface MemoryRow {
  id: string
  content: string
  category: string
  subject: string | null
  status: 'ACTIVE' | 'PENDING' | 'ARCHIVED'
  trust: 'staff' | 'agent' | 'external'
  forAgent: { id: string; name: string } | null
  learnedBy: string | null
  addedBy: string | null
  reviewedBy: string | null
  source: { kind?: string; basis?: string; caseId?: string; approvalId?: string }
  useCount: number
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

interface MemoryResponse {
  counts: Partial<Record<MemoryRow['status'], number>>
  agents: Array<{ id: string; name: string }>
  memories: MemoryRow[]
}

const CATEGORIES: Record<string, { label: string; hint: string }> = {
  business: { label: 'About the business', hint: 'Facts: hours, prices, services, policies' },
  process: { label: 'How we do things', hint: 'Steps, rules of thumb, who does what' },
  customer: { label: 'Customers', hint: 'Who someone is, their account, history' },
  preference: { label: 'Preferences', hint: 'How a customer likes to be dealt with' },
  correction: { label: 'Corrections and lessons', hint: 'Where an agent got it wrong before' },
}

const BASIS: Record<string, string> = {
  staff_said: 'said by staff',
  customer_said: 'said by a customer',
  from_records: 'read in the records',
  observed: 'noticed while working',
}

function origin(m: MemoryRow): string {
  if (m.source.kind === 'approval_rejected') return `From a rejected approval${m.addedBy ? ` (${m.addedBy})` : ''}`
  if (m.source.kind === 'staff') return `Added by ${m.addedBy ?? 'staff'}`
  const how = m.source.kind === 'call' ? 'on a call' : m.source.kind === 'case' ? 'during a team case' : 'in a conversation'
  return `${m.learnedBy ?? 'An agent'} learned this ${how}${m.source.basis ? `, ${BASIS[m.source.basis] ?? m.source.basis}` : ''}`
}

const field = 'w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500'

/**
 * What the team knows (docs/MEMORY.md): everything the agents have learned about the business,
 * and what staff have told them. Waiting items were picked up from customers or emails and are
 * only used once a person confirms them.
 */
export default function MemoryPage() {
  const [data, setData] = useState<MemoryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ content: '', category: 'business', subject: '', agentId: '' })

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (q.trim()) params.set('q', q.trim())
    if (category) params.set('category', category)
    if (showArchived) params.set('status', 'ARCHIVED')
    try {
      const res = await fetch(`/api/memory?${params}`)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setData(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load memories')
    }
  }, [q, category, showArchived])

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0)
    return () => clearTimeout(t)
  }, [load, q])
  // Agents keep learning while the page is open.
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible' && !editing && !adding) void load() }, 15_000)
    return () => clearInterval(t)
  }, [load, editing, adding])

  const change = async (id: string, body: Record<string, unknown>, method = 'PATCH') => {
    setBusy(id)
    setError(null)
    try {
      const res = await fetch(`/api/memory/${id}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'PATCH' ? JSON.stringify(body) : undefined })
      const out = await res.json()
      if (!res.ok) throw new Error(out.error ?? `Request failed (${res.status})`)
      setEditing(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(null)
    }
  }

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy('new')
    setError(null)
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: draft.content, category: draft.category, subject: draft.subject || null, agentId: draft.agentId || null }),
      })
      const out = await res.json()
      if (!res.ok) throw new Error(out.error ?? `Request failed (${res.status})`)
      setDraft({ content: '', category: draft.category, subject: '', agentId: '' })
      setAdding(false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add it')
    } finally {
      setBusy(null)
    }
  }

  if (!data) {
    return error ? <p className="text-red-600" role="alert">{error}</p> : <div className="p-8 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-neutral-400" /></div>
  }

  const waiting = data.memories.filter((m) => m.status === 'PENDING')
  const known = data.memories.filter((m) => m.status !== 'PENDING')
  const groups = Object.keys(CATEGORIES).map((c) => ({ c, rows: known.filter((m) => m.category === c) })).filter((g) => g.rows.length)

  const row = (m: MemoryRow) => (
    <li key={m.id} className="px-4 py-3 space-y-1.5">
      {editing?.id === m.id ? (
        <form onSubmit={(e) => { e.preventDefault(); void change(m.id, { content: editing.content }) }} className="space-y-2">
          <label htmlFor={`edit-${m.id}`} className="sr-only">Edit memory</label>
          <textarea id={`edit-${m.id}`} value={editing.content} onChange={(e) => setEditing({ id: m.id, content: e.target.value })} rows={2} maxLength={500} className={field} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy === m.id || editing.content.trim().length < 3}>{busy === m.id && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}Save</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-neutral-900 dark:text-neutral-100">{m.content}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
        {m.subject && <span className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-neutral-700 dark:text-neutral-300">{m.subject}</span>}
        {m.forAgent && <span className="rounded-full bg-violet-50 dark:bg-violet-900/30 px-2 py-0.5 text-violet-800 dark:text-violet-300">Lesson for {m.forAgent.name.split(/\s+[-–]\s+/)[0]}</span>}
        {m.trust === 'staff'
          ? <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400"><ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />Confirmed{m.reviewedBy && m.source.kind !== 'staff' ? ` by ${m.reviewedBy}` : ''}</span>
          : m.status === 'ACTIVE' && <span>Not confirmed by a person</span>}
        <span>{origin(m)}</span>
        {m.source.caseId && <Link href={`/dashboard/cases#${m.source.caseId}`} className="underline">see the case</Link>}
        <span className="tabular-nums">{m.useCount ? `Used ${m.useCount} time${m.useCount === 1 ? '' : 's'}${m.lastUsedAt ? `, last ${formatDateTime(m.lastUsedAt)}` : ''}` : `Saved ${formatDateTime(m.createdAt)}`}</span>
      </div>
      {editing?.id !== m.id && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {m.status === 'PENDING' && (
            <button onClick={() => change(m.id, { status: 'ACTIVE' })} disabled={busy !== null} className="inline-flex items-center gap-1 rounded-lg bg-green-600 hover:bg-green-700 text-white px-2.5 py-1 text-xs font-medium disabled:opacity-60">
              {busy === m.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}Confirm, the team can use it
            </button>
          )}
          {m.status !== 'ARCHIVED' && (
            <button onClick={() => setEditing({ id: m.id, content: m.content })} disabled={busy !== null} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"><Pencil className="w-3.5 h-3.5" />Edit</button>
          )}
          {m.status === 'ARCHIVED' ? (
            <>
              <button onClick={() => change(m.id, { status: 'ACTIVE' })} disabled={busy !== null} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"><RotateCcw className="w-3.5 h-3.5" />Use again</button>
              <button onClick={() => change(m.id, {}, 'DELETE')} disabled={busy !== null} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-neutral-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"><Trash2 className="w-3.5 h-3.5" />Delete for good</button>
            </>
          ) : (
            <button onClick={() => change(m.id, { status: 'ARCHIVED' })} disabled={busy !== null} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-neutral-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20">
              <Archive className="w-3.5 h-3.5" />{m.status === 'PENDING' ? 'Not true, discard' : 'Stop using'}
            </button>
          )}
        </div>
      )}
    </li>
  )

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">What the team knows</h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1 max-w-2xl">
            What your agents have learned about the business while they work, and what you&apos;ve told them. Every agent uses it. Things a customer or an email told them wait here until you confirm them.
          </p>
        </div>
        <Button onClick={() => setAdding((a) => !a)}><Plus className="w-4 h-4 mr-2" />Tell the team something</Button>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <span className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 tabular-nums">{data.counts.ACTIVE ?? 0} in use</span>
        <span className={`px-3 py-1.5 rounded-lg border tabular-nums ${data.counts.PENDING ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200' : 'border-neutral-200 dark:border-neutral-800 text-neutral-500'}`}>{data.counts.PENDING ?? 0} waiting for you</span>
        <button onClick={() => setShowArchived((s) => !s)} className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 tabular-nums">
          {showArchived ? 'Back to current' : `${data.counts.ARCHIVED ?? 0} archived`}
        </button>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}

      {adding && (
        <form onSubmit={add} className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-5 space-y-3">
          <div>
            <label htmlFor="memory-content" className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">What should the team know?</label>
            <textarea id="memory-content" value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} rows={2} maxLength={500} placeholder="e.g. We're closed between Christmas and New Year; book anything after 5 January." className={field} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="memory-category" className="block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1">Kind</label>
              <select id="memory-category" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className={field}>
                {Object.entries(CATEGORIES).map(([value, c]) => <option key={value} value={value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="memory-subject" className="block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1">About (optional)</label>
              <input id="memory-subject" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="A customer or company" maxLength={120} className={field} />
            </div>
            <div>
              <label htmlFor="memory-agent" className="block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1">For</label>
              <select id="memory-agent" value={draft.agentId} onChange={(e) => setDraft({ ...draft, agentId: e.target.value })} className={field}>
                <option value="">The whole team</option>
                {data.agents.map((a) => <option key={a.id} value={a.id}>Only {a.name}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy === 'new' || draft.content.trim().length < 3}>{busy === 'new' && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Save</Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {!showArchived && waiting.length > 0 && (
        <section className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/10" aria-labelledby="waiting-heading">
          <div className="px-4 pt-4">
            <h2 id="waiting-heading" className="text-sm font-semibold text-amber-900 dark:text-amber-200">Waiting for you to confirm</h2>
            <p className="text-xs text-amber-800/80 dark:text-amber-300/80">Picked up from a customer, an email or an agent&apos;s own conclusion. Agents don&apos;t use these until you confirm them.</p>
          </div>
          <ul className="divide-y divide-amber-200 dark:divide-amber-800/50">{waiting.map(row)}</ul>
        </section>
      )}

      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[14rem]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" aria-hidden="true" />
          <label htmlFor="memory-search" className="sr-only">Search memories</label>
          <input id="memory-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search, e.g. a customer's name" className={`${field} pl-9`} />
        </div>
        <label htmlFor="memory-filter" className="sr-only">Kind</label>
        <select id="memory-filter" value={category} onChange={(e) => setCategory(e.target.value)} className={`${field} sm:!w-56`}>
          <option value="">Every kind</option>
          {Object.entries(CATEGORIES).map(([value, c]) => <option key={value} value={value}>{c.label}</option>)}
        </select>
      </div>

      {groups.length === 0 ? (
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 p-8 text-center space-y-2">
          <Lightbulb className="w-6 h-6 mx-auto text-neutral-400" aria-hidden="true" />
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{q || category ? 'Nothing matches.' : showArchived ? 'Nothing archived.' : 'Nothing learned yet. As agents work they save what they learn here, and you can tell them things yourself.'}</p>
        </div>
      ) : (
        groups.map(({ c, rows }) => (
          <section key={c} className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800" aria-labelledby={`group-${c}`}>
            <div className="px-4 pt-4 pb-1">
              <h2 id={`group-${c}`} className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{CATEGORIES[c].label} <span className="font-normal text-neutral-500 tabular-nums">({rows.length})</span></h2>
              <p className="text-xs text-neutral-500">{CATEGORIES[c].hint}</p>
            </div>
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">{rows.map(row)}</ul>
          </section>
        ))
      )}
    </div>
  )
}
