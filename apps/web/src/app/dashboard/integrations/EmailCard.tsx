'use client'

import { useEffect, useState } from 'react'
import { Mail, Unplug, CheckCircle, AlertCircle, ArrowRightLeft } from 'lucide-react'
import { Button, Badge } from '@ai-workforce/ui'

/** Any mailbox over IMAP/SMTP (docs/EMAIL_CONNECT.md): connect it, then move the agents onto it. */

interface EmailStatus {
  state: 'connected' | 'sandbox' | 'not_connected'
  account: string | null
  servers: { imap: string; smtp: string } | null
  encryption: boolean
  canManage: boolean
  agents: { onGmail: Array<{ name: string; skipped: string | null }>; onEmail: Array<{ name: string; skipped: string | null }> }
}

interface TestResult {
  imap: { ok: boolean; error?: string; folders?: { sent: string | null; drafts: string | null; archive: string | null }; customLabels?: boolean | null }
  smtp: { ok: boolean; error?: string }
}

interface SwitchResult {
  applied: boolean
  agents: Array<{ name: string; tools: string[]; skipped?: string }>
}

const PRESETS = [
  { id: 'zoho', label: 'Zoho Mail (business)', imap: 'imappro.zoho.com', smtp: 'smtppro.zoho.com', smtpPort: 465, hint: 'Accounts outside the US data centre use regional servers (for example imappro.zoho.eu). Zoho shows yours under Settings → Mail Accounts → IMAP. Turn IMAP access on there, and use an app password if two-step sign-in is on.' },
  { id: 'zoho-free', label: 'Zoho Mail (free)', imap: 'imap.zoho.com', smtp: 'smtp.zoho.com', smtpPort: 465, hint: 'Check Zoho’s Settings → Mail Accounts → IMAP for your exact servers, and turn IMAP access on there.' },
  { id: 'fastmail', label: 'Fastmail', imap: 'imap.fastmail.com', smtp: 'smtp.fastmail.com', smtpPort: 465, hint: 'Use an app password (Settings → Privacy & Security → Integrations → App passwords), not your login password.' },
  { id: 'yahoo', label: 'Yahoo Mail', imap: 'imap.mail.yahoo.com', smtp: 'smtp.mail.yahoo.com', smtpPort: 465, hint: 'Yahoo needs an app password (Account security → Generate app password).' },
  { id: 'other', label: 'Other provider', imap: '', smtp: '', smtpPort: 465, hint: 'Your provider’s help pages list the IMAP and SMTP servers. Gmail and Microsoft 365 connect differently.' },
] as const

const field = 'w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500'
const label = 'block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1'

function TestLine({ name, ok, error }: { name: string; ok: boolean; error?: string }) {
  return (
    <li className="flex items-start gap-2">
      {ok ? <CheckCircle className="w-4 h-4 mt-0.5 shrink-0 text-green-600" /> : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />}
      <span>{name}: {ok ? 'signed in' : error ?? 'failed'}</span>
    </li>
  )
}

export function EmailCard({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<EmailStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [preset, setPreset] = useState<(typeof PRESETS)[number]['id']>('zoho')
  const [form, setForm] = useState({ email: '', password: '', username: '', fromName: '', imapHost: 'imappro.zoho.com', imapPort: 993, smtpHost: 'smtppro.zoho.com', smtpPort: 465, saveSentCopy: true })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [test, setTest] = useState<TestResult | null>(null)
  const [plan, setPlan] = useState<{ to: 'email' | 'gmail'; result: SwitchResult } | null>(null)

  const load = async () => {
    const res = await fetch('/api/integrations/email')
    if (res.ok) setStatus((await res.json()).data)
  }
  useEffect(() => { load() }, [])

  const choosePreset = (id: (typeof PRESETS)[number]['id']) => {
    const p = PRESETS.find((x) => x.id === id)!
    setPreset(id)
    setForm((f) => ({ ...f, imapHost: p.imap, imapPort: 993, smtpHost: p.smtp, smtpPort: p.smtpPort }))
  }

  const connect = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    setTest(null)
    try {
      const res = await fetch('/api/integrations/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email,
          password: form.password,
          ...(form.username.trim() ? { username: form.username.trim() } : {}),
          ...(form.fromName.trim() ? { fromName: form.fromName.trim() } : {}),
          imap: { host: form.imapHost, port: Number(form.imapPort) },
          smtp: { host: form.smtpHost, port: Number(form.smtpPort) },
          saveSentCopy: form.saveSentCopy,
        }),
      })
      const body = await res.json().catch(() => ({}))
      setTest(body.test ?? body.data?.test ?? null)
      if (res.ok) {
        setMessage({ tone: 'ok', text: `Connected ${body.data.account}. The password is stored encrypted.` })
        setForm((f) => ({ ...f, password: '' }))
        setOpen(false)
        await load()
        onChanged()
      } else {
        setMessage({ tone: 'bad', text: body.error ?? 'Could not connect.' })
      }
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    if (!window.confirm('Disconnect this mailbox? The stored password is deleted, and agents set up for it stop reading and sending email until you connect again.')) return
    setBusy(true)
    try {
      await fetch('/api/integrations/email', { method: 'DELETE' })
      setMessage({ tone: 'ok', text: 'Mailbox disconnected and its password deleted.' })
      await load()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const switchAgents = async (to: 'email' | 'gmail', apply: boolean) => {
    setBusy(true)
    try {
      const res = await fetch('/api/integrations/email/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, apply }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMessage({ tone: 'bad', text: body.error ?? 'Could not switch the agents.' })
        setPlan(null)
        return
      }
      if (apply) {
        const moved = (body.data as SwitchResult).agents.filter((a) => !a.skipped).map((a) => a.name)
        setMessage({ tone: 'ok', text: `${moved.length ? moved.join(', ') : 'No agents'} now use ${to === 'email' ? 'this mailbox' : 'Gmail'}. Each is a new version: agents with more autonomy ask for approval again until their tests pass (Run tests on the agent's page).` })
        setPlan(null)
        await load()
      } else {
        setPlan({ to, result: body.data })
      }
    } finally {
      setBusy(false)
    }
  }

  if (!status) return null
  const connected = status.state === 'connected' || status.state === 'sandbox'
  const hint = PRESETS.find((p) => p.id === preset)?.hint

  return (
    <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-5 space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-10 h-10 shrink-0 rounded-lg bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center"><Mail className="w-5 h-5 text-primary-600" /></div>
          <div className="min-w-0">
            <h2 className="font-semibold text-neutral-900 dark:text-neutral-50">Other email (Zoho, Fastmail, your host…)</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">Connect any mailbox with its IMAP and SMTP settings. Agents read, label, file and draft email in it; sending always waits for your approval.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge variant={status.state === 'connected' ? 'success' : status.state === 'sandbox' ? 'info' : 'default'}>
                {status.state === 'connected' ? `Connected as ${status.account}` : status.state === 'sandbox' ? 'Sandbox (demo data)' : 'Not connected'}
              </Badge>
              {status.servers && <span className="text-xs text-neutral-500 dark:text-neutral-400 self-center">{status.servers.imap} · {status.servers.smtp}</span>}
            </div>
          </div>
        </div>
        {status.canManage && (
          <div className="flex gap-2 shrink-0">
            {connected && (
              <Button variant="outline" onClick={disconnect} disabled={busy}>
                <Unplug className="w-4 h-4 mr-2" />
                Disconnect
              </Button>
            )}
            <Button onClick={() => setOpen((o) => !o)} disabled={busy || !status.encryption} title={status.encryption ? undefined : 'CREDENTIALS_ENCRYPTION_KEY is not set on the server'}>
              {connected ? 'Change mailbox' : 'Connect a mailbox'}
            </Button>
          </div>
        )}
      </div>

      {message && (
        <div role="status" className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${message.tone === 'ok' ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300' : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'}`}>
          {message.tone === 'ok' ? <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
          <span>{message.text}</span>
        </div>
      )}
      {test && (
        <ul className="text-sm space-y-1 text-neutral-700 dark:text-neutral-300">
          <TestLine name={`Reading (IMAP ${form.imapHost})`} ok={test.imap.ok} error={test.imap.error} />
          <TestLine name={`Sending (SMTP ${form.smtpHost})`} ok={test.smtp.ok} error={test.smtp.error} />
          {test.imap.ok && test.imap.customLabels === false && <li className="text-xs text-neutral-500">This mailbox doesn’t allow custom labels: agents file email in folders instead.</li>}
        </ul>
      )}

      {open && status.canManage && (
        <form onSubmit={connect} className="grid gap-3 sm:grid-cols-2 border-t border-neutral-200 dark:border-neutral-800 pt-4">
          <div className="sm:col-span-2">
            <label className={label} htmlFor="mail-provider">Provider</label>
            <select id="mail-provider" className={field} value={preset} onChange={(e) => choosePreset(e.target.value as typeof preset)}>
              {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            {hint && <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>}
          </div>
          <div>
            <label className={label} htmlFor="mail-email">Email address</label>
            <input id="mail-email" type="email" required autoComplete="off" className={field} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="office@youragency.com.au" />
          </div>
          <div>
            <label className={label} htmlFor="mail-password">Password or app password</label>
            <input id="mail-password" type="password" required autoComplete="new-password" className={field} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          <div>
            <label className={label} htmlFor="mail-imap">IMAP server (reading)</label>
            <div className="flex gap-2">
              <input id="mail-imap" required className={field} value={form.imapHost} onChange={(e) => setForm({ ...form, imapHost: e.target.value })} placeholder="imap.example.com" />
              <select aria-label="IMAP port" className={`${field} w-28`} value={form.imapPort} onChange={(e) => setForm({ ...form, imapPort: Number(e.target.value) })}>
                <option value={993}>993 (SSL)</option>
                <option value={143}>143 (STARTTLS)</option>
              </select>
            </div>
          </div>
          <div>
            <label className={label} htmlFor="mail-smtp">SMTP server (sending)</label>
            <div className="flex gap-2">
              <input id="mail-smtp" required className={field} value={form.smtpHost} onChange={(e) => setForm({ ...form, smtpHost: e.target.value })} placeholder="smtp.example.com" />
              <select aria-label="SMTP port" className={`${field} w-28`} value={form.smtpPort} onChange={(e) => setForm({ ...form, smtpPort: Number(e.target.value) })}>
                <option value={465}>465 (SSL)</option>
                <option value={587}>587 (STARTTLS)</option>
              </select>
            </div>
          </div>
          <div>
            <label className={label} htmlFor="mail-from">Sender name (optional)</label>
            <input id="mail-from" className={field} value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} placeholder="Demo Marketing Agency" />
          </div>
          <div>
            <label className={label} htmlFor="mail-user">Login name, if not the address (optional)</label>
            <input id="mail-user" autoComplete="off" className={field} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </div>
          <label className="sm:col-span-2 flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
            <input type="checkbox" checked={form.saveSentCopy} onChange={(e) => setForm({ ...form, saveSentCopy: e.target.checked })} />
            Keep a copy of sent email in the Sent folder (turn off if your provider already does)
          </label>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy} className="whitespace-nowrap">{busy ? 'Testing the login…' : 'Test and connect'}</Button>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">Signs in to both servers without sending anything. Nothing is stored unless both work.</span>
          </div>
        </form>
      )}

      {connected && status.canManage && (status.agents.onGmail.length > 0 || status.agents.onEmail.length > 0) && (
        <div className="border-t border-neutral-200 dark:border-neutral-800 pt-4 text-sm space-y-2">
          {status.agents.onGmail.length > 0 ? (
            <p className="text-neutral-700 dark:text-neutral-300">
              {status.agents.onGmail.map((a) => a.name).join(', ')} {status.agents.onGmail.length === 1 ? 'is' : 'are'} set up for Gmail.{' '}
              <button className="text-primary-600 hover:underline font-medium" disabled={busy} onClick={() => switchAgents('email', false)}>Use this mailbox for them</button>
            </p>
          ) : (
            <p className="text-neutral-700 dark:text-neutral-300">
              {status.agents.onEmail.map((a) => a.name).join(', ')} use{status.agents.onEmail.length === 1 ? 's' : ''} this mailbox.{' '}
              <button className="text-neutral-500 hover:underline" disabled={busy} onClick={() => switchAgents('gmail', false)}>Switch back to Gmail</button>
            </p>
          )}
          {plan && (
            <div className="rounded-lg bg-neutral-50 dark:bg-neutral-800/60 p-3 space-y-2">
              <p className="font-medium text-neutral-900 dark:text-neutral-100 flex items-center gap-2"><ArrowRightLeft className="w-4 h-4" />Move to {plan.to === 'email' ? 'this mailbox' : 'Gmail'}:</p>
              <ul className="space-y-1">
                {plan.result.agents.map((a) => (
                  <li key={a.name}>
                    <span className="font-medium">{a.name}</span>{' '}
                    {a.skipped ? <span className="text-amber-700 dark:text-amber-300">stays as it is: {a.skipped}</span> : <span className="text-neutral-500">{a.tools.length} tool{a.tools.length === 1 ? '' : 's'} renamed</span>}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">Their instructions, tests, permissions and approval rules change to the new mailbox’s tools, as a new version of each agent. Agents with more autonomy ask for approval again until their tests pass.</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => switchAgents(plan.to, true)} disabled={busy || plan.result.agents.every((a) => a.skipped)}>Move them</Button>
                <Button size="sm" variant="outline" onClick={() => setPlan(null)} disabled={busy}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
