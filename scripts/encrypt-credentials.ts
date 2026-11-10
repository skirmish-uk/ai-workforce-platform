/**
 * Encrypts integration credentials still stored in plaintext, and re-encrypts any
 * encrypted with a previous key (after rotating CREDENTIALS_ENCRYPTION_KEY).
 *
 *   npx tsx scripts/encrypt-credentials.ts            # dry run: shows what would change
 *   npx tsx scripts/encrypt-credentials.ts --apply    # writes the changes
 *
 * Never prints credential values. Uses DATABASE_URL and the keys from the root .env.
 */
import { config } from 'dotenv'
import path from 'node:path'
const loaded = config({ path: path.resolve(__dirname, '../.env') })
for (const [key, value] of Object.entries(loaded.parsed ?? {})) {
  if (process.env[key] === '' && value !== '') process.env[key] = value
}

import { prisma } from '@ai-workforce/db'
import { decryptCredentials, encryptCredentials, encryptionConfigured, isEncryptedCredentials, needsEncryption } from '@ai-workforce/tools'

async function main(): Promise<void> {
  if (!encryptionConfigured()) throw new Error('CREDENTIALS_ENCRYPTION_KEY is not set in the root .env (generate one with: openssl rand -base64 32).')
  const apply = process.argv.includes('--apply')
  const rows = await prisma.integration.findMany({ select: { id: true, name: true, tenantId: true, credentials: true } })
  let changed = 0
  for (const row of rows) {
    if (!needsEncryption(row.credentials)) continue
    const action = isEncryptedCredentials(row.credentials) ? 're-encrypt with the current key' : 'encrypt plaintext credentials'
    console.log(`${apply ? '✓' : '·'} ${row.name} (${row.id}): ${action}`)
    if (apply) {
      const plain = decryptCredentials(row.credentials, row.tenantId)
      await prisma.integration.update({ where: { id: row.id }, data: { credentials: encryptCredentials(plain, row.tenantId) as never } })
    }
    changed++
  }
  console.log(`${rows.length} integration(s) checked; ${changed} ${apply ? 'updated' : 'would change (run with --apply)'}.`)
}

main()
  .catch((error) => {
    console.error(`✖ ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
