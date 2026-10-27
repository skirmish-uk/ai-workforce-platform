import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'
import { z } from 'zod'
import { ImapFlow, type SearchObject, type FetchMessageObject, type MessageAddressObject } from 'imapflow'
import { simpleParser, type AddressObject } from 'mailparser'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import { isBlockedAddress } from '@ai-workforce/domain'
import { BaseIntegrationAdapter } from './base'
import { headerValue, subjectValue } from './gmail'

/**
 * Any mailbox over IMAP (reading, labels, folders, drafts) and SMTP (sending): Zoho, Fastmail,
 * iCloud, Yahoo and most hosting providers, with the account's password or an app password.
 * Tools are `email__*` with the same action names and inputs as `gmail__*` (Gmail-style
 * searches like "is:unread from:maria" are translated to IMAP), so switching a tenant's agents
 * from Gmail is a rename (packages/executor/src/mailbox-switch.ts). Full write-up:
 * docs/EMAIL_CONNECT.md.
 *
 * The server runs these connections on a customer's behalf, so the mail host is resolved once
 * and must be a public address (connected to by IP, with TLS still checked against the host
 * name), only on the standard mail ports, and the password never crosses the wire unencrypted
 * (implicit TLS, or STARTTLS required). EMAIL_ALLOW_LOCAL_SERVERS=true lifts those rules for a
 * local test server (private addresses, any port, self-signed certificates); it is ignored when
 * NODE_ENV=production.
 */

export const EMAIL_INTEGRATION_NAME = 'Email'

/** Ports and whether each is implicit TLS (true) or STARTTLS (false). */
export const IMAP_PORTS: Record<number, boolean> = { 993: true, 143: false }
export const SMTP_PORTS: Record<number, boolean> = { 465: true, 587: false, 2525: false, 25: false }

const serverSchema = z.object({ host: z.string().trim().min(1).max(253), port: z.number().int().min(1).max(65535) })

/** What is stored (encrypted) in Integration.credentials for a mailbox. */
export const mailboxCredentialsSchema = z.object({
  email: z.string().trim().email(),
  /** Login name when it differs from the address. */
  username: z.string().trim().min(1).max(320).optional(),
  password: z.string().min(1).max(1024),
  fromName: z.string().trim().max(120).refine((v) => !/[\r\n"<>]/.test(v), { message: 'must not contain line breaks, quotes or angle brackets' }).optional(),
  imap: serverSchema,
  smtp: serverSchema,
  /** Save a copy of sent mail in the Sent folder (most hosts don't do it for SMTP). */
  saveSentCopy: z.boolean().default(true),
})
export type MailboxCredentials = z.infer<typeof mailboxCredentialsSchema>

export class MailboxError extends Error {
  constructor(message: string, readonly code: 'blocked_host' | 'bad_port' | 'auth' | 'connect' | 'not_found' | 'unsupported' | 'invalid') {
    super(message)
    this.name = 'MailboxError'
  }
}

type Env = Record<string, string | undefined>

export function localServersAllowed(env: Env = process.env): boolean {
  return env.EMAIL_ALLOW_LOCAL_SERVERS === 'true' && env.NODE_ENV !== 'production'
}

/** Whether a port is allowed and how TLS is used on it (null: not allowed). */
export function tlsModeFor(kind: 'imap' | 'smtp', port: number, env: Env = process.env): 'implicit' | 'starttls' | 'local' | null {
  const table = kind === 'imap' ? IMAP_PORTS : SMTP_PORTS
  if (port in table) return table[port] ? 'implicit' : 'starttls'
  return localServersAllowed(env) ? 'local' : null
}

type Lookup = (host: string) => Promise<Array<{ address: string }>>
const defaultLookup: Lookup = (host) => dns.lookup(host, { all: true })

/**
 * The address to connect to for a mail host: resolved once (so the host can't switch to an
 * internal address between the check and the connection) and refused if it is private.
 */
export async function resolveMailHost(host: string, env: Env = process.env, lookup: Lookup = defaultLookup): Promise<{ address: string; servername: string | undefined }> {
  const name = host.trim().replace(/^\[|\]$/g, '').toLowerCase()
  const allowLocal = localServersAllowed(env)
  if (isIP(name)) {
    if (!allowLocal && isBlockedAddress(name)) throw new MailboxError(`${host} is a private or reserved address.`, 'blocked_host')
    // TLS checks an IP address on its own; a server name (SNI) can't be an IP.
    return { address: name, servername: undefined }
  }
  if (!/^[a-z0-9.-]+$/.test(name) || (!allowLocal && !name.includes('.'))) throw new MailboxError(`${host} isn't a mail server name.`, 'blocked_host')
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(name)
  } catch {
    throw new MailboxError(`Couldn't find the mail server ${host}. Check the spelling.`, 'connect')
  }
  if (!addresses.length) throw new MailboxError(`Couldn't find the mail server ${host}.`, 'connect')
  if (!allowLocal && addresses.some((a) => isBlockedAddress(a.address))) throw new MailboxError(`${host} points to a private or reserved address.`, 'blocked_host')
  return { address: addresses[0].address, servername: name }
}

// ------------------------------------------------------------------------------ ids, labels, queries

/** Message ids are "<folder>:<uid>", e.g. "INBOX:4521". */
export function encodeMessageId(mailbox: string, uid: number): string {
  return `${mailbox}:${uid}`
}

export function decodeMessageId(id: string): { mailbox: string; uid: number } {
  const m = /^(.+):(\d+)$/.exec(id.trim())
  // A bare number is a message in the inbox.
  if (!m) {
    if (/^\d+$/.test(id.trim())) return { mailbox: 'INBOX', uid: Number(id.trim()) }
    throw new MailboxError(`"${id}" isn't an email id from this mailbox (expected e.g. "INBOX:4521").`, 'invalid')
  }
  return { mailbox: m[1], uid: Number(m[2]) }
}

/** IMAP flags as Gmail-style labels: UNREAD, STARRED, IMPORTANT, DRAFT, ANSWERED, the folder, and custom labels (keywords). */
export function flagsToLabels(flags: Iterable<string>, mailbox: string): string[] {
  const set = new Set(flags)
  const labels = [mailbox.toUpperCase() === 'INBOX' ? 'INBOX' : mailbox]
  if (!set.has('\\Seen')) labels.push('UNREAD')
  if (set.has('\\Flagged')) labels.push('STARRED')
  if (set.has('\\Answered')) labels.push('ANSWERED')
  if (set.has('\\Draft')) labels.push('DRAFT')
  for (const f of set) {
    if (f.startsWith('\\')) continue
    labels.push(f === '$Important' ? 'IMPORTANT' : f)
  }
  return labels
}

/** A custom label as an IMAP keyword: spaces become underscores; IMAP special characters are refused. */
export function labelToKeyword(label: string): string {
  const keyword = label.trim().replace(/\s+/g, '_')
  if (!/^[A-Za-z0-9_.\-$&+#]{1,64}$/.test(keyword)) throw new MailboxError(`"${label}" can't be used as a label: use letters, numbers, spaces, - _ . only.`, 'invalid')
  return keyword
}

export interface FlagChanges {
  add: string[]
  remove: string[]
  /** Custom labels (IMAP keywords): only some servers allow them. */
  custom: boolean
}

/** Gmail-style label changes as IMAP flag changes. Removing INBOX (archiving) is a folder move, not a label. */
export function labelChangesToFlags(addLabels: string[] = [], removeLabels: string[] = []): FlagChanges {
  const out: FlagChanges = { add: [], remove: [], custom: false }
  const apply = (label: string, adding: boolean) => {
    const upper = label.trim().toUpperCase()
    const [to, other] = adding ? [out.add, out.remove] : [out.remove, out.add]
    switch (upper) {
      case 'UNREAD':
        other.push('\\Seen') // adding UNREAD removes \Seen
        return
      case 'READ':
        to.push('\\Seen')
        return
      case 'STARRED':
      case 'FLAGGED':
        to.push('\\Flagged')
        return
      case 'IMPORTANT':
        to.push('$Important')
        out.custom = true
        return
      case 'INBOX':
        throw new MailboxError('Mailboxes without Gmail have no INBOX label: to archive or file an email, use email__move_email.', 'unsupported')
      default:
        to.push(labelToKeyword(label))
        out.custom = true
    }
  }
  addLabels.forEach((l) => apply(l, true))
  removeLabels.forEach((l) => apply(l, false))
  return out
}

export interface ParsedQuery {
  search: SearchObject
  /** Folder named with in:<folder>, if any. */
  mailbox?: string
  /** Parts of the query IMAP can't search on, left out. */
  ignored: string[]
}

function parseDate(value: string): Date | null {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return Number.isNaN(d.getTime()) ? null : d
}

function relativeDate(value: string, now: Date): Date | null {
  const m = /^(\d+)([dmy])$/i.exec(value)
  if (!m) return null
  const n = Number(m[1])
  const d = new Date(now)
  const unit = m[2].toLowerCase()
  if (unit === 'd') d.setUTCDate(d.getUTCDate() - n)
  else if (unit === 'm') d.setUTCMonth(d.getUTCMonth() - n)
  else d.setUTCFullYear(d.getUTCFullYear() - n)
  return d
}

/**
 * The common Gmail search operators as an IMAP search: is:unread/read/starred, from:, to:, cc:,
 * subject:, label:, in:<folder>, newer_than:/older_than: (d, m, y), after:/before: (YYYY/MM/DD),
 * and plain words (searched anywhere in the message). Anything else is reported as ignored.
 */
export function parseMailQuery(query: string | undefined, now = new Date()): ParsedQuery {
  const search: SearchObject = {}
  const ignored: string[] = []
  const words: string[] = []
  let mailbox: string | undefined
  for (const match of (query ?? '').matchAll(/(-?)(?:([a-z_]+):)?("([^"]*)"|\S+)/gi)) {
    const [whole, negated, op, raw, quoted] = match
    const value = quoted ?? raw
    if (negated || value.toUpperCase() === 'OR' || value.toUpperCase() === 'AND') {
      ignored.push(whole)
      continue
    }
    switch (op?.toLowerCase()) {
      case undefined:
        words.push(value)
        break
      case 'is':
        if (/^unread$/i.test(value)) search.seen = false
        else if (/^read$/i.test(value)) search.seen = true
        else if (/^(starred|flagged)$/i.test(value)) search.flagged = true
        else if (/^important$/i.test(value)) search.keyword = '$Important'
        else ignored.push(whole)
        break
      case 'from':
      case 'to':
      case 'cc':
      case 'subject':
        search[op.toLowerCase() as 'from' | 'to' | 'cc' | 'subject'] = value
        break
      case 'in':
        mailbox = /^inbox$/i.test(value) ? 'INBOX' : value
        break
      case 'label':
        if (/^unread$/i.test(value)) search.seen = false
        else if (/^(starred|flagged)$/i.test(value)) search.flagged = true
        else if (/^inbox$/i.test(value)) mailbox = 'INBOX'
        else {
          try {
            search.keyword = labelToKeyword(value)
          } catch {
            ignored.push(whole)
          }
        }
        break
      case 'newer_than':
      case 'older_than': {
        const d = relativeDate(value, now)
        if (!d) ignored.push(whole)
        else if (op.toLowerCase() === 'newer_than') search.since = d
        else search.before = d
        break
      }
      case 'after':
      case 'before': {
        const d = parseDate(value)
        if (!d) ignored.push(whole)
        else if (op.toLowerCase() === 'after') search.since = d
        else search.before = d
        break
      }
      default:
        ignored.push(whole)
    }
  }
  if (words.length) search.text = words.join(' ')
  if (!Object.keys(search).length) search.all = true
  return { search, mailbox, ignored }
}

// ------------------------------------------------------------------------------ connections

const LIMITS = { connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 30_000 }
const MAX_MESSAGE_BYTES = 5_000_000
const MAX_BODY_CHARS = 20_000
const SNIPPET_BYTES = 8_192

export function parseMailboxCredentials(credentials: Record<string, unknown>): MailboxCredentials {
  const parsed = mailboxCredentialsSchema.safeParse(credentials)
  if (!parsed.success) throw new MailboxError('The mailbox connection is incomplete: connect it again on the Integrations page.', 'invalid')
  return parsed.data
}

async function imapOptions(creds: MailboxCredentials, env: Env) {
  const mode = tlsModeFor('imap', creds.imap.port, env)
  if (!mode) throw new MailboxError(`IMAP port ${creds.imap.port} isn't allowed: use 993 (SSL/TLS) or 143 (STARTTLS).`, 'bad_port')
  const { address, servername } = await resolveMailHost(creds.imap.host, env)
  return {
    host: address,
    ...(servername ? { servername } : {}),
    port: creds.imap.port,
    secure: mode === 'implicit',
    // Never log in over an unencrypted connection: STARTTLS is required, not just attempted.
    ...(mode === 'starttls' ? { doSTARTTLS: true } : {}),
    // A local test server has a self-signed certificate.
    ...(localServersAllowed(env) ? { tls: { rejectUnauthorized: false } } : {}),
    auth: { user: creds.username ?? creds.email, pass: creds.password },
    logger: false as const,
    disableAutoIdle: true,
    ...LIMITS,
  }
}

function friendlyError(error: unknown, server: string): MailboxError {
  if (error instanceof MailboxError) return error
  const e = error as { authenticationFailed?: boolean; responseCode?: number; code?: string; message?: string; responseText?: string }
  if (e?.authenticationFailed || e?.code === 'EAUTH' || /AUTHENTICATIONFAILED|Invalid credentials|authentication failed|535/i.test(`${e?.responseText ?? ''} ${e?.message ?? ''}`)) {
    return new MailboxError(`${server} refused the login. Check the address and password; many providers need an app password when two-step sign-in is on.`, 'auth')
  }
  if (e?.code === 'ETIMEDOUT' || e?.code === 'ECONNREFUSED' || e?.code === 'ENOTFOUND' || e?.code === 'ESOCKET' || e?.code === 'ECONNECTION' || /timeout|timed out/i.test(e?.message ?? '')) {
    return new MailboxError(`Couldn't connect to ${server}. Check the server name and port.`, 'connect')
  }
  return new MailboxError(`${server}: ${(e?.responseText || e?.message || 'unknown error').slice(0, 300)}`, 'connect')
}

/** Opens an IMAP connection, runs `fn`, and always logs out. */
export async function withImap<T>(creds: MailboxCredentials, fn: (client: ImapFlow) => Promise<T>, env: Env = process.env): Promise<T> {
  const client = new ImapFlow(await imapOptions(creds, env))
  // A connection error after connect() would otherwise be an unhandled 'error' event.
  client.on('error', () => undefined)
  try {
    await client.connect()
  } catch (error) {
    throw friendlyError(error, creds.imap.host)
  }
  try {
    return await fn(client)
  } finally {
    await client.logout().catch(() => client.close())
  }
}

async function smtpTransport(creds: MailboxCredentials, env: Env) {
  const mode = tlsModeFor('smtp', creds.smtp.port, env)
  if (!mode) throw new MailboxError(`SMTP port ${creds.smtp.port} isn't allowed: use 465 (SSL/TLS) or 587 (STARTTLS).`, 'bad_port')
  const { address, servername } = await resolveMailHost(creds.smtp.host, env)
  return nodemailer.createTransport({
    host: address,
    port: creds.smtp.port,
    secure: mode === 'implicit',
    requireTLS: mode === 'starttls',
    ignoreTLS: false,
    tls: { ...(servername ? { servername } : {}), ...(localServersAllowed(env) ? { rejectUnauthorized: false } : {}) },
    auth: { user: creds.username ?? creds.email, pass: creds.password },
    ...LIMITS,
  })
}

/** Folder with a special use (\Sent, \Drafts, \Archive, \Junk, \Trash), if the server marks one. */
async function specialFolder(client: ImapFlow, use: string): Promise<string | null> {
  const folders = await client.list()
  return folders.find((f) => f.specialUse === use)?.path ?? null
}

function addressList(list: MessageAddressObject[] | undefined): string {
  return (list ?? []).map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : a.address ?? '')).filter(Boolean).join(', ')
}

function parsedAddresses(value: AddressObject | AddressObject[] | undefined): string {
  if (!value) return ''
  return (Array.isArray(value) ? value : [value]).map((v) => v.text).join(', ')
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} more characters not shown]` : text
}

async function summarise(message: FetchMessageObject, mailbox: string) {
  let snippet = ''
  if (message.source) {
    try {
      const parsed = await simpleParser(message.source, { skipHtmlToText: false, skipTextLinks: true })
      snippet = (parsed.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    } catch {
      snippet = ''
    }
  }
  const env = message.envelope
  return {
    id: encodeMessageId(mailbox, message.uid),
    threadId: env?.inReplyTo ?? env?.messageId ?? encodeMessageId(mailbox, message.uid),
    labelIds: flagsToLabels(message.flags ?? [], mailbox),
    snippet,
    from: addressList(env?.from),
    to: addressList(env?.to),
    subject: env?.subject ?? '',
    receivedAt: message.internalDate ? new Date(message.internalDate).toISOString() : env?.date ? new Date(env.date).toISOString() : null,
  }
}

const ADDRESS_FALLBACK_SCAN = 500

/**
 * IMAP says FROM/TO/CC match any part of the header, but some servers only match a whole
 * address (or fail on a name with a space). When an address search finds nothing, the newest
 * messages matching the rest of the search are checked here instead, so "from:maria" finds
 * "Maria Gonzalez <maria@client.example>" everywhere.
 */
async function matchAddressesLocally(client: ImapFlow, search: SearchObject): Promise<number[]> {
  const terms = (['from', 'to', 'cc'] as const).filter((k) => typeof search[k] === 'string' && search[k])
  if (!terms.length) return []
  const rest: SearchObject = { ...search }
  for (const k of terms) delete rest[k]
  if (!Object.keys(rest).length) rest.all = true
  const candidates = (((await client.search(rest, { uid: true })) || []) as number[]).sort((a, b) => b - a).slice(0, ADDRESS_FALLBACK_SCAN)
  if (!candidates.length) return []
  const matched: number[] = []
  for await (const m of client.fetch(candidates, { uid: true, envelope: true }, { uid: true })) {
    const ok = terms.every((k) => addressList(m.envelope?.[k]).toLowerCase().includes(String(search[k]).toLowerCase()))
    if (ok) matched.push(m.uid)
  }
  return matched.sort((a, b) => b - a)
}

/** Newest first, at most `max`, with a snippet of each. */
async function listMessages(client: ImapFlow, mailbox: string, search: SearchObject, max: number) {
  const lock = await client.getMailboxLock(mailbox, { readOnly: true }).catch(() => {
    throw new MailboxError(`There is no folder called "${mailbox}" in this mailbox.`, 'not_found')
  })
  try {
    let uids = ((await client.search(search, { uid: true })) || []).sort((a, b) => b - a)
    if (!uids.length) uids = await matchAddressesLocally(client, search)
    const wanted = uids.slice(0, max)
    const messages = []
    if (wanted.length) {
      for await (const m of client.fetch(wanted, { uid: true, flags: true, envelope: true, internalDate: true, source: { maxLength: SNIPPET_BYTES } }, { uid: true })) {
        messages.push(await summarise(m, mailbox))
      }
    }
    messages.sort((a, b) => Number(b.id.split(':').pop()) - Number(a.id.split(':').pop()))
    return { messages, resultSizeEstimate: uids.length }
  } finally {
    lock.release()
  }
}

interface ComposeInput {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
  bodyHtml?: string
  inReplyTo?: string
  references?: string[]
}

/** The exact message, as sent and as saved in Sent/Drafts. */
export async function composeMessage(creds: Pick<MailboxCredentials, 'email' | 'fromName'>, input: ComposeInput): Promise<{ raw: Buffer; messageId: string }> {
  const references = input.references?.length ? input.references : input.inReplyTo ? [input.inReplyTo] : undefined
  const mail = new MailComposer({
    from: creds.fromName ? { name: creds.fromName, address: creds.email } : creds.email,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.body,
    html: input.bodyHtml,
    inReplyTo: input.inReplyTo,
    references,
    // Bcc stays out of the headers (also in the saved copy); recipients come from the envelope.
  }).compile()
  const raw = await mail.build()
  return { raw, messageId: mail.messageId() }
}

// ------------------------------------------------------------------------------ the adapter

const addresses = z.array(z.string().email()).min(1).max(50)
/** "<folder>:<uid>" ids. */
const emailId = z.string().min(1).max(500)

export class EmailAdapter extends BaseIntegrationAdapter {
  readonly provider = 'imap'
  readonly name = EMAIL_INTEGRATION_NAME
  readonly description = 'Read, file and send email in any mailbox over IMAP and SMTP'

  constructor(private readonly env: Env = process.env) {
    super('imap', EMAIL_INTEGRATION_NAME, 'Read, file and send email in any mailbox over IMAP and SMTP', ['imap', 'smtp'])
    this.registerActions()
  }

  private registerActions(): void {
    this.registerAction({
      name: 'list_emails',
      description: 'List emails, newest first. query takes Gmail-style search terms (e.g. "is:unread", "from:maria subject:proposal", "newer_than:7d"); mailbox is the folder (default INBOX).',
      inputSchema: z.object({
        query: z.string().max(500).optional(),
        maxResults: z.number().int().min(1).max(50).default(10),
        mailbox: z.string().min(1).max(200).optional(),
        labelIds: z.array(z.string()).optional(),
      }),
      outputSchema: z.object({ messages: z.array(z.object({ id: z.string(), threadId: z.string(), labelIds: z.array(z.string()), snippet: z.string() }).passthrough()), resultSizeEstimate: z.number() }).passthrough(),
      execute: async (input, credentials) => {
        const { query, maxResults, mailbox, labelIds } = input as { query?: string; maxResults: number; mailbox?: string; labelIds?: string[] }
        const parsed = parseMailQuery(query)
        for (const label of labelIds ?? []) {
          if (/^unread$/i.test(label)) parsed.search.seen = false
          else if (/^inbox$/i.test(label)) parsed.mailbox ??= 'INBOX'
          else if (/^starred$/i.test(label)) parsed.search.flagged = true
          else parsed.search.keyword = labelToKeyword(label)
          delete parsed.search.all
        }
        const folder = mailbox ?? parsed.mailbox ?? 'INBOX'
        const result = await this.imap(credentials, (client) => listMessages(client, folder, parsed.search, maxResults))
        return { ...result, mailbox: folder, ...(parsed.ignored.length ? { ignoredSearchTerms: parsed.ignored } : {}) }
      },
    })

    this.registerAction({
      name: 'search_emails',
      description: 'Search emails with Gmail-style terms (from:, to:, subject:, is:unread, label:, in:<folder>, newer_than:, after:/before:, plain words). Searches the inbox unless in:<folder> is given.',
      inputSchema: z.object({ query: z.string().min(1).max(500), maxResults: z.number().int().min(1).max(50).default(20) }),
      outputSchema: z.object({ messages: z.array(z.object({ id: z.string(), threadId: z.string() }).passthrough()), resultSizeEstimate: z.number() }).passthrough(),
      execute: async (input, credentials) => {
        const { query, maxResults } = input as { query: string; maxResults: number }
        const parsed = parseMailQuery(query)
        const folder = parsed.mailbox ?? 'INBOX'
        const result = await this.imap(credentials, (client) => listMessages(client, folder, parsed.search, maxResults))
        return { ...result, mailbox: folder, ...(parsed.ignored.length ? { ignoredSearchTerms: parsed.ignored } : {}) }
      },
    })

    this.registerAction({
      name: 'get_email',
      description: 'Read one email in full by its id (e.g. "INBOX:4521"). Reading does not mark it as read.',
      inputSchema: z.object({ id: emailId, format: z.enum(['full', 'metadata', 'minimal', 'raw']).default('full') }),
      outputSchema: z.object({ id: z.string(), threadId: z.string(), labelIds: z.array(z.string()), snippet: z.string() }).passthrough(),
      execute: async (input, credentials) => {
        const { id, format } = input as { id: string; format: string }
        const { mailbox, uid } = decodeMessageId(id)
        return this.imap(credentials, async (client) => {
          const lock = await client.getMailboxLock(mailbox, { readOnly: true }).catch(() => {
            throw new MailboxError(`There is no folder called "${mailbox}" in this mailbox.`, 'not_found')
          })
          try {
            const message = await client.fetchOne(String(uid), { uid: true, flags: true, envelope: true, internalDate: true, size: true, source: format === 'minimal' || format === 'metadata' ? { maxLength: SNIPPET_BYTES } : { maxLength: MAX_MESSAGE_BYTES } }, { uid: true })
            if (!message) throw new MailboxError(`Email ${id} wasn't found (it may have been moved or deleted).`, 'not_found')
            const parsed = await simpleParser(message.source ?? Buffer.alloc(0), { skipTextLinks: true })
            const body = (parsed.text ?? '').trim()
            const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []
            return {
              id,
              threadId: references[0] ?? parsed.inReplyTo ?? parsed.messageId ?? id,
              messageId: parsed.messageId ?? null,
              inReplyTo: parsed.inReplyTo ?? null,
              references,
              labelIds: flagsToLabels(message.flags ?? [], mailbox),
              from: parsedAddresses(parsed.from),
              replyTo: parsedAddresses(parsed.replyTo) || null,
              to: parsedAddresses(parsed.to),
              cc: parsedAddresses(parsed.cc) || null,
              subject: parsed.subject ?? '',
              date: parsed.date?.toISOString() ?? null,
              snippet: body.replace(/\s+/g, ' ').slice(0, 200),
              ...(format === 'minimal' || format === 'metadata' ? {} : { body: clip(body, MAX_BODY_CHARS) }),
              attachments: parsed.attachments.map((a) => ({ filename: a.filename ?? null, contentType: a.contentType, size: a.size })),
              ...((message.size ?? 0) > MAX_MESSAGE_BYTES ? { truncated: true } : {}),
            }
          } finally {
            lock.release()
          }
        })
      },
    })

    this.registerAction({
      name: 'modify_labels',
      description: 'Add or remove labels on an email: UNREAD, STARRED, IMPORTANT, or your own (e.g. "Lead", "Needs reply"). To archive or file it, use move_email.',
      inputSchema: z.object({ id: emailId, addLabelIds: z.array(z.string().min(1)).max(20).optional(), removeLabelIds: z.array(z.string().min(1)).max(20).optional() }),
      outputSchema: z.object({ id: z.string(), threadId: z.string(), labelIds: z.array(z.string()) }).passthrough(),
      execute: async (input, credentials) => {
        const { id, addLabelIds, removeLabelIds } = input as { id: string; addLabelIds?: string[]; removeLabelIds?: string[] }
        const { mailbox, uid } = decodeMessageId(id)
        const changes = labelChangesToFlags(addLabelIds, removeLabelIds)
        return this.imap(credentials, async (client) => {
          const lock = await client.getMailboxLock(mailbox).catch(() => {
            throw new MailboxError(`There is no folder called "${mailbox}" in this mailbox.`, 'not_found')
          })
          try {
            const permanent = client.mailbox ? client.mailbox.permanentFlags : undefined
            if (changes.custom && permanent && !permanent.has('\\*')) {
              throw new MailboxError('This mailbox does not allow custom labels. File the email in a folder with email__move_email instead, or use STARRED.', 'unsupported')
            }
            if (changes.add.length) await client.messageFlagsAdd(String(uid), changes.add, { uid: true })
            if (changes.remove.length) await client.messageFlagsRemove(String(uid), changes.remove, { uid: true })
            const message = await client.fetchOne(String(uid), { uid: true, flags: true, envelope: true }, { uid: true })
            if (!message) throw new MailboxError(`Email ${id} wasn't found (it may have been moved or deleted).`, 'not_found')
            return { id, threadId: message.envelope?.inReplyTo ?? message.envelope?.messageId ?? id, labelIds: flagsToLabels(message.flags ?? [], mailbox) }
          } finally {
            lock.release()
          }
        })
      },
    })

    this.registerAction({
      name: 'move_email',
      description: 'Move an email to another folder, e.g. "Archive" or "Clients/CloudNine". folder "archive", "junk" or "trash" uses the mailbox\'s own folder for that. The email gets a new id in its new folder.',
      inputSchema: z.object({ id: emailId, folder: z.string().min(1).max(200), createFolder: z.boolean().default(false) }),
      outputSchema: z.object({ id: z.string(), folder: z.string() }).passthrough(),
      execute: async (input, credentials) => {
        const { id, folder, createFolder } = input as { id: string; folder: string; createFolder: boolean }
        const { mailbox, uid } = decodeMessageId(id)
        return this.imap(credentials, async (client) => {
          const special = { archive: '\\Archive', junk: '\\Junk', spam: '\\Junk', trash: '\\Trash' }[folder.trim().toLowerCase()]
          const folders = await client.list()
          let target = special ? folders.find((f) => f.specialUse === special)?.path : folders.find((f) => f.path === folder || f.path.toLowerCase() === folder.toLowerCase())?.path
          if (!target) {
            if (!createFolder || special) throw new MailboxError(`There is no folder "${folder}". Folders: ${folders.map((f) => f.path).join(', ')}.`, 'not_found')
            await client.mailboxCreate(folder)
            target = folder
          }
          const lock = await client.getMailboxLock(mailbox)
          try {
            const moved = await client.messageMove(String(uid), target, { uid: true })
            if (!moved) throw new MailboxError(`Email ${id} wasn't found (it may have been moved or deleted).`, 'not_found')
            const newUid = moved.uidMap?.get(uid)
            return { id: newUid ? encodeMessageId(target, newUid) : null, folder: target, previousId: id }
          } finally {
            lock.release()
          }
        })
      },
    })

    this.registerAction({
      name: 'list_folders',
      description: 'List the mailbox\'s folders, with which one is Sent, Drafts, Archive, Junk and Trash.',
      inputSchema: z.object({}),
      outputSchema: z.object({ folders: z.array(z.object({ path: z.string() }).passthrough()) }),
      execute: async (_input, credentials) => this.imap(credentials, async (client) => ({ folders: (await client.list()).map((f) => ({ path: f.path, name: f.name, specialUse: f.specialUse?.replace('\\', '') ?? null })) })),
    })

    this.registerAction({
      name: 'send_email',
      description: 'Send an email from the connected mailbox. To reply, pass the original\'s messageId as inReplyTo (and its references) so it joins the same conversation.',
      inputSchema: z.object({
        to: addresses,
        cc: z.array(z.string().email()).max(50).optional(),
        bcc: z.array(z.string().email()).max(50).optional(),
        subject: subjectValue,
        body: z.string().max(200_000),
        bodyHtml: z.string().max(500_000).optional(),
        /** Accepted for compatibility with gmail__send_email; threading uses inReplyTo. */
        threadId: z.string().optional(),
        /** Message-ID of the email being replied to, e.g. "<abc@mail.example.com>". */
        inReplyTo: headerValue.optional(),
        references: z.array(headerValue).max(50).optional(),
      }),
      outputSchema: z.object({ id: z.string(), threadId: z.string(), labelIds: z.array(z.string()) }).passthrough(),
      execute: async (input, credentials) => {
        const creds = parseMailboxCredentials(credentials)
        const mail = input as ComposeInput & { threadId?: string }
        const { raw, messageId: sentId } = await composeMessage(creds, mail)
        const transport = await smtpTransport(creds, this.env)
        let info: { accepted: unknown[]; rejected: unknown[] }
        try {
          info = await transport.sendMail({ envelope: { from: creds.email, to: [...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])] }, raw })
        } catch (error) {
          throw friendlyError(error, creds.smtp.host)
        } finally {
          transport.close()
        }
        // The email has gone; failing to file a copy must not make the agent think it didn't.
        let savedToSent: boolean | string = false
        if (creds.saveSentCopy) {
          try {
            savedToSent = await withImap(creds, async (client) => {
              const sent = await specialFolder(client, '\\Sent')
              if (!sent) return 'no Sent folder found'
              await client.append(sent, raw, ['\\Seen'])
              return true
            }, this.env)
          } catch (error) {
            savedToSent = `not saved: ${friendlyError(error, creds.imap.host).message}`
          }
        }
        const references = mail.references?.length ? mail.references : mail.inReplyTo ? [mail.inReplyTo] : []
        return { id: sentId, messageId: sentId, threadId: references[0] ?? sentId, labelIds: ['SENT'], accepted: info.accepted.map(String), rejected: info.rejected.map(String), savedToSent }
      },
    })

    this.registerAction({
      name: 'create_draft',
      description: 'Save an email as a draft in the mailbox\'s Drafts folder, without sending it.',
      inputSchema: z.object({
        to: addresses,
        cc: z.array(z.string().email()).max(50).optional(),
        bcc: z.array(z.string().email()).max(50).optional(),
        subject: subjectValue,
        body: z.string().max(200_000),
        bodyHtml: z.string().max(500_000).optional(),
        inReplyTo: headerValue.optional(),
        references: z.array(headerValue).max(50).optional(),
      }),
      outputSchema: z.object({ id: z.string(), message: z.object({ id: z.string(), threadId: z.string() }) }).passthrough(),
      execute: async (input, credentials) => {
        const creds = parseMailboxCredentials(credentials)
        const { raw, messageId: draftId } = await composeMessage(creds, input as ComposeInput)
        return withImap(creds, async (client) => {
          const drafts = await specialFolder(client, '\\Drafts')
          if (!drafts) throw new MailboxError('This mailbox has no Drafts folder.', 'not_found')
          const appended = await client.append(drafts, raw, ['\\Draft', '\\Seen'])
          const id = appended && appended.uid ? encodeMessageId(drafts, appended.uid) : draftId
          return { id, message: { id, threadId: draftId }, folder: drafts }
        }, this.env)
      },
    })
  }

  /** Every IMAP action: parse the stored credentials, connect, run, log out. */
  private imap<T>(credentials: Record<string, unknown>, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    return withImap(parseMailboxCredentials(credentials), fn, this.env)
  }

  async validateCredentials(credentials: Record<string, unknown>): Promise<boolean> {
    return (await testMailbox(parseMailboxCredentials(credentials), this.env)).ok
  }
}

export interface MailboxTestResult {
  ok: boolean
  imap: { ok: boolean; error?: string; folders?: { sent: string | null; drafts: string | null; archive: string | null }; customLabels?: boolean | null }
  smtp: { ok: boolean; error?: string }
}

/** Logs in to IMAP and SMTP (sending nothing) and reports what works, in plain words. */
export async function testMailbox(creds: MailboxCredentials, env: Env = process.env): Promise<MailboxTestResult> {
  const imap: MailboxTestResult['imap'] = { ok: false }
  const smtp: MailboxTestResult['smtp'] = { ok: false }
  await Promise.all([
    withImap(creds, async (client) => {
      const folders = await client.list()
      const find = (use: string) => folders.find((f) => f.specialUse === use)?.path ?? null
      const inbox = await client.mailboxOpen('INBOX', { readOnly: true })
      imap.ok = true
      imap.folders = { sent: find('\\Sent'), drafts: find('\\Drafts'), archive: find('\\Archive') }
      imap.customLabels = inbox.permanentFlags ? inbox.permanentFlags.has('\\*') : null
    }, env).catch((error) => {
      imap.error = friendlyError(error, creds.imap.host).message
    }),
    (async () => {
      const transport = await smtpTransport(creds, env)
      try {
        await transport.verify()
        smtp.ok = true
      } finally {
        transport.close()
      }
    })().catch((error) => {
      smtp.error = friendlyError(error, creds.smtp.host).message
    }),
  ])
  return { ok: imap.ok && smtp.ok, imap, smtp }
}

export const emailAdapter = new EmailAdapter()
