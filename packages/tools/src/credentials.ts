import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * Integration credentials at rest (Integration.credentials): AES-256-GCM with a key
 * held outside the database (CREDENTIALS_ENCRYPTION_KEY, 32 bytes base64). The tenant
 * id is bound in as additional authenticated data, so ciphertext copied to another
 * tenant's row fails to decrypt. Rotation: put the new key in CREDENTIALS_ENCRYPTION_KEY,
 * the old one(s) in CREDENTIALS_ENCRYPTION_KEY_PREVIOUS (comma-separated), then run
 * scripts/encrypt-credentials.ts --apply to re-encrypt everything with the new key.
 *
 * Legacy plaintext rows (and non-secret placeholders) are returned as stored, so
 * existing data keeps working until it is migrated.
 */

export const CREDENTIALS_FORMAT = 'aes-256-gcm:v1'

export interface EncryptedCredentials {
  _encrypted: typeof CREDENTIALS_FORMAT
  /** Key id: first 12 hex chars of sha256(key). Identifies which key to decrypt with. */
  kid: string
  iv: string
  tag: string
  data: string
}

export class CredentialsKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialsKeyError'
  }
}

type Env = Record<string, string | undefined>

function parseKey(value: string, name: string): Buffer {
  const key = Buffer.from(value.trim(), 'base64')
  if (key.length !== 32) throw new CredentialsKeyError(`${name} must be 32 bytes, base64-encoded (generate one with: openssl rand -base64 32)`)
  return key
}

const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 12)

function loadKeys(env: Env): { primary: { id: string; key: Buffer } | null; byId: Map<string, Buffer> } {
  const byId = new Map<string, Buffer>()
  let primary: { id: string; key: Buffer } | null = null
  if (env.CREDENTIALS_ENCRYPTION_KEY?.trim()) {
    const key = parseKey(env.CREDENTIALS_ENCRYPTION_KEY, 'CREDENTIALS_ENCRYPTION_KEY')
    primary = { id: keyId(key), key }
    byId.set(primary.id, key)
  }
  for (const [i, value] of (env.CREDENTIALS_ENCRYPTION_KEY_PREVIOUS ?? '').split(',').filter((v) => v.trim()).entries()) {
    const key = parseKey(value, `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS[${i}]`)
    byId.set(keyId(key), key)
  }
  return { primary, byId }
}

export function isEncryptedCredentials(value: unknown): value is EncryptedCredentials {
  return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>)._encrypted === CREDENTIALS_FORMAT)
}

export function encryptionConfigured(env: Env = process.env): boolean {
  return Boolean(env.CREDENTIALS_ENCRYPTION_KEY?.trim())
}

/** Encrypts credentials for one tenant. Throws when no key is configured: never store real secrets in plaintext. */
export function encryptCredentials(credentials: Record<string, unknown>, tenantId: string, env: Env = process.env): EncryptedCredentials {
  const { primary } = loadKeys(env)
  if (!primary) throw new CredentialsKeyError('CREDENTIALS_ENCRYPTION_KEY is not set, so credentials cannot be stored. Generate one with: openssl rand -base64 32')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', primary.key, iv)
  cipher.setAAD(Buffer.from(`tenant:${tenantId}`))
  const data = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()])
  return { _encrypted: CREDENTIALS_FORMAT, kid: primary.id, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

/** Returns usable credentials: decrypts encrypted values, passes legacy plaintext through unchanged. */
export function decryptCredentials(stored: unknown, tenantId: string, env: Env = process.env): Record<string, unknown> {
  if (!isEncryptedCredentials(stored)) return (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>
  const key = loadKeys(env).byId.get(stored.kid)
  if (!key) throw new CredentialsKeyError(`No encryption key with id ${stored.kid} is configured (set it as CREDENTIALS_ENCRYPTION_KEY or in CREDENTIALS_ENCRYPTION_KEY_PREVIOUS).`)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64'))
    decipher.setAAD(Buffer.from(`tenant:${tenantId}`))
    decipher.setAuthTag(Buffer.from(stored.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()])
    return JSON.parse(plain.toString('utf8')) as Record<string, unknown>
  } catch {
    // Wrong tenant, tampered data or wrong key: never return partial or guessed credentials.
    throw new CredentialsKeyError('Stored credentials could not be decrypted (wrong tenant, tampered data or wrong key).')
  }
}

/** Non-secret placeholder written by the demo seed; not worth encrypting. */
export function isPlaceholderCredentials(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true
  const keys = Object.keys(value as object)
  return keys.length === 0 || (keys.length === 1 && (value as Record<string, unknown>).encrypted === true)
}

/** True when a stored value should be (re-)encrypted: real plaintext secrets, or encrypted with a non-primary key. */
export function needsEncryption(stored: unknown, env: Env = process.env): boolean {
  if (isEncryptedCredentials(stored)) {
    const { primary } = loadKeys(env)
    return primary !== null && stored.kid !== primary.id
  }
  return !isPlaceholderCredentials(stored)
}

/** For API responses and audit rows: whether credentials exist, never what they are. */
export function describeCredentials(stored: unknown): { hasCredentials: boolean; encrypted: boolean } {
  return { hasCredentials: !isPlaceholderCredentials(stored) || isEncryptedCredentials(stored), encrypted: isEncryptedCredentials(stored) }
}
