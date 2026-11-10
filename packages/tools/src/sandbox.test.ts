import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sandboxExecute } from './sandbox'

type Slots = { slots: Array<{ start: string; end: string }> }

test('sandbox free time is in business hours in Sydney time, after the requested start', () => {
  // Friday 16 Oct 2026, 15:00 in Sydney: the next business days are Mon 19 and Tue 20.
  const out = sandboxExecute('google-calendar__find_free_time', { timeMin: '2026-10-16T15:00:00+11:00', timeMax: '2026-10-23T17:30:00+11:00' }) as Slots
  assert.deepEqual(out.slots.map((s) => s.start), ['2026-10-19T10:00:00+11:00', '2026-10-19T14:00:00+11:00', '2026-10-20T09:30:00+11:00'])
})

test('without a requested window, times are given in Sydney time whatever the server time zone', () => {
  const out = sandboxExecute('google-calendar__find_free_time', {}) as Slots
  for (const slot of out.slots) assert.match(slot.start, /T(10:00|14:00|09:30):00\+1[01]:00$/)
  const events = sandboxExecute('google-calendar__list_events', { timeMin: '2026-10-16T15:00:00Z' }) as { events: Array<{ start: string }> }
  // 15:00 UTC Friday is 02:00 Saturday in Sydney: the next working day, in Sydney time.
  assert.equal(events.events[0].start, '2026-10-19T09:00:00+11:00')
})

test('a window starting before the working day includes that day; a time without an offset is Sydney time', () => {
  const out = sandboxExecute('google-calendar__find_free_time', { timeMin: '2026-10-27T00:00:00+11:00' }) as Slots
  assert.equal(out.slots[0].start, '2026-10-27T10:00:00+11:00')
  const local = sandboxExecute('google-calendar__find_free_time', { timeMin: '2026-10-27T08:00:00' }) as Slots
  assert.equal(local.slots[0].start, '2026-10-27T10:00:00+11:00')
  const utc = sandboxExecute('google-calendar__find_free_time', { timeMin: '2026-10-26T13:00:00Z' }) as Slots
  assert.equal(utc.slots[0].start, '2026-10-27T10:00:00+11:00', 'midnight Sydney given in UTC')
})

test('free time on a named day: slots on that day, only inside the window, sized to the meeting', () => {
  // Tuesday 3 Nov 2026, 9am to 5pm Sydney: the day itself, not the days after it.
  const day = sandboxExecute('google-calendar__find_free_time', { timeMin: '2026-11-03T09:00:00+11:00', timeMax: '2026-11-03T17:00:00+11:00', durationMinutes: 30 }) as Slots
  assert.deepEqual(day.slots, [{ start: '2026-11-03T10:00:00+11:00', end: '2026-11-03T10:30:00+11:00' }, { start: '2026-11-03T14:00:00+11:00', end: '2026-11-03T14:30:00+11:00' }])
  // Nothing in the window (4:45pm to 5:15pm): no slots rather than slots on other days.
  const late = sandboxExecute('google-calendar__find_free_time', { timeMin: '2026-11-03T16:45:00+11:00', timeMax: '2026-11-03T17:15:00+11:00', durationMinutes: 30 }) as Slots
  assert.deepEqual(late.slots, [])
})

test('a sandbox IMAP mailbox shows the same fictional inbox as sandbox Gmail, and changes nothing', () => {
  const inbox = sandboxExecute('email__list_emails', { query: 'is:unread' }) as { messages: Array<{ subject: string }> }
  assert.deepEqual(inbox.messages.map((m) => m.subject), (sandboxExecute('gmail__list_emails', { query: 'is:unread' }) as typeof inbox).messages.map((m) => m.subject))
  assert.match(String((sandboxExecute('email__move_email', { id: 'INBOX:1', folder: 'archive' }) as { result: string }).result), /would have been moved/)
  assert.ok((sandboxExecute('email__list_folders', {}) as { folders: unknown[] }).folders.length > 0)
})
