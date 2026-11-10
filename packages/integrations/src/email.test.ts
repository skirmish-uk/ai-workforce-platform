import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  composeMessage,
  decodeMessageId,
  encodeMessageId,
  flagsToLabels,
  labelChangesToFlags,
  mailboxCredentialsSchema,
  parseMailQuery,
  resolveMailHost,
  tlsModeFor,
} from './email'

const NOW = new Date('2026-10-27T00:00:00Z')

test('Gmail-style searches become IMAP searches', () => {
  assert.deepEqual(parseMailQuery('is:unread', NOW), { search: { seen: false }, mailbox: undefined, ignored: [] })
  assert.deepEqual(parseMailQuery('from:maria subject:"SEO proposal" is:starred', NOW).search, { from: 'maria', subject: 'SEO proposal', flagged: true })
  assert.deepEqual(parseMailQuery('newer_than:7d', NOW).search, { since: new Date('2026-10-20T00:00:00Z') })
  assert.deepEqual(parseMailQuery('after:2026/10/01 before:2026-10-15', NOW).search, { since: new Date('2026-10-01T00:00:00Z'), before: new Date('2026-10-15T00:00:00Z') })
  assert.equal(parseMailQuery('in:Archive budget', NOW).mailbox, 'Archive')
  assert.deepEqual(parseMailQuery('in:Archive budget', NOW).search, { text: 'budget' })
  assert.deepEqual(parseMailQuery('label:Needs reply', NOW).search, { keyword: 'Needs', text: 'reply' })
  assert.deepEqual(parseMailQuery('label:"Needs reply"', NOW).search, { keyword: 'Needs_reply' })
  assert.deepEqual(parseMailQuery('', NOW).search, { all: true })
})

test('search terms IMAP cannot do are reported, not guessed', () => {
  const parsed = parseMailQuery('has:attachment -from:spam OR category:promotions invoice', NOW)
  assert.deepEqual(parsed.search, { text: 'invoice' })
  assert.deepEqual(parsed.ignored, ['has:attachment', '-from:spam', 'OR', 'category:promotions'])
})

test('message ids carry the folder; a bare number is in the inbox', () => {
  assert.equal(encodeMessageId('Clients/CloudNine', 42), 'Clients/CloudNine:42')
  assert.deepEqual(decodeMessageId('Clients/CloudNine:42'), { mailbox: 'Clients/CloudNine', uid: 42 })
  assert.deepEqual(decodeMessageId('Odd:Name:7'), { mailbox: 'Odd:Name', uid: 7 })
  assert.deepEqual(decodeMessageId('4521'), { mailbox: 'INBOX', uid: 4521 })
  assert.throws(() => decodeMessageId('m-101'), /isn't an email id/)
})

test('flags read as Gmail-style labels, and label changes map back', () => {
  assert.deepEqual(flagsToLabels(['\\Flagged', 'Lead', '$Important'], 'INBOX'), ['INBOX', 'UNREAD', 'STARRED', 'Lead', 'IMPORTANT'])
  assert.deepEqual(flagsToLabels(['\\Seen'], 'Archive'), ['Archive'])
  assert.deepEqual(labelChangesToFlags(['Lead', 'STARRED'], ['UNREAD']), { add: ['Lead', '\\Flagged', '\\Seen'], remove: [], custom: true })
  assert.deepEqual(labelChangesToFlags(['UNREAD']), { add: [], remove: ['\\Seen'], custom: false })
  assert.deepEqual(labelChangesToFlags(['Needs reply']).add, ['Needs_reply'])
  assert.throws(() => labelChangesToFlags([], ['INBOX']), /move_email/)
  assert.throws(() => labelChangesToFlags(['a(b)']), /can't be used as a label/)
})

test('only the standard mail ports, each with its TLS mode', () => {
  const env = { NODE_ENV: 'production' }
  assert.equal(tlsModeFor('imap', 993, env), 'implicit')
  assert.equal(tlsModeFor('imap', 143, env), 'starttls')
  assert.equal(tlsModeFor('smtp', 465, env), 'implicit')
  assert.equal(tlsModeFor('smtp', 587, env), 'starttls')
  assert.equal(tlsModeFor('imap', 6379, env), null, 'not Redis or anything else')
  assert.equal(tlsModeFor('imap', 3993, { EMAIL_ALLOW_LOCAL_SERVERS: 'true' }), 'local')
  assert.equal(tlsModeFor('imap', 3993, { EMAIL_ALLOW_LOCAL_SERVERS: 'true', NODE_ENV: 'production' }), null, 'never in production')
})

test('mail hosts must resolve to public addresses, checked once and connected to by IP', async () => {
  const env = { NODE_ENV: 'production' }
  const lookup = (answers: Record<string, string[]>) => async (h: string) => (answers[h] ?? []).map((address) => ({ address }))
  assert.deepEqual(await resolveMailHost('imap.example.com', env, lookup({ 'imap.example.com': ['203.0.113.7'] })), { address: '203.0.113.7', servername: 'imap.example.com' })
  await assert.rejects(resolveMailHost('evil.example.com', env, lookup({ 'evil.example.com': ['203.0.113.7', '10.0.0.5'] })), /private or reserved/)
  await assert.rejects(resolveMailHost('meta.example.com', env, lookup({ 'meta.example.com': ['169.254.169.254'] })), /private or reserved/)
  await assert.rejects(resolveMailHost('redis', env, lookup({ redis: ['172.18.0.3'] })), /isn't a mail server name/)
  await assert.rejects(resolveMailHost('127.0.0.1', env), /private or reserved/)
  await assert.rejects(resolveMailHost('[::1]', env), /private or reserved/)
  await assert.rejects(resolveMailHost('imap.example.com/x', env), /isn't a mail server name/)
  assert.deepEqual(await resolveMailHost('203.0.113.9', env), { address: '203.0.113.9', servername: undefined })
})

test('replies carry In-Reply-To and References; Bcc is not in the headers', async () => {
  const { raw, messageId } = await composeMessage({ email: 'office@agency.example', fromName: 'Demo Agency' }, { to: ['maria@client.example'], bcc: ['boss@agency.example'], subject: 'Re: SEO', body: 'Hi Maria', inReplyTo: '<orig@client.example>' })
  const headers = raw.toString('utf8').split('\r\n\r\n')[0]
  assert.match(headers, /^From: Demo Agency <office@agency.example>$/m)
  assert.match(headers, /^In-Reply-To: <orig@client.example>$/m)
  assert.match(headers, /^References: <orig@client.example>$/m)
  assert.doesNotMatch(headers, /boss@agency.example/)
  assert.match(messageId, /^<.+@agency.example>$/)
})

test('stored mailbox credentials are validated; a display name cannot smuggle headers', () => {
  const base = { email: 'office@agency.example', password: 'x', imap: { host: 'imap.example.com', port: 993 }, smtp: { host: 'smtp.example.com', port: 465 } }
  assert.equal(mailboxCredentialsSchema.parse(base).saveSentCopy, true)
  assert.equal(mailboxCredentialsSchema.safeParse({ ...base, fromName: 'Agency\r\nBcc: x@y.example' }).success, false)
  assert.equal(mailboxCredentialsSchema.safeParse({ ...base, email: 'not an address' }).success, false)
})
