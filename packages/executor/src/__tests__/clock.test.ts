import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatCurrentTime } from '../context'

const NOW = new Date('2026-10-13T03:05:00Z')

test('states the current date and time in the tenant time zone', () => {
  const { text, warning } = formatCurrentTime({ timeZone: 'Australia/Sydney' }, NOW)
  assert.equal(text, 'Tuesday 13 October 2026, 14:05 (Australia/Sydney, UTC+11:00)')
  assert.equal(warning, undefined)
})

test('falls back to UTC when no time zone is set, and warns about an invalid one', () => {
  assert.equal(formatCurrentTime({}, NOW).text, 'Tuesday 13 October 2026, 03:05 (UTC)')
  const invalid = formatCurrentTime({ timeZone: 'Mars/Olympus' }, NOW)
  assert.match(invalid.text, /\(UTC\)$/)
  assert.match(invalid.warning ?? '', /not a valid IANA time zone/)
})
