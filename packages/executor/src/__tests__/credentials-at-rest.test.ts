import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { prisma } from '@ai-workforce/db'
import { encryptCredentials, getIntegrationForAdapter } from '@ai-workforce/tools'
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
