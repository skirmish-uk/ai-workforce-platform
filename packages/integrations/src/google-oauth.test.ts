import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GOOGLE_SERVICES,
  createOAuthState,
  emailFromIdToken,
  googleConnectUrl,
  googleOAuthConfigured,
  grantedServices,
  parseGoogleServices,
  verifyOAuthState,
} from './google-oauth'

const SECRET = 'test-secret'
const payload = { tenantId: 't1', userId: 'u1', services: ['gmail' as const], nonce: 'n1', exp: Date.now() + 60_000 }

test('signed state round-trips, and is refused when tampered, expired, from another browser or signed with another secret', () => {
  const state = createOAuthState(payload, SECRET)
  const ok = verifyOAuthState(state, SECRET, 'n1')
  assert.ok(ok.ok && ok.payload.tenantId === 't1')

  const [data, sig] = state.split('.')
  const forged = Buffer.from(JSON.stringify({ ...payload, tenantId: 'victim' })).toString('base64url')
  assert.deepEqual(verifyOAuthState(`${forged}.${sig}`, SECRET, 'n1'), { ok: false, reason: 'bad signature' })
  assert.deepEqual(verifyOAuthState(`${data}.${sig}`, 'other-secret', 'n1'), { ok: false, reason: 'bad signature' })
  assert.deepEqual(verifyOAuthState(state, SECRET, 'n2'), { ok: false, reason: 'nonce mismatch (started in another browser?)' })
  assert.deepEqual(verifyOAuthState(state, SECRET, undefined), { ok: false, reason: 'nonce mismatch (started in another browser?)' })
  assert.deepEqual(verifyOAuthState(createOAuthState({ ...payload, exp: Date.now() - 1 }, SECRET), SECRET, 'n1'), { ok: false, reason: 'expired' })
  assert.equal(verifyOAuthState('garbage', SECRET, 'n1').ok, false)
  assert.equal(verifyOAuthState(null, SECRET, 'n1').ok, false)
  assert.throws(() => createOAuthState(payload, ''))
})

test('services: parsed from the query, defaulting to Gmail + Calendar, unknown names dropped', () => {
  assert.deepEqual(parseGoogleServices(null), ['gmail', 'calendar'])
  assert.deepEqual(parseGoogleServices('calendar, drive ,calendar'), ['calendar'])
  assert.deepEqual(parseGoogleServices('nope'), [])
})

test('only services whose scopes were all granted are connected', () => {
  const gmailOnly = [...GOOGLE_SERVICES.gmail.scopes, 'openid', 'email'].join(' ')
  assert.deepEqual(grantedServices(gmailOnly, ['gmail', 'calendar']), { granted: ['gmail'], missing: ['calendar'] })
  const partial = GOOGLE_SERVICES.gmail.scopes.slice(1).join(' ')
  assert.deepEqual(grantedServices(partial, ['gmail']), { granted: [], missing: ['gmail'] })
  assert.deepEqual(grantedServices(undefined, ['gmail']).granted, [])
})

test('consent URL asks for offline access, the services\' scopes and the identity scopes', () => {
  const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 's' }
  const url = new URL(googleConnectUrl('https://app.example/api/integrations/google/callback', 'STATE', ['calendar'], env))
  assert.equal(url.hostname, 'accounts.google.com')
  assert.equal(url.searchParams.get('client_id'), env.GOOGLE_CLIENT_ID)
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('prompt'), 'consent')
  assert.equal(url.searchParams.get('state'), 'STATE')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example/api/integrations/google/callback')
  const scopes = url.searchParams.get('scope')!.split(' ')
  for (const s of [...GOOGLE_SERVICES.calendar.scopes, 'openid', 'email']) assert.ok(scopes.includes(s), s)
  assert.ok(!scopes.some((s) => s.includes('gmail')), 'no Gmail scopes when only Calendar was asked for')
  assert.equal(googleOAuthConfigured(env), true)
  assert.equal(googleOAuthConfigured({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: 's' }), false)
})

test('account email is read from the ID token', () => {
  const token = ['x', Buffer.from(JSON.stringify({ email: 'owner@agency.example' })).toString('base64url'), 'sig'].join('.')
  assert.equal(emailFromIdToken(token), 'owner@agency.example')
  assert.equal(emailFromIdToken('not-a-jwt'), null)
  assert.equal(emailFromIdToken(undefined), null)
})
