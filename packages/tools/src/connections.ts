import { prisma } from '@ai-workforce/db'
import type { Prisma } from '@prisma/client'
import { decryptCredentials, encryptCredentials } from './credentials'

/**
 * Storing and removing real OAuth connections. Tools find a tenant's connection by
 * Integration.name (getIntegrationForAdapter), so a connection updates the existing row for
 * that name, or creates one. Credentials are always stored encrypted; a real connection
 * leaves sandbox mode.
 */

export interface StoreConnectionInput {
  tenantId: string
  /** Adapter name the tools look up, e.g. "Gmail", "Google Calendar". */
  name: string
  provider: string
  scopes: readonly string[]
  credentials: Record<string, unknown>
  /** The connected account (e.g. an email address), shown on the integrations page. */
  account: string | null
  connectedByUserId: string
}

export async function storeOAuthConnection(input: StoreConnectionInput): Promise<{ id: string; created: boolean }> {
  const encrypted = encryptCredentials(input.credentials, input.tenantId) as unknown as Prisma.InputJsonObject
  const existing = await prisma.integration.findFirst({ where: { tenantId: input.tenantId, name: input.name }, orderBy: { createdAt: 'asc' } })
  const config = {
    ...((existing?.config ?? {}) as Record<string, unknown>),
    sandbox: false,
    connectedAccount: input.account,
    connectedAt: new Date().toISOString(),
    connectedByUserId: input.connectedByUserId,
  }
  if (existing) {
    await prisma.integration.update({
      where: { id: existing.id },
      data: { credentials: encrypted, config: config as Prisma.InputJsonObject, scopes: [...input.scopes], isActive: true, provider: input.provider },
    })
    return { id: existing.id, created: false }
  }
  const created = await prisma.integration.create({
    data: { tenantId: input.tenantId, name: input.name, provider: input.provider, scopes: [...input.scopes], credentials: encrypted, config: config as Prisma.InputJsonObject, isActive: true },
  })
  return { id: created.id, created: true }
}

/**
 * Removes a real connection: clears the stored tokens and deactivates the row, so tools stop
 * using it. Returns the decrypted tokens first so the caller can revoke them at the provider.
 * Never falls back to sandbox mode on its own: a customer whose agents silently switched to
 * fictional data would be worse off than one whose agents say "not connected".
 */
export async function removeOAuthConnection(tenantId: string, name: string): Promise<{ removed: boolean; credentials: Record<string, unknown> | null }> {
  const rows = await prisma.integration.findMany({ where: { tenantId, name } })
  let credentials: Record<string, unknown> | null = null
  for (const row of rows) {
    try {
      credentials ??= decryptCredentials(row.credentials, tenantId)
    } catch {
      // Undecryptable tokens are cleared all the same.
    }
    const config = { ...((row.config ?? {}) as Record<string, unknown>), sandbox: false, connectedAccount: null, disconnectedAt: new Date().toISOString() }
    await prisma.integration.update({ where: { id: row.id }, data: { credentials: {}, isActive: false, config: config as Prisma.InputJsonObject } })
  }
  return { removed: rows.length > 0, credentials }
}
