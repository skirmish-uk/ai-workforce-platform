import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redact, redactString, safeErrorMessage, REDACTED } from './redact'

test('redacts values under secret-named keys at any depth', () => {
  const input = {
    to: 'a@example.com',
    credentials: { access_token: 'abc', refresh_token: 'def' },
    nested: [{ apiKey: 'k', password: 'p', client_secret: 's', note: 'fine' }],
    tokensUsed: { input: 10, output: 5 },
  }
  const out = redact(input)
  assert.equal(out.to, 'a@example.com')
  assert.equal(out.credentials, REDACTED)
  assert.deepEqual(out.nested[0], { apiKey: REDACTED, password: REDACTED, client_secret: REDACTED, note: 'fine' })
  // Usage counters are not secrets just because they contain "token".
  assert.deepEqual(out.tokensUsed, { input: 10, output: 5 })
  // Input is not mutated.
  assert.equal(input.credentials.access_token, 'abc')
})

test('redacts credential-shaped substrings inside free text', () => {
  const text =
    'key sk-ant-REDACTMEREDACTME1234 and Bearer abcdefghijklmnop.qrs and ' +
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ' +
    'and AKIAABCDEFGHIJKLMNOP and ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxx'
  const out = redactString(text)
  assert.ok(!out.includes('sk-ant-'), out)
  assert.ok(!out.includes('abcdefghijklmnop'), out)
  assert.ok(!out.includes('eyJhbGci'), out)
  assert.ok(!out.includes('AKIA'), out)
  assert.ok(!out.includes('ya29.'), out)
  assert.ok(out.startsWith('key [REDACTED]'), out)
})

test('redacts PEM private keys', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----'
  assert.equal(redactString(`x ${pem} y`), `x ${REDACTED} y`)
})

test('truncates long strings and handles cycles', () => {
  const long = 'a'.repeat(50)
  assert.match(redactString(long, 10), /^a{10}…\[truncated 40 chars\]$/)
  const cyclic: Record<string, unknown> = { a: 1 }
  cyclic.self = cyclic
  assert.deepEqual(redact(cyclic), { a: 1, self: '[Circular]' })
})

test('safeErrorMessage strips secrets from error text', () => {
  const msg = safeErrorMessage(new Error('401 for token Bearer abcdefghijklmnopqrstuvwxyz'))
  assert.ok(!msg.includes('abcdefghijklmnopqrstuvwxyz'))
  assert.equal(safeErrorMessage(undefined, 'fallback'), 'fallback')
})
