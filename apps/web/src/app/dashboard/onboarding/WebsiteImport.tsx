'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, CheckCircle2, Globe, HelpCircle, Loader2, Plus, Sparkles, Trash2, Undo2, UserPlus } from 'lucide-react'
import { Button, formatDateTime } from '@ai-workforce/ui'

interface Service { name: string; description: string; price: string }
interface Profile {
  businessName: string
  summary: string
  industry: string
  location: string
  audience: string
  contact: { phone?: string; email?: string; address?: string }
  hours: string
  services: Service[]
  policies: string[]
  faqs: Array<{ question: string; answer: string }>
  tone: string
  facts: Array<{ fact: string; category: string }>
  unknowns: string[]
  suggestedAgents: Array<{ name: string; role: string; why: string; tasks: string[] }>
  applied?: { documentIds?: string[]; memoryIds?: string[]; profile?: boolean }
}
interface Import {
  id: string
  url: string
  status: 'READING' | 'READY' | 'APPLIED' | 'FAILED'
  pages: Array<{ url: string; title: string; chars: number }>
  profile: Profile | null
  error: string | null
  costUsd: number | null
  createdAt: string
  appliedAt: string | null
}

const field = 'w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500'
const label = 'block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1'
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url } }

/**
 * "Learn from your website" (docs/ONBOARDING_WEBSITE.md): paste the business's address, the
 * worker reads the site and drafts a profile, you check and edit it, then apply what you want:
 * the business profile every agent works from, knowledge documents, and notes for the team's
 * memory. Suggested agents link to the new-agent form, filled in. Every import can be undone.
 */
export function WebsiteImport() {
  const [url, setUrl] = useState('')
  const [imports, setImports] = useState<Import[]>([])
  const [hasProfile, setHasProfile] = useState(false)
  const [current, setCurrent] = useState<Import | null>(null)
  const [draft, setDraft] = useState<Profile | null>(null)
  const [choices, setChoices] = useState({ profile: false, documents: true, facts: new Set<number>() })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ documents: number; facts: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (focusId?: string) => {
    const res = await fetch('/api/onboarding/website')
    if (!res.ok) return null
    const body = await res.json()
    setImports(body.imports)
    setHasProfile(body.hasBusinessProfile)
    const focus = (body.imports as Import[]).find((i) => i.id === focusId)
    if (focus) {
      setCurrent(focus)
      if (focus.status === 'READY' && focus.profile) {
        setDraft(focus.profile)
        setChoices({ profile: !body.hasBusinessProfile, documents: true, facts: new Set(focus.profile.facts.map((_, i) => i)) })
      }
    }
    return focus ?? null
  }, [])

  useEffect(() => { void load() ; return () => { if (timer.current) clearTimeout(timer.current) } }, [load])

  const watch = (id: string) => {
    const tick = async () => {
      const row = await load(id)
      if (row?.status === 'READING') timer.current = setTimeout(tick, 2000)
    }
    timer.current = setTimeout(tick, 1500)
  }

  const start = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy('start')
    setError(null)
    setDone(null)
    setDraft(null)
    try {
      const res = await fetch('/api/onboarding/website', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setCurrent({ id: body.id, url, status: 'READING', pages: [], profile: null, error: null, costUsd: null, createdAt: new Date().toISOString(), appliedAt: null })
      watch(body.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that website')
    } finally {
      setBusy(null)
    }
  }

  const act = async (id: string, body: Record<string, unknown>) => {
    setBusy(id)
    setError(null)
    try {
      const res = await fetch(`/api/onboarding/website/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const out = await res.json()
      if (!res.ok) throw new Error(out.error ?? `Request failed (${res.status})`)
      return out
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      return null
    } finally {
      setBusy(null)
    }
  }

  const apply = async () => {
    if (!current || !draft) return
    const out = await act(current.id, { action: 'apply', profile: draft, choices: { profile: choices.profile, documents: choices.documents, facts: Array.from(choices.facts) } })
    if (out) {
      setDone({ documents: out.documentIds.length, facts: out.memoryIds.length })
      await load(current.id)
    }
  }

  const undo = async (id: string) => {
    if (await act(id, { action: 'undo' })) {
      setDone(null)
      await load(id)
    }
  }

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d))
  const reading = current?.status === 'READING'
  const reviewing = current?.status === 'READY' && draft

  return (
    <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-5 space-y-4" aria-labelledby="website-heading">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary-50 dark:bg-primary-900/30 p-2"><Globe className="w-5 h-5 text-primary-600" aria-hidden="true" /></div>
        <div>
          <h2 id="website-heading" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">Learn from your website</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">Paste your website and the team reads it: what you do, your services and prices, hours, policies and FAQs. You check everything before they use it.</p>
        </div>
      </div>

      <form onSubmit={start} className="flex flex-wrap gap-2">
        <label htmlFor="website-url" className="sr-only">Website address</label>
        <input id="website-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="yourbusiness.com.au" className={`${field} flex-1 min-w-[14rem]`} disabled={reading} />
        <Button type="submit" disabled={!url.trim() || busy !== null || reading}>{busy === 'start' || reading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}Read the website</Button>
      </form>

      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}

      {reading && (
        <div className="rounded-lg bg-neutral-50 dark:bg-neutral-800/50 p-4 text-sm space-y-1" role="status">
          <p className="flex items-center gap-2 font-medium text-neutral-800 dark:text-neutral-200"><Loader2 className="w-4 h-4 animate-spin" />Reading {host(current.url)}…</p>
          <p className="text-neutral-500">{current.pages.length ? `Read ${current.pages.length} pages; now working out what they say about the business.` : 'Finding the pages that describe the business (about, services, prices, contact, FAQ).'} Usually under a minute.</p>
          {current.pages.length > 0 && <ul className="text-xs text-neutral-500 list-disc pl-5">{current.pages.map((p) => <li key={p.url}>{p.title || p.url}</li>)}</ul>}
        </div>
      )}

      {current?.status === 'FAILED' && <p className="text-sm text-red-600 dark:text-red-400" role="alert">Couldn’t read {host(current.url)}: {current.error}</p>}

      {done && current?.status === 'APPLIED' && (
        <div className="rounded-lg bg-green-50 dark:bg-green-900/20 p-4 text-sm text-green-900 dark:text-green-200 flex flex-wrap items-center gap-3">
          <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
          <span>Done. The team now knows {current.profile?.businessName || host(current.url)}: {choices.profile ? 'the business profile, ' : ''}{done.documents} knowledge document{done.documents === 1 ? '' : 's'} and {done.facts} note{done.facts === 1 ? '' : 's'}.</span>
          <Link href="/dashboard/memory" className="underline">See what the team knows</Link>
          <button onClick={() => undo(current.id)} disabled={busy !== null} className="inline-flex items-center gap-1 underline"><Undo2 className="w-3.5 h-3.5" />Undo</button>
        </div>
      )}

      {reviewing && draft && (
        <div className="space-y-5 border-t border-neutral-100 dark:border-neutral-800 pt-4">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">Read {current.pages.length} page{current.pages.length === 1 ? '' : 's'} of {host(current.url)}. Check and correct anything below; nothing is used until you apply it.</p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div><label htmlFor="wi-name" className={label}>Business</label><input id="wi-name" value={draft.businessName} onChange={(e) => set('businessName', e.target.value)} className={field} /></div>
            <div><label htmlFor="wi-industry" className={label}>Industry</label><input id="wi-industry" value={draft.industry} onChange={(e) => set('industry', e.target.value)} className={field} /></div>
            <div className="sm:col-span-2"><label htmlFor="wi-summary" className={label}>What you do</label><textarea id="wi-summary" value={draft.summary} onChange={(e) => set('summary', e.target.value)} rows={3} className={field} /></div>
            <div><label htmlFor="wi-audience" className={label}>Customers</label><textarea id="wi-audience" value={draft.audience} onChange={(e) => set('audience', e.target.value)} rows={2} className={field} /></div>
            <div><label htmlFor="wi-location" className={label}>Location</label><textarea id="wi-location" value={draft.location} onChange={(e) => set('location', e.target.value)} rows={2} className={field} /></div>
            <div><label htmlFor="wi-hours" className={label}>Hours</label><input id="wi-hours" value={draft.hours} onChange={(e) => set('hours', e.target.value)} placeholder="Not on the website" className={field} /></div>
            <div><label htmlFor="wi-tone" className={label}>How you talk to customers</label><input id="wi-tone" value={draft.tone} onChange={(e) => set('tone', e.target.value)} className={field} /></div>
            <div><label htmlFor="wi-phone" className={label}>Phone</label><input id="wi-phone" value={draft.contact.phone ?? ''} onChange={(e) => set('contact', { ...draft.contact, phone: e.target.value })} className={field} /></div>
            <div><label htmlFor="wi-email" className={label}>Email</label><input id="wi-email" value={draft.contact.email ?? ''} onChange={(e) => set('contact', { ...draft.contact, email: e.target.value })} className={field} /></div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 mb-2">Services and prices <span className="font-normal text-neutral-500">({draft.services.length})</span></h3>
            <ul className="space-y-2">
              {draft.services.map((s, i) => (
                <li key={i} className="grid gap-2 sm:grid-cols-[1fr_10rem_auto] items-start">
                  <div className="space-y-1">
                    <label className="sr-only" htmlFor={`svc-${i}`}>Service</label>
                    <input id={`svc-${i}`} value={s.name} onChange={(e) => set('services', draft.services.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${field} font-medium`} />
                    <label className="sr-only" htmlFor={`svc-d-${i}`}>Description</label>
                    <input id={`svc-d-${i}`} value={s.description} onChange={(e) => set('services', draft.services.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} placeholder="Description" className={`${field} text-xs`} />
                  </div>
                  <div><label className="sr-only" htmlFor={`svc-p-${i}`}>Price</label><input id={`svc-p-${i}`} value={s.price} onChange={(e) => set('services', draft.services.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} placeholder="Price not listed" className={field} /></div>
                  <button type="button" onClick={() => set('services', draft.services.filter((_, j) => j !== i))} aria-label={`Remove ${s.name}`} className="p-2 text-neutral-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => set('services', [...draft.services, { name: 'New service', description: '', price: '' }])} className="mt-2 inline-flex items-center gap-1 text-xs text-primary-600"><Plus className="w-3.5 h-3.5" />Add a service</button>
          </div>

          <div>
            <label htmlFor="wi-policies" className="block text-sm font-semibold text-neutral-900 dark:text-neutral-50 mb-1">Policies <span className="font-normal text-neutral-500">(one per line)</span></label>
            <textarea id="wi-policies" value={draft.policies.join('\n')} onChange={(e) => set('policies', e.target.value.split('\n').filter((l) => l.trim()))} rows={Math.min(8, Math.max(2, draft.policies.length + 1))} className={field} />
          </div>

          {draft.faqs.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer font-semibold text-neutral-900 dark:text-neutral-50">Frequently asked questions ({draft.faqs.length})</summary>
              <dl className="mt-2 space-y-2">{draft.faqs.map((f, i) => <div key={i}><dt className="font-medium">{f.question}</dt><dd className="text-neutral-600 dark:text-neutral-400">{f.answer}</dd></div>)}</dl>
            </details>
          )}

          <div>
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 mb-1">Notes for the team&apos;s memory</h3>
            <p className="text-xs text-neutral-500 mb-2">Short facts every agent will know. Untick anything that&apos;s wrong or out of date.</p>
            <ul className="space-y-1">
              {draft.facts.map((f, i) => (
                <li key={i}>
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" checked={choices.facts.has(i)} onChange={(e) => setChoices((c) => { const facts = new Set(c.facts); if (e.target.checked) facts.add(i); else facts.delete(i); return { ...c, facts } })} className="mt-0.5 w-4 h-4" />
                    <span className="text-neutral-800 dark:text-neutral-200">{f.fact}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>

          {draft.unknowns.length > 0 && (
            <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 p-3">
              <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200 flex items-center gap-1.5"><HelpCircle className="w-4 h-4" aria-hidden="true" />Not on the website</h3>
              <p className="text-xs text-amber-800/80 dark:text-amber-300/80 mb-1">The agents won&apos;t guess these; they&apos;ll ask or hand to a person. Tell the team on the memory page when you can.</p>
              <ul className="text-sm text-amber-900 dark:text-amber-100 list-disc pl-5">{draft.unknowns.map((u, i) => <li key={i}>{u}</li>)}</ul>
            </div>
          )}

          {draft.suggestedAgents.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 mb-2">Suggested team</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {draft.suggestedAgents.map((a, i) => {
                  const q = new URLSearchParams({ name: `${a.name} - ${a.role}`, role: a.role, mission: a.why, instructions: `You are ${a.name}, the ${a.role} for ${draft.businessName || 'the business'}.\n\nYour work:\n${a.tasks.map((t) => `- ${t}`).join('\n')}\n\nUse the business profile, the reference documents and what the team knows. Never invent prices, hours or policies; ask or hand to a person when something isn't covered.` })
                  return (
                    <article key={i} className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-1.5">
                      <p className="font-medium text-neutral-900 dark:text-neutral-50">{a.name} <span className="font-normal text-neutral-500">· {a.role}</span></p>
                      <p className="text-xs text-neutral-600 dark:text-neutral-400">{a.why}</p>
                      {a.tasks.length > 0 && <ul className="text-xs text-neutral-500 list-disc pl-4">{a.tasks.map((t, j) => <li key={j}>{t}</li>)}</ul>}
                      <Link href={`/dashboard/agents/new?${q}`} className="inline-flex items-center gap-1 text-xs font-medium text-primary-600"><UserPlus className="w-3.5 h-3.5" />Set up {a.name}</Link>
                    </article>
                  )
                })}
              </div>
            </div>
          )}

          <fieldset className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-2">
            <legend className="px-1 text-sm font-semibold text-neutral-900 dark:text-neutral-50">Apply</legend>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={choices.profile} onChange={(e) => setChoices((c) => ({ ...c, profile: e.target.checked }))} className="mt-0.5 w-4 h-4" />
              <span>Use this as the business profile every agent works from{hasProfile && <span className="block text-xs text-amber-700 dark:text-amber-400">Replaces the current profile (you can undo it).</span>}</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={choices.documents} onChange={(e) => setChoices((c) => ({ ...c, documents: e.target.checked }))} className="mt-0.5 w-4 h-4" />
              <span>Add knowledge documents (about and contact, services and prices{draft.faqs.length ? ', FAQ' : ''}) for every agent</span>
            </label>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">and {choices.facts.size} note{choices.facts.size === 1 ? '' : 's'} for the team&apos;s memory.</p>
            <Button onClick={apply} disabled={busy !== null || (!choices.profile && !choices.documents && choices.facts.size === 0)}>{busy === current.id ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}Apply</Button>
          </fieldset>
        </div>
      )}

      {imports.filter((i) => i.id !== current?.id || i.status !== 'READING').length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-neutral-500">Earlier imports</summary>
          <ul className="mt-2 space-y-1">
            {imports.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
                <span className="font-medium text-neutral-800 dark:text-neutral-200">{host(i.url)}</span>
                <span>{i.status === 'APPLIED' ? `applied ${i.appliedAt ? formatDateTime(i.appliedAt) : ''}` : i.status.toLowerCase()}</span>
                <span>{formatDateTime(i.createdAt)}</span>
                {i.status === 'READY' && i.id !== current?.id && <button onClick={() => void load(i.id)} className="underline">Review</button>}
                {i.status === 'APPLIED' && <button onClick={() => undo(i.id)} disabled={busy !== null} className="inline-flex items-center gap-1 underline"><Undo2 className="w-3 h-3" />Undo</button>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
