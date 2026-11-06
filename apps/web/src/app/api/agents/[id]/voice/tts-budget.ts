import { prisma } from '@ai-workforce/db'
import { safeErrorMessage } from '@ai-workforce/domain'
import { ttsProvider, type TtsProvider } from '@ai-workforce/llm'
import { getRedisConnection } from '@ai-workforce/queue'

/**
 * Monthly caps on Cartesia speech, so a leaked login or a runaway page can't run up the bill
 * (docs/VOICE.md). Cartesia bills by the character (1 credit each; a minute of speech is about
 * 780). Two caps, both per calendar month (UTC):
 *
 * - the whole platform: CARTESIA_MONTHLY_CHARACTER_LIMIT, default 100,000 (Cartesia's Pro plan
 *   allowance, about 2 hours of speech); "0" turns the cap off
 * - each tenant: Tenant.settings.voiceLimits.monthlyCharacters, default TENANT_DEFAULT
 *
 * Characters are reserved before each sentence is synthesised (Redis INCRBY, given back if it
 * would go over), so concurrent calls can't race past a cap. Cached lines cost nothing and aren't
 * counted. A counter missing (a Redis wipe) is rebuilt from this month's VOICE_TURN and
 * VOICE_CALL_STARTED audit rows. OpenAI voices aren't capped here (they're billed with the LLM key).
 */
export const PLATFORM_DEFAULT = 100_000
export const TENANT_DEFAULT = 50_000
/** Voices recorded (cloned) per tenant per month: stops record-delete-record churn. */
export const CLONES_PER_MONTH_DEFAULT = 10

const KEY_TTL_SECONDS = 40 * 86_400
/** A call doesn't start with less than this left (about 20 s of speech): it couldn't say much. */
export const MIN_CALL_CHARACTERS = 300

/** Which limit stops a new call from starting, if any. */
export function callBlockedBy(usage: VoiceUsage): 'platform' | 'tenant' | null {
  const out = (u: { used: number; limit: number }) => u.limit > 0 && u.used > u.limit - MIN_CALL_CHARACTERS
  return out(usage.platform) ? 'platform' : out(usage.tenant) ? 'tenant' : null
}

function month(now = new Date()): string {
  return now.toISOString().slice(0, 7)
}

function keys(tenantId: string, now?: Date) {
  const m = month(now)
  return { tenant: `tts-chars:${m}:${tenantId}`, platform: `tts-chars:${m}:all` }
}

function numberSetting(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function voiceLimits(settings: unknown, env: Record<string, string | undefined> = process.env) {
  const raw = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).voiceLimits : undefined
  const tenant = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const platformEnv = env.CARTESIA_MONTHLY_CHARACTER_LIMIT
  const platform = platformEnv !== undefined && platformEnv !== '' && Number.isFinite(Number(platformEnv)) ? Number(platformEnv) : PLATFORM_DEFAULT
  return {
    /** 0 = no cap. */
    platformCharacters: platform,
    tenantCharacters: numberSetting(tenant.monthlyCharacters) ?? TENANT_DEFAULT,
    clonesPerMonth: numberSetting(tenant.clonesPerMonth) ?? CLONES_PER_MONTH_DEFAULT,
  }
}

/** Characters spent this month so far, from the audit rows (used when a counter is missing). */
async function spentFromAudit(tenantId: string | null): Promise<number> {
  const since = new Date(`${month()}-01T00:00:00.000Z`)
  const rows = await prisma.auditLog.findMany({
    where: { action: { in: ['VOICE_TURN', 'VOICE_CALL_STARTED'] }, createdAt: { gte: since }, ...(tenantId ? { tenantId } : {}) },
    select: { newData: true },
  })
  return rows.reduce((sum, r) => {
    const data = r.newData as { ttsCharacters?: unknown; ttsModel?: unknown } | null
    const chars = typeof data?.ttsCharacters === 'number' ? data.ttsCharacters : 0
    // Only Cartesia speech counts (OpenAI voices are billed elsewhere).
    return sum + (typeof data?.ttsModel === 'string' && data.ttsModel.startsWith('gpt-') ? 0 : chars)
  }, 0)
}

async function ensure(key: string, tenantId: string | null): Promise<void> {
  const redis = getRedisConnection()
  if (await redis.exists(key)) return
  const spent = await spentFromAudit(tenantId)
  // NX: another request may have rebuilt it meanwhile.
  await redis.set(key, String(spent), 'EX', KEY_TTL_SECONDS, 'NX')
}

export interface VoiceUsage {
  tenant: { used: number; limit: number }
  platform: { used: number; limit: number }
}

/** This month's Cartesia characters for a tenant and the platform, with the caps. */
export async function voiceUsage(tenantId: string, settings: unknown): Promise<VoiceUsage> {
  const limits = voiceLimits(settings)
  const k = keys(tenantId)
  await Promise.all([ensure(k.tenant, tenantId), ensure(k.platform, null)])
  const [t, p] = await getRedisConnection().mget(k.tenant, k.platform)
  return { tenant: { used: Number(t ?? 0), limit: limits.tenantCharacters }, platform: { used: Number(p ?? 0), limit: limits.platformCharacters } }
}

export class VoiceLimitError extends Error {
  constructor(readonly scope: 'tenant' | 'platform') {
    super(scope === 'tenant' ? 'This month’s voice limit for this business has been reached' : 'This month’s voice limit has been reached')
    this.name = 'VoiceLimitError'
  }
}

/**
 * Reserves characters for one piece of Cartesia speech, or throws VoiceLimitError. Returns how
 * to give them back if the speech then fails. Other providers pass through uncounted.
 */
export async function reserveSpeech(tenantId: string, settings: unknown, characters: number, provider?: TtsProvider): Promise<() => Promise<void>> {
  const none = async () => undefined
  if (characters <= 0 || (provider ?? ttsProvider()) !== 'cartesia') return none
  const limits = voiceLimits(settings)
  const k = keys(tenantId)
  const redis = getRedisConnection()
  try {
    await Promise.all([ensure(k.tenant, tenantId), ensure(k.platform, null)])
  } catch (error) {
    // The counter can't be read (Redis or the database is down): don't block the call over it.
    console.error('Voice usage check failed:', safeErrorMessage(error))
    return none
  }
  const [tenantAfter, platformAfter] = await Promise.all([redis.incrby(k.tenant, characters), redis.incrby(k.platform, characters)])
  const giveBack = async () => {
    await Promise.all([redis.decrby(k.tenant, characters), redis.decrby(k.platform, characters)]).catch(() => undefined)
  }
  if (limits.platformCharacters > 0 && platformAfter > limits.platformCharacters) {
    await giveBack()
    throw new VoiceLimitError('platform')
  }
  if (limits.tenantCharacters > 0 && tenantAfter > limits.tenantCharacters) {
    await giveBack()
    throw new VoiceLimitError('tenant')
  }
  return giveBack
}

/** Voices recorded by this tenant this month (from the audit rows). */
export async function clonesThisMonth(tenantId: string): Promise<number> {
  return prisma.auditLog.count({ where: { tenantId, action: 'VOICE_CLONED', createdAt: { gte: new Date(`${month()}-01T00:00:00.000Z`) } } })
}
