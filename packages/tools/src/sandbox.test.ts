import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sandboxExecute } from './sandbox'

type Slots = { slots: Array<{ start: string; end: string }> }

test('sandbox free time is in business hours in the requested offset, after the requested start', () => {
  // Friday 16 Oct 2026, 15:00 in Sydney: the next business days are Mon 19 and Tue 20.
  const out = sandboxExecute('google-calendar__find_free_time', { timeMin: '2026-10-16T15:00:00+11:00', timeMax: '2026-10-23T17:30:00+11:00' }) as Slots
  assert.deepEqual(out.slots.map((s) => s.start), ['2026-10-19T10:00:00+11:00', '2026-10-19T14:00:00+11:00', '2026-10-20T09:30:00+11:00'])
})

test('without a requested window, times are given in Sydney time whatever the server time zone', () => {
  const out = sandboxExecute('google-calendar__find_free_time', {}) as Slots
  for (const slot of out.slots) assert.match(slot.start, /T(10:00|14:00|09:30):00\+1[01]:00$/)
  const events = sandboxExecute('google-calendar__list_events', { timeMin: '2026-10-16T15:00:00Z' }) as { events: Array<{ start: string }> }
  assert.equal(events.events[0].start, '2026-10-19T09:00:00+00:00')
})
