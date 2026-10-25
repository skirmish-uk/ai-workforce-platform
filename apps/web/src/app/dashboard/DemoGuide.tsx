'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { Check, ChevronRight, Presentation, RotateCcw, X } from 'lucide-react'

/**
 * The demo script as a checklist (DEMO.md), on every dashboard page of the demo business: each
 * step says where to go, what to do and what to point out. Ticks are kept in this browser only.
 */
const STEPS = [
  { href: '/dashboard', title: 'The team at work', do: 'Start on the home page.', say: 'Real numbers from the audit trail: tasks finished, time saved, cost per task (cents), and what is waiting for a person.' },
  { href: '/dashboard/cases', title: 'Work moving through the team', do: 'Team cases → "New enquiry from the website".', say: 'Sarah qualifies the lead, drafts the reply and CRM record, and hands the booking to Riley, who already knows Alex takes discovery calls. Under a minute.' },
  { href: '/dashboard/approvals', title: 'People stay in charge', do: 'Open Approvals; reject one with a reason.', say: 'Nothing goes out unapproved. The reason becomes a lesson that agent remembers next time.' },
  { href: '/dashboard/memory', title: 'The team learns the business', do: 'Show What the team knows, then tell Ava something in her chat ("from 1 December we close at 4:30").', say: 'Every agent uses it straight away. Things a customer says wait here for you to confirm; customers can\'t teach the team rules.' },
  { href: '/dashboard/agents/demo-assistant-1', title: 'A voice agent', do: 'Talk to Ava: ask about packages, interrupt her, then say goodbye.', say: 'Australian voice, answers from the business\'s documents, offers real free times, hangs up politely.' },
  { href: '/dashboard/improvements', title: 'Self-improvement', do: 'Show the Improvements page (or run the staged self-repair, DEMO.md).', say: 'The manager proposes a fix, the platform tests it against the live version, and only promotes it if it scores at least as well. Rolling back takes one click and a reason.' },
  { href: '/dashboard/onboarding', title: 'Onboarding in minutes', do: 'Learn from your website: paste the prospect\'s own site.', say: 'About a minute later the team knows their services, prices, hours and FAQs, lists what\'s missing and suggests a team. Undo afterwards.' },
  { href: '/dashboard/team', title: 'Safety', do: 'Team page: point at Stop all agents.', say: 'Kill switches, spend caps, approval levels and an audit trail for every action.' },
]

const KEY = 'demo-guide-done'

export function DemoGuide() {
  const { data: session } = useSession()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState<Set<number>>(new Set())

  useEffect(() => {
    try {
      setDone(new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as number[]))
    } catch { /* storage unavailable: start empty */ }
  }, [])
  const save = (next: Set<number>) => {
    setDone(next)
    try { localStorage.setItem(KEY, JSON.stringify(Array.from(next))) } catch { /* not kept */ }
  }

  if ((session?.user as { tenantSlug?: string } | undefined)?.tenantSlug !== 'demo-agency') return null

  return (
    <>
      {!open && (
        <button onClick={() => setOpen(true)} className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 px-4 py-2.5 text-sm font-medium shadow-lg hover:opacity-90">
          <Presentation className="w-4 h-4" aria-hidden="true" />Demo guide <span className="tabular-nums text-xs opacity-70">{done.size}/{STEPS.length}</span>
        </button>
      )}
      {open && (
        <aside aria-label="Demo guide" className="fixed bottom-4 right-4 z-40 w-[min(24rem,calc(100vw-2rem))] max-h-[min(36rem,calc(100vh-2rem))] overflow-y-auto rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-xl">
          <div className="sticky top-0 flex items-center justify-between gap-2 border-b border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-3">
            <p className="font-semibold text-neutral-900 dark:text-neutral-50 flex items-center gap-2"><Presentation className="w-4 h-4 text-primary-600" aria-hidden="true" />Demo guide</p>
            <div className="flex items-center gap-1">
              <button onClick={() => save(new Set())} aria-label="Start again" className="p-1.5 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"><RotateCcw className="w-4 h-4" /></button>
              <button onClick={() => setOpen(false)} aria-label="Close" className="p-1.5 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"><X className="w-4 h-4" /></button>
            </div>
          </div>
          <ol className="p-2">
            {STEPS.map((s, i) => {
              const here = pathname === s.href
              const ticked = done.has(i)
              return (
                <li key={s.href} className={`rounded-xl p-2.5 ${here ? 'bg-primary-50 dark:bg-primary-900/20' : ''}`}>
                  <div className="flex items-start gap-2.5">
                    <button
                      onClick={() => { const next = new Set(done); if (ticked) next.delete(i); else next.add(i); save(next) }}
                      aria-label={ticked ? `Mark "${s.title}" not done` : `Mark "${s.title}" done`}
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium ${ticked ? 'border-green-600 bg-green-600 text-white' : 'border-neutral-300 dark:border-neutral-600 text-neutral-500'}`}
                    >
                      {ticked ? <Check className="w-3 h-3" /> : i + 1}
                    </button>
                    <div className="min-w-0">
                      <Link href={s.href} className={`font-medium text-sm inline-flex items-center gap-0.5 ${ticked ? 'text-neutral-500 line-through' : 'text-neutral-900 dark:text-neutral-100'} hover:text-primary-600`}>{s.title}<ChevronRight className="w-3.5 h-3.5" aria-hidden="true" /></Link>
                      {(here || !ticked) && (
                        <>
                          <p className="text-xs text-neutral-700 dark:text-neutral-300 mt-0.5">{s.do}</p>
                          {here && <p className="text-xs text-neutral-500 mt-1 italic">“{s.say}”</p>}
                        </>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
          <p className="px-4 pb-3 text-[11px] text-neutral-500">Reset the demo afterwards: npm run demo:reset (DEMO.md).</p>
        </aside>
      )}
    </>
  )
}
