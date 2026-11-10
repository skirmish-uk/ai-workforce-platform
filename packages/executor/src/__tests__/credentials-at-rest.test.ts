import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { prisma } from '@ai-workforce/db'
import { encryptCredentials, getIntegrationForAdapter, removeOAuthConnection, storeOAuthConnection } from '@ai-workforce/tools'
import { assertTestDatabase, createFixture, type Fixture } from './helpers'

const fixtures: Fixture[] = []
before(() => {
  assertTestDatabase()
  process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString('base64')
})
after(async () => {
  for (const f of fixtures) await f.cleanup().catch(() => undefined)
  await prisma.$disconnect()
})

test('tools get decrypted credentials; the database holds only ciphertext; a copied row does not decrypt elsewhere', async () => {
  const a = await createFixture(); fixtures.push(a)
  const b = await createFixture(); fixtures.push(b)
  const secret = { access_token: 'ya29.live-token', refresh_token: '1//refresh' }
  const encrypted = encryptCredentials(secret, a.tenantId)
  await prisma.integration.create({ data: { name: 'Gmail', provider: 'google', tenantId: a.tenantId, credentials: encrypted as never } })

  const raw = await prisma.$queryRaw<Array<{ credentials: unknown }>>`SELECT credentials FROM "Integration" WHERE "tenantId" = ${a.tenantId}`
  assert.ok(!JSON.stringify(raw).includes('ya29'), 'no plaintext token in the database')
  assert.deepEqual((await getIntegrationForAdapter(a.tenantId, 'Gmail')).credentials, secret)

  // Ciphertext copied into another tenant's connection is useless there.
  await prisma.integration.create({ data: { name: 'Gmail', provider: 'google', tenantId: b.tenantId, credentials: encrypted as never } })
  await assert.rejects(getIntegrationForAdapter(b.tenantId, 'Gmail'), /could not be decrypted/)
})

test('Connect Google: tokens replace the sandbox connection encrypted; Disconnect clears and deactivates it', async () => {
  const a = await createFixture(); fixtures.push(a)
  const b = await createFixture(); fixtures.push(b)
  // The demo seed's sandbox row, and another tenant's sandbox row that must not change.
  const sandbox = await prisma.integration.create({ data: { name: 'Gmail', provider: 'google', tenantId: a.tenantId, credentials: { encrypted: true }, config: { sandbox: true, scopes: ['x'] } } })
  await prisma.integration.create({ data: { name: 'Gmail', provider: 'google', tenantId: b.tenantId, credentials: { encrypted: true }, config: { sandbox: true } } })
  assert.equal((await getIntegrationForAdapter(a.tenantId, 'Gmail')).sandbox, true)

  const tokens = { access_token: 'ya29.connect', refresh_token: '1//connect', scope: 'gmail' }
  const stored = await storeOAuthConnection({ tenantId: a.tenantId, name: 'Gmail', provider: 'google', scopes: ['gmail.send'], credentials: tokens, account: 'owner@agency.example', connectedByUserId: 'u1' })
  assert.deepEqual(stored, { id: sandbox.id, created: false }, 'the existing row is updated, not duplicated')

  const row = await prisma.integration.findUniqueOrThrow({ where: { id: sandbox.id } })
  assert.ok(!JSON.stringify(row.credentials).includes('ya29'), 'stored encrypted')
  assert.equal((row.config as Record<string, unknown>).connectedAccount, 'owner@agency.example')
  const connection = await getIntegrationForAdapter(a.tenantId, 'Gmail')
  assert.equal(connection.sandbox, false, 'a real connection leaves sandbox mode')
  assert.deepEqual(connection.credentials, tokens)
  assert.equal((await getIntegrationForAdapter(b.tenantId, 'Gmail')).sandbox, true, 'other tenants are untouched')

  // A service with no row yet gets one.
  assert.equal((await storeOAuthConnection({ tenantId: a.tenantId, name: 'Google Calendar', provider: 'google', scopes: [], credentials: tokens, account: null, connectedByUserId: 'u1' })).created, true)

  const removed = await removeOAuthConnection(a.tenantId, 'Gmail')
  assert.deepEqual(removed, { removed: true, credentials: tokens }, 'returns the tokens so they can be revoked')
  const after = await prisma.integration.findUniqueOrThrow({ where: { id: sandbox.id } })
  assert.deepEqual(after.credentials, {})
  assert.equal(after.isActive, false)
  assert.equal((after.config as Record<string, unknown>).sandbox, false, 'never silently falls back to fictional data')
  await assert.rejects(getIntegrationForAdapter(a.tenantId, 'Gmail'), /No active "Gmail" integration/)
})
