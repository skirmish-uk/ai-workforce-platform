/* eslint-disable @typescript-eslint/no-explicit-any -- stubs mirror loosely typed googleapis request/response payloads */
import { afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { google } from 'googleapis'
import { gmailAdapter, calendarAdapter } from './index'

/**
 * Adapter-level tests for the email / availability / reminder capabilities.
 * The real adapter code runs; only the googleapis client factory is stubbed, so
 * nothing is sent to Google and no credentials are needed.
 */

const CREDS = { accessToken: 'test-access-token', refreshToken: 'test-refresh-token' }

function action(adapter: typeof gmailAdapter | typeof calendarAdapter, name: string) {
  const found = adapter.actions.find((a) => a.name === name)
  if (!found) throw new Error(`no action ${name}`)
  return found
}

async function run(adapter: typeof gmailAdapter | typeof calendarAdapter, name: string, input: unknown) {
  const a = action(adapter, name)
  return a.execute(a.inputSchema.parse(input), CREDS)
}

function decodeRaw(raw: string): string {
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

function headersOf(mime: string): Record<string, string> {
  const head = mime.split(/\r?\n\r?\n/)[0]
  const out: Record<string, string> = {}
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return out
}

function stubGmail(overrides: Record<string, (params: any) => unknown> = {}) {
  const calls: Array<{ method: string; params: any }> = []
  const wrap = (method: string, fallback: (p: any) => unknown) => async (params: any) => {
    calls.push({ method, params })
    return { data: (overrides[method] ?? fallback)(params) }
  }
  const client = {
    users: {
      messages: {
        send: wrap('send', (p) => ({ id: 'sent-1', threadId: p.requestBody.threadId ?? 'thread-new', labelIds: ['SENT'] })),
        list: wrap('list', () => ({ messages: [] })),
        get: wrap('get', () => ({})),
      },
    },
  }
  mock.method(google as unknown as Record<string, () => unknown>, 'gmail', () => client)
  return calls
}

function stubCalendar(overrides: Record<string, (params: any) => unknown> = {}) {
  const calls: Array<{ method: string; params: any }> = []
  const wrap = (method: string, fallback: (p: any) => unknown) => async (params: any) => {
    calls.push({ method, params })
    return { data: (overrides[method] ?? fallback)(params) }
  }
  const client = {
    events: {
      insert: wrap('insert', (p) => ({ id: 'evt-1', htmlLink: 'https://calendar.google.com/evt-1', summary: p.requestBody.summary, start: p.requestBody.start, end: p.requestBody.end, ...p.requestBody })),
    },
    freebusy: { query: wrap('freebusy', () => ({ calendars: { primary: { busy: [] } } })) },
  }
  mock.method(google as unknown as Record<string, () => unknown>, 'calendar', () => client)
  return calls
}

afterEach(() => mock.restoreAll())

describe('send email', () => {
  test('builds a valid MIME message and sends it as the connected account', async () => {
    const calls = stubGmail()
    const out = await run(gmailAdapter, 'send_email', {
      to: ['ann@example.com', 'bob@example.com'],
      cc: ['sales@example.com'],
      subject: 'Following up on our call',
      body: 'Hi Ann,\n\nThanks for your time today.',
    })
    assert.deepEqual(out, { id: 'sent-1', threadId: 'thread-new', labelIds: ['SENT'] })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].params.userId, 'me')
    assert.match(calls[0].params.requestBody.raw, /^[A-Za-z0-9_-]+$/, 'raw must be base64url without padding')

    const mime = decodeRaw(calls[0].params.requestBody.raw)
    const h = headersOf(mime)
    assert.equal(h.to, 'ann@example.com, bob@example.com')
    assert.equal(h.cc, 'sales@example.com')
    assert.equal(h.subject, 'Following up on our call')
    assert.equal(h['mime-version'], '1.0')
    assert.match(h['content-type'], /text\/plain; charset="UTF-8"/)
    assert.ok(mime.endsWith('Hi Ann,\n\nThanks for your time today.'))
  })

  test('rejects invalid recipients before anything is sent', async () => {
    const calls = stubGmail()
    const a = action(gmailAdapter, 'send_email')
    assert.equal(a.inputSchema.safeParse({ to: ['not-an-email'], subject: 's', body: 'b' }).success, false)
    assert.equal(a.inputSchema.safeParse({ to: 'ann@example.com', subject: 's', body: 'b' }).success, false, 'to must be an array')
    assert.equal(a.inputSchema.safeParse({ to: ['ann@example.com'], subject: '', body: 'b' }).success, false, 'subject required')
    assert.equal(calls.length, 0)
  })

  test('HTML emails carry a text/plain alternative', async () => {
    const calls = stubGmail()
    await run(gmailAdapter, 'send_email', { to: ['ann@example.com'], subject: 'Hi', body: 'plain', bodyHtml: '<p>html</p>' })
    const mime = decodeRaw(calls[0].params.requestBody.raw)
    assert.match(headersOf(mime)['content-type'], /multipart\/alternative/)
    assert.ok(mime.includes('Content-Type: text/plain') && mime.includes('plain'))
    assert.ok(mime.includes('Content-Type: text/html') && mime.includes('<p>html</p>'))
  })

  test('line breaks in header fields cannot inject extra headers (e.g. a hidden Bcc)', () => {
    const a = action(gmailAdapter, 'send_email')
    const base = { to: ['ann@example.com'], body: 'b' }
    assert.equal(a.inputSchema.safeParse({ ...base, subject: 'Hello\r\nBcc: attacker@evil.example' }).success, false)
    assert.equal(a.inputSchema.safeParse({ ...base, subject: 'Hello\nBcc: attacker@evil.example' }).success, false)
    assert.equal(a.inputSchema.safeParse({ ...base, subject: 'ok', inReplyTo: '<a@b>\r\nBcc: attacker@evil.example' }).success, false)
  })
})

describe('receive email', () => {
  test('lists the inbox with the caller\'s query and fetches a message', async () => {
    const calls = stubGmail({
      list: () => ({ messages: [{ id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], snippet: 'Can we meet Tuesday?' }] }),
      get: (p) => ({ id: p.id, threadId: 't1', labelIds: ['INBOX'], snippet: 'Can we meet Tuesday?', payload: { headers: [{ name: 'Message-ID', value: '<abc@mail.example.com>' }, { name: 'From', value: 'Ann <ann@example.com>' }] } }),
    })
    const listed = (await run(gmailAdapter, 'list_emails', { query: 'is:unread in:inbox', maxResults: 5 })) as { messages: Array<{ id: string }> }
    assert.equal(listed.messages[0].id, 'm1')
    assert.deepEqual({ userId: calls[0].params.userId, q: calls[0].params.q, maxResults: calls[0].params.maxResults }, { userId: 'me', q: 'is:unread in:inbox', maxResults: 5 })

    const msg = (await run(gmailAdapter, 'get_email', { id: 'm1' })) as { threadId: string; payload: unknown }
    assert.equal(calls[1].params.format, 'full', 'defaults to full format so headers and body are available')
    assert.equal(msg.threadId, 't1')
  })
})

describe('reply to email', () => {
  test('reply stays in the original Gmail thread', async () => {
    const calls = stubGmail()
    const out = (await run(gmailAdapter, 'send_email', {
      to: ['ann@example.com'],
      subject: 'Re: Can we meet Tuesday?',
      body: 'Tuesday 10am works.',
      threadId: 't1',
      inReplyTo: '<abc@mail.example.com>',
    })) as { threadId: string }
    assert.equal(calls[0].params.requestBody.threadId, 't1')
    assert.equal(out.threadId, 't1')
  })

  test('reply sets In-Reply-To and References so it threads for the recipient too', async () => {
    const calls = stubGmail()
    await run(gmailAdapter, 'send_email', {
      to: ['ann@example.com'],
      subject: 'Re: Can we meet Tuesday?',
      body: 'Tuesday 10am works.',
      threadId: 't1',
      inReplyTo: '<abc@mail.example.com>',
    })
    const h = headersOf(decodeRaw(calls[0].params.requestBody.raw))
    assert.equal(h['in-reply-to'], '<abc@mail.example.com>')
    assert.equal(h.references, '<abc@mail.example.com>')
  })
})

describe('check availability', () => {
  const day = { timeMin: '2026-10-13T09:00:00.000Z', timeMax: '2026-10-13T17:00:00.000Z' }

  async function freeSlots(busy: Array<{ start: string; end: string }>, durationMinutes = 30) {
    const calls = stubCalendar({ freebusy: () => ({ calendars: { primary: { busy } } }) })
    const out = (await run(calendarAdapter, 'find_free_time', { ...day, durationMinutes })) as { freeSlots: Array<{ start: string; end: string }> }
    return { slots: out.freeSlots, calls }
  }

  test('queries free/busy for the primary calendar over the requested window', async () => {
    const { calls } = await freeSlots([])
    assert.deepEqual(calls[0].params.requestBody, { ...day, items: [{ id: 'primary' }] })
  })

  test('empty calendar → slot at the start of the window', async () => {
    const { slots } = await freeSlots([])
    assert.deepEqual(slots, [{ start: '2026-10-13T09:00:00.000Z', end: '2026-10-13T09:30:00.000Z' }])
  })

  test('finds the gaps between meetings that fit the requested duration', async () => {
    const { slots } = await freeSlots(
      [
        { start: '2026-10-13T09:00:00Z', end: '2026-10-13T10:00:00Z' },
        { start: '2026-10-13T10:15:00Z', end: '2026-10-13T12:00:00Z' }, // 15-min gap before this: too short for 30
        { start: '2026-10-13T13:00:00Z', end: '2026-10-13T17:00:00Z' },
      ],
      30
    )
    assert.deepEqual(slots, [{ start: '2026-10-13T12:00:00.000Z', end: '2026-10-13T12:30:00.000Z' }])
  })

  test('overlapping busy blocks are merged; a fully booked day has no slots', async () => {
    const { slots } = await freeSlots([
      { start: '2026-10-13T09:00:00Z', end: '2026-10-13T13:00:00Z' },
      { start: '2026-10-13T11:00:00Z', end: '2026-10-13T17:00:00Z' },
    ])
    assert.deepEqual(slots, [])
  })

  test('a 60-minute request skips a 45-minute gap', async () => {
    const { slots } = await freeSlots(
      [
        { start: '2026-10-13T09:00:00Z', end: '2026-10-13T10:00:00Z' },
        { start: '2026-10-13T10:45:00Z', end: '2026-10-13T16:00:00Z' },
      ],
      60
    )
    assert.deepEqual(slots, [{ start: '2026-10-13T16:00:00.000Z', end: '2026-10-13T17:00:00.000Z' }])
  })
})

describe('create meeting + reminders', () => {
  test('creates the event with attendees and explicit reminders', async () => {
    const calls = stubCalendar()
    await run(calendarAdapter, 'create_event', {
      summary: 'Intro call with Ann',
      startTime: '2026-10-13T12:00:00.000Z',
      endTime: '2026-10-13T12:30:00.000Z',
      timeZone: 'Australia/Sydney',
      attendees: [{ email: 'ann@example.com', displayName: 'Ann' }],
      reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 1440 }, { method: 'popup', minutes: 15 }] },
    })
    const body = calls[0].params.requestBody
    assert.equal(calls[0].params.calendarId, 'primary')
    assert.deepEqual(body.start, { dateTime: '2026-10-13T12:00:00.000Z', timeZone: 'Australia/Sydney' })
    assert.deepEqual(body.attendees, [{ email: 'ann@example.com', displayName: 'Ann', responseStatus: undefined }])
    assert.deepEqual(body.reminders, { useDefault: false, overrides: [{ method: 'email', minutes: 1440 }, { method: 'popup', minutes: 15 }] })
  })

  test('without explicit reminders the calendar default is used', async () => {
    const calls = stubCalendar()
    await run(calendarAdapter, 'create_event', { summary: 'x', startTime: '2026-10-13T12:00:00.000Z', endTime: '2026-10-13T12:30:00.000Z' })
    assert.deepEqual(calls[0].params.requestBody.reminders, { useDefault: true })
  })

  test('reminder overrides must be positive minutes with a known method', () => {
    const a = action(calendarAdapter, 'create_event')
    const base = { summary: 'x', startTime: '2026-10-13T12:00:00.000Z', endTime: '2026-10-13T12:30:00.000Z' }
    assert.equal(a.inputSchema.safeParse({ ...base, reminders: { overrides: [{ method: 'sms', minutes: 10 }] } }).success, false)
    assert.equal(a.inputSchema.safeParse({ ...base, reminders: { overrides: [{ method: 'email', minutes: 0 }] } }).success, false)
  })
})
