import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { CredentialsKeyError, decryptCredentials, describeCredentials, encryptCredentials, isEncryptedCredentials, needsEncryption } from './credentials'

const k1 = randomBytes(32).toString('base64')
const k2 = randomBytes(32).toString('base64')
const secret = { access_token: 'ya29.secret', refresh_token: '1//refresh', expires_at: 123 }

test('round trip; ciphertext contains no secret and is bound to the tenant', () => {
  const env = { CREDENTIALS_ENCRYPTION_KEY: k1 }
  const enc = encryptCredentials(secret, 'tenant-a', env)
  assert.ok(isEncryptedCredentials(enc))
  assert.ok(!JSON.stringify(enc).includes('ya29'))
  assert.deepEqual(decryptCredentials(enc, 'tenant-a', env), secret)
  assert.throws(() => decryptCredentials(enc, 'tenant-b', env), CredentialsKeyError, 'copied to another tenant: refused')
  const tampered = { ...enc, data: Buffer.from('x' + enc.data).toString('base64') }
  assert.throws(() => decryptCredentials(tampered, 'tenant-a', env), CredentialsKeyError)
  assert.notEqual(encryptCredentials(secret, 'tenant-a', env).iv, enc.iv, 'fresh IV every time')
})

test('no key: storing secrets is refused; legacy plaintext still reads', () => {
  assert.throws(() => encryptCredentials(secret, 't', {}), /CREDENTIALS_ENCRYPTION_KEY is not set/)
  assert.throws(() => encryptCredentials(secret, 't', { CREDENTIALS_ENCRYPTION_KEY: 'too-short' }), /32 bytes/)
  assert.deepEqual(decryptCredentials(secret, 't', {}), secret)
  assert.deepEqual(decryptCredentials(null, 't', {}), {})
})

test('rotation: old key still decrypts, and rows on it are flagged for re-encryption', () => {
  const old = encryptCredentials(secret, 't', { CREDENTIALS_ENCRYPTION_KEY: k1 })
  const rotated = { CREDENTIALS_ENCRYPTION_KEY: k2, CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: k1 }
  assert.deepEqual(decryptCredentials(old, 't', rotated), secret)
  assert.equal(needsEncryption(old, rotated), true)
  assert.equal(needsEncryption(encryptCredentials(secret, 't', rotated), rotated), false)
  assert.throws(() => decryptCredentials(old, 't', { CREDENTIALS_ENCRYPTION_KEY: k2 }), /No encryption key with id/)
})

test('placeholders are not secrets; descriptions never reveal values', () => {
  assert.equal(needsEncryption({ encrypted: true }, { CREDENTIALS_ENCRYPTION_KEY: k1 }), false)
  assert.equal(needsEncryption({}, {}), false)
  assert.equal(needsEncryption(secret, {}), true)
  assert.deepEqual(describeCredentials(secret), { hasCredentials: true, encrypted: false })
  assert.deepEqual(describeCredentials({ encrypted: true }), { hasCredentials: false, encrypted: false })
})
