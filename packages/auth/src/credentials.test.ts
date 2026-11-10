import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCredentials } from './index'

test('sign-in input: empty or "undefined" tenant means none; email trimmed and lower-cased', () => {
  assert.equal(normalizeCredentials({ email: 'a@b.test', password: 'x', tenantSlug: 'undefined' }).tenantSlug, undefined)
  assert.equal(normalizeCredentials({ email: 'a@b.test', password: 'x', tenantSlug: '  ' }).tenantSlug, undefined)
  assert.equal(normalizeCredentials({ email: 'a@b.test', password: 'x', tenantSlug: ' demo-agency ' }).tenantSlug, 'demo-agency')
  assert.equal(normalizeCredentials({ email: '  Admin@Demo-Agency.local ', password: 'x' }).email, 'admin@demo-agency.local')
  assert.equal(normalizeCredentials({ email: 'a@b.test', password: 'Secret ' }).password, 'Secret ', 'passwords are never altered')
})
