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

function nextBusinessDay(from = new Date()): Date {
  const d = new Date(from)
  d.setDate(d.getDate() + 1)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  return d
}

function at(day: Date, hour: number, minute = 0): string {
  const d = new Date(day)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
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
    gmail__send_email: 'The email would have been sent.',
    gmail__create_draft: 'A draft would have been created.',
    gmail__modify_labels: 'The labels would have been changed.',
    'google-calendar__create_event': 'The event would have been created and invitations sent.',
    'google-calendar__update_event': 'The event would have been updated and attendees notified.',
    'google-calendar__delete_event': 'The event would have been deleted.',
    'hubspot-crm__create_contact': 'The contact would have been created.',
    'hubspot-crm__update_contact': 'The contact would have been updated.',
    'hubspot-crm__create_deal': 'The deal would have been created.',
    'hubspot-crm__create_company': 'The company would have been created.',
  }
  return { sandbox: true, id, ...(toolName === 'gmail__send_email' ? { threadId: `t-${id}` } : {}), result: what[toolName] ?? 'The action would have run.', note: SANDBOX_NOTE }
}

/** Executes a tool against the sandbox dataset. `input` has already been validated. */
export function sandboxExecute(toolName: string, input: unknown): Record<string, unknown> {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')

  if (getToolRiskProfile(toolName).risk !== 'read') return simulatedWrite(toolName, args)

  switch (toolName) {
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
      const day = nextBusinessDay()
      return { sandbox: true, slots: [{ start: at(day, 10), end: at(day, 11) }, { start: at(day, 14), end: at(day, 15) }, { start: at(nextBusinessDay(day), 9, 30), end: at(nextBusinessDay(day), 10, 30) }], note: SANDBOX_NOTE }
    }
    case 'google-calendar__list_events': {
      const day = nextBusinessDay()
      return { sandbox: true, events: [{ id: 'e-301', summary: 'Team stand-up', start: at(day, 9), end: at(day, 9, 30) }, { id: 'e-302', summary: 'BrightStack content review', start: at(day, 11, 30), end: at(day, 12, 30) }], note: SANDBOX_NOTE }
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
