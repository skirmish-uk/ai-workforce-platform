import { createHash } from 'node:crypto'
import { getToolRiskProfile } from './risk'

/**
 * Sandbox connections (Integration.config.sandbox = true): tools run against a small
 * fictional dataset instead of the real service. Look-ups return realistic data; actions
 * report what *would* have happened and change nothing. Used for demos and for trying
 * agents before a customer connects real accounts. Every result says it came from the
 * sandbox, and the run records it as "simulated", never as done.
 *
 * All people, companies and messages below are fictional.
 */

const CONTACTS = [
  { id: '901', properties: { firstname: 'Priya', lastname: 'Shah', email: 'priya@harbourdental.example', company: 'Harbour Dental', phone: '+61 2 5550 0101', lifecyclestage: 'lead', hs_lead_status: 'NEW', notes_last_contacted: '' } },
  { id: '902', properties: { firstname: 'Tom', lastname: 'Lee', email: 'tom.lee@brightstack.example', company: 'BrightStack Software', phone: '+61 3 5550 0202', lifecyclestage: 'lead', hs_lead_status: 'IN_PROGRESS', numemployees: '120', notes_last_contacted: daysAgo(2) } },
  { id: '903', properties: { firstname: 'Maria', lastname: 'Gonzalez', email: 'maria@cloudnine-analytics.example', company: 'CloudNine Analytics', phone: '+61 2 5550 0303', lifecyclestage: 'marketingqualifiedlead', hs_lead_status: 'OPEN', numemployees: '340', notes_last_contacted: daysAgo(12) } },
  { id: '904', properties: { firstname: 'James', lastname: 'Okafor', email: 'james@okafor-plumbing.example', company: 'Okafor Plumbing', phone: '+61 7 5550 0404', lifecyclestage: 'lead', hs_lead_status: 'NEW', numemployees: '6', notes_last_contacted: '' } },
  // Deliberately messy, so CRM Hygiene (Casey) has something real to find: a duplicate of Tom Lee
  // with a differently spelled company, and a lead with no company, phone or lifecycle stage.
  { id: '905', properties: { firstname: 'Thomas', lastname: 'Lee', email: 'tom.lee@brightstack.example', company: 'Brightstack', phone: '', lifecyclestage: 'lead', hs_lead_status: 'NEW', notes_last_contacted: '' } },
  { id: '906', properties: { firstname: 'Lena', lastname: 'Park', email: 'lena@northwind-logistics.example', company: '', phone: '', lifecyclestage: '', hs_lead_status: 'NEW', notes_last_contacted: '' } },
]

const EMAILS = [
  { id: 'm-101', threadId: 't-101', labelIds: ['INBOX', 'UNREAD'], from: 'Maria Gonzalez <maria@cloudnine-analytics.example>', subject: 'SEO proposal for CloudNine?', snippet: 'Hi, we spoke at the SaaS meetup. Could you send a proposal for SEO and LinkedIn ads? Budget is around $8k a month.', receivedAt: daysAgo(0) },
  { id: 'm-102', threadId: 't-102', labelIds: ['INBOX', 'UNREAD'], from: 'Growth Weekly <news@growthweekly.example>', subject: 'This week in B2B marketing', snippet: 'Five landing page tests that doubled demo bookings, plus our pick of the week…', receivedAt: daysAgo(1) },
  { id: 'm-103', threadId: 't-103', labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'], from: 'Sam Patel <sam@lexpartners.example>', subject: 'URGENT: contract renewal terms', snippet: 'Our legal team needs the revised liability clause before Friday or we cannot renew. Please call me.', receivedAt: daysAgo(0) },
  { id: 'm-104', threadId: 't-104', labelIds: ['INBOX'], from: 'Tom Lee <tom.lee@brightstack.example>', subject: 'Re: Your SEO audit', snippet: 'Thanks for the audit. Can we talk next week about the content plan?', receivedAt: daysAgo(2) },
]

const FILES = [
  { id: 'f-201', name: 'Case study - BrightStack SEO.pdf', mimeType: 'application/pdf', modifiedTime: daysAgo(30) },
  { id: 'f-202', name: 'Proposal template 2026.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', modifiedTime: daysAgo(60) },
]

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

/** The demo tenant's time zone: sandbox calendar times are given in it unless the request names an offset. */
const SANDBOX_TIME_ZONE = 'Australia/Sydney'

/** "+11:00" for an ISO time with an offset ("Z" -> "+00:00"); null when it has none. */
function offsetOf(iso: string): string | null {
  const m = /([+-]\d{2}:\d{2}|Z)$/.exec(iso.trim())
  return m ? (m[1] === 'Z' ? '+00:00' : m[1]) : null
}

function zoneOffset(timeZone: string, at: Date): string {
  const name = new Intl.DateTimeFormat('en-AU', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  const m = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(name)
  if (!m) return '+00:00'
  const sign = m[1].startsWith('-') ? '-' : '+'
  return `${sign}${String(Math.abs(Number(m[1]))).padStart(2, '0')}:${m[2] ?? '00'}`
}

function offsetMinutes(offset: string): number {
  const sign = offset.startsWith('-') ? -1 : 1
  const [h, m] = offset.slice(1).split(':').map(Number)
  return sign * (h * 60 + m)
}

/**
 * The calendar as a business sees it: wall-clock days and times in the business's own time zone
 * (Sydney), so "10am" means 10am where the business is, whatever offset the request or the server
 * uses. A request with no offset is read as Sydney time. Starts from the request's timeMin when
 * given (that day too, if it starts before 9am), otherwise from tomorrow.
 */
class SandboxCalendar {
  readonly offset: string
  private readonly start: Date
  private readonly includeStartDay: boolean
  constructor(timeMin?: string) {
    const local = timeMin && !offsetOf(timeMin) ? `${timeMin}${zoneOffset(SANDBOX_TIME_ZONE, new Date(`${timeMin}Z`))}` : timeMin
    const parsed = local ? new Date(local) : null
    const valid = parsed !== null && !Number.isNaN(parsed.getTime())
    this.start = valid ? parsed : new Date()
    this.offset = zoneOffset(SANDBOX_TIME_ZONE, this.start)
    // The start day itself only when the request starts before the working day does.
    this.includeStartDay = valid && new Date(this.start.getTime() + offsetMinutes(this.offset) * 60_000).getUTCHours() < 9
  }
  /** Business days (Mon–Fri) from the start date, as local calendar dates. */
  businessDays(count: number, includeStartDay = this.includeStartDay): Array<{ y: number; m: number; d: number }> {
    const local = new Date(this.start.getTime() + offsetMinutes(this.offset) * 60_000)
    const days: Array<{ y: number; m: number; d: number }> = []
    const cursor = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()))
    if (includeStartDay) cursor.setUTCDate(cursor.getUTCDate() - 1)
    while (days.length < count) {
      cursor.setUTCDate(cursor.getUTCDate() + 1)
      const dow = cursor.getUTCDay()
      if (dow !== 0 && dow !== 6) days.push({ y: cursor.getUTCFullYear(), m: cursor.getUTCMonth() + 1, d: cursor.getUTCDate() })
    }
    return days
  }
  /** A time given like timeMin (no offset = Sydney time), as epoch ms; null if missing or invalid. */
  static parse(iso: string): number | null {
    if (!iso) return null
    const t = new Date(offsetOf(iso) ? iso : `${iso}${zoneOffset(SANDBOX_TIME_ZONE, new Date(`${iso}Z`))}`).getTime()
    return Number.isNaN(t) ? null : t
  }
  get startMs(): number {
    return this.start.getTime()
  }
  at(day: { y: number; m: number; d: number }, hour: number, minute = 0): string {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${day.y}-${p(day.m)}-${p(day.d)}T${p(hour)}:${p(minute)}:00${this.offset}`
  }
}

function matches(haystack: Record<string, unknown>, query: string): boolean {
  const q = query.toLowerCase().trim()
  if (!q) return true
  const text = JSON.stringify(haystack).toLowerCase()
  return q.split(/\s+/).every((word) => text.includes(word.replace(/^(from|subject|is):/, '')))
}

const SANDBOX_NOTE = 'Sandbox connection: fictional demo data. Nothing real was read, sent or changed.'

function simulatedWrite(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const id = `sbx_${createHash('sha256').update(toolName + JSON.stringify(input)).digest('hex').slice(0, 10)}`
  const what: Record<string, string> = {
    email__send_email: 'The email would have been sent.',
    email__create_draft: 'A draft would have been created.',
    email__modify_labels: 'The labels would have been changed.',
    gmail__send_email: 'The email would have been sent.',
    gmail__create_draft: 'A draft would have been created.',
    gmail__modify_labels: 'The labels would have been changed.',
    email__move_email: 'The email would have been moved.',
    'google-calendar__create_event': 'The event would have been created and invitations sent.',
    'google-calendar__update_event': 'The event would have been updated and attendees notified.',
    'google-calendar__delete_event': 'The event would have been deleted.',
    'hubspot-crm__create_contact': 'The contact would have been created.',
    'hubspot-crm__update_contact': 'The contact would have been updated.',
    'hubspot-crm__create_deal': 'The deal would have been created.',
    'hubspot-crm__create_company': 'The company would have been created.',
  }
  return { sandbox: true, id, ...(toolName === 'gmail__send_email' || toolName === 'email__send_email' ? { threadId: `t-${id}` } : {}), result: what[toolName] ?? 'The action would have run.', note: SANDBOX_NOTE }
}

/** Executes a tool against the sandbox dataset. `input` has already been validated. */
export function sandboxExecute(toolName: string, input: unknown): Record<string, unknown> {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')

  if (getToolRiskProfile(toolName).risk !== 'read') return simulatedWrite(toolName, args)

  // A sandbox mailbox over IMAP shows the same sample inbox as sandbox Gmail.
  switch (toolName === 'email__list_folders' ? toolName : toolName.replace(/^email__/, 'gmail__')) {
    case 'email__list_folders':
      return { sandbox: true, folders: ['INBOX', 'Sent', 'Drafts', 'Archive', 'Junk', 'Trash'].map((path) => ({ path, name: path, specialUse: path === 'INBOX' ? null : path })), note: SANDBOX_NOTE }
    case 'hubspot-crm__search_contacts': {
      const filters = Array.isArray(args.filters) ? (args.filters as Array<{ propertyName: string; value: string }>) : []
      const results = CONTACTS.filter((c) =>
        filters.length
          ? filters.every((f) => String((c.properties as Record<string, string>)[f.propertyName] ?? '').toLowerCase() === String(f.value).toLowerCase())
          : matches(c.properties, str(args.query))
      )
      return { sandbox: true, results, total: results.length, note: SANDBOX_NOTE }
    }
    case 'hubspot-crm__get_contact': {
      const contact = CONTACTS.find((c) => c.id === str(args.id) || c.id === str(args.contactId))
      return contact ? { sandbox: true, ...contact, note: SANDBOX_NOTE } : { sandbox: true, error: 'Contact not found', note: SANDBOX_NOTE }
    }
    case 'hubspot-crm__get_deal':
      return { sandbox: true, id: str(args.id) || '701', properties: { dealname: 'BrightStack - SEO retainer', amount: '7500', dealstage: 'presentationscheduled' }, note: SANDBOX_NOTE }
    case 'gmail__list_emails':
    case 'gmail__search_emails': {
      const query = str(args.query)
      const unreadOnly = /is:unread/.test(query)
      const messages = EMAILS.filter((m) => (!unreadOnly || m.labelIds.includes('UNREAD')) && matches(m, query.replace(/is:unread/g, '')))
      return { sandbox: true, messages, resultSizeEstimate: messages.length, note: SANDBOX_NOTE }
    }
    case 'gmail__get_email': {
      const message = EMAILS.find((m) => m.id === str(args.id) || m.id === str(args.messageId))
      return message ? { sandbox: true, ...message, body: message.snippet, note: SANDBOX_NOTE } : { sandbox: true, error: 'Message not found', note: SANDBOX_NOTE }
    }
    case 'google-calendar__find_free_time': {
      // The same sample diary every week (10:00 and 14:00 free on the first day with room, then
      // 9:30 and 14:00), from the requested day on and only inside the requested window, so
      // "Tuesday at 10am" finds Tuesday's slots rather than the days after it.
      const cal = new SandboxCalendar(str(args.timeMin))
      const minutes = typeof args.durationMinutes === 'number' && args.durationMinutes > 0 ? args.durationMinutes : 60
      const max = SandboxCalendar.parse(str(args.timeMax)) ?? cal.startMs + 14 * 86_400_000
      const slots: Array<{ start: string; end: string }> = []
      for (const day of cal.businessDays(15, true)) {
        const times = slots.length ? [[9, 30], [14, 0]] : [[10, 0], [14, 0]]
        for (const [h, m] of times) {
          const start = cal.at(day, h, m)
          const t = new Date(start).getTime()
          if (t < cal.startMs || t + minutes * 60_000 > max) continue
          const endMinute = h * 60 + m + minutes
          slots.push({ start, end: cal.at(day, Math.floor(endMinute / 60), endMinute % 60) })
        }
        if (slots.length >= 3) break
      }
      return { sandbox: true, slots: slots.slice(0, 3), note: SANDBOX_NOTE }
    }
    case 'google-calendar__list_events': {
      const cal = new SandboxCalendar(str(args.timeMin))
      const [first] = cal.businessDays(1)
      return { sandbox: true, events: [{ id: 'e-301', summary: 'Team stand-up', start: cal.at(first, 9), end: cal.at(first, 9, 30) }, { id: 'e-302', summary: 'BrightStack content review', start: cal.at(first, 11, 30), end: cal.at(first, 12, 30) }], note: SANDBOX_NOTE }
    }
    case 'google-calendar__get_event':
      return { sandbox: true, id: str(args.eventId) || 'e-302', summary: 'BrightStack content review', note: SANDBOX_NOTE }
    case 'google-drive__list_files':
    case 'google-drive__search_files':
      return { sandbox: true, files: FILES.filter((f) => matches(f, str(args.query))), note: SANDBOX_NOTE }
    case 'google-drive__get_file':
    case 'google-drive__download_file':
      return { sandbox: true, ...(FILES.find((f) => f.id === str(args.fileId)) ?? FILES[0]), content: '(sandbox file contents)', note: SANDBOX_NOTE }
    default:
      return { sandbox: true, note: `${SANDBOX_NOTE} No sample data for ${toolName}.` }
  }
}
