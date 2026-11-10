import { prisma } from '@ai-workforce/db'
import { sendAlert } from './notify'

/**
 * Error tracking without a third-party service: uncaught server errors (web requests, via
 * apps/web/src/instrumentation.ts) and failed background jobs (the worker) become Incidents
 * in the operator console, one per kind of error (`fingerprint`) with a count and when it was
 * last seen, under the platform tenant. A new kind of error also sends an alert (notify.ts).
 */

export type ErrorSource = 'web' | 'worker'

/** Secrets that can turn up in error messages (API keys, bearer tokens, JWTs). */
const SECRETS = /\b(?:sk-[A-Za-z0-9_-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{10,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,})|Bearer\s+\S+/g

export function scrub(text: string): string {
  return text.replace(SECRETS, '[redacted]')
}

/**
 * What makes two errors "the same": where it happened and the message with the parts that
 * change between occurrences (ids, numbers, quoted values) taken out.
 */
export function errorFingerprint(source: ErrorSource, where: string, message: string): string {
  const firstLine = message.split('\n')[0] ?? ''
  const normalised = firstLine
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\bc[a-z0-9]{24}\b/g, '<id>')
    .replace(/(["'`]).*?\1/g, '<value>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return `${source}:${where.replace(/\d+/g, '<n>')}:${normalised}`
}

const OPEN = ['OPEN', 'INVESTIGATING', 'IDENTIFIED'] as const
/** Per process: one write per kind of error every 10 s, so an error in a loop can't flood the database. */
const lastWrite = new Map<string, number>()
const THROTTLE_MS = 10_000
let platformTenantId: string | null = null

/** Records an error as an Incident (or counts it on the open one), never throwing. */
export async function recordError(input: { source: ErrorSource; where: string; error: unknown }): Promise<void> {
  try {
    const err = input.error instanceof Error ? input.error : new Error(String(input.error))
    const message = scrub(err.message || err.name || 'Unknown error')
    const fingerprint = errorFingerprint(input.source, input.where, message)
    const now = Date.now()
    if (now - (lastWrite.get(fingerprint) ?? 0) < THROTTLE_MS) return
    lastWrite.set(fingerprint, now)

    platformTenantId ??= (await prisma.tenant.findUnique({ where: { slug: 'platform' }, select: { id: true } }))?.id ?? null
    if (!platformTenantId) return
    const existing = await prisma.incident.findFirst({
      where: { tenantId: platformTenantId, source: `error:${input.source}`, status: { in: [...OPEN] }, metadata: { path: ['fingerprint'], equals: fingerprint } },
      select: { id: true, metadata: true },
    })
    const at = new Date(now).toISOString()
    if (existing) {
      const meta = (existing.metadata ?? {}) as Record<string, unknown>
      await prisma.incident.update({ where: { id: existing.id }, data: { metadata: { ...meta, count: Number(meta.count ?? 1) + 1, lastSeen: at } as never } })
      return
    }
    const title = `${input.source === 'web' ? 'Web' : 'Worker'} error in ${input.where}: ${message.split('\n')[0]}`.slice(0, 200)
    await prisma.incident.create({
      data: {
        tenantId: platformTenantId,
        title,
        description: scrub(err.stack ?? message).slice(0, 4000),
        severity: 'MEDIUM',
        source: `error:${input.source}`,
        metadata: { fingerprint, where: input.where, count: 1, firstSeen: at, lastSeen: at } as never,
      },
    })
    await sendAlert('New server error', `${title}\nSee Incidents in the operator console.`)
  } catch (error) {
    // Error tracking must never cause errors of its own.
    console.error('Could not record error:', error instanceof Error ? error.message : error)
  }
}
