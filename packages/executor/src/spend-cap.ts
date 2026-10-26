import { prisma } from '@ai-workforce/db'

export interface SpendLimits {
  dailyUsd?: number
  monthlyUsd?: number
}

export interface SpendCapResult {
  allowed: boolean
  reason?: string
  spentTodayUsd: number
  spentThisMonthUsd: number
  limits: SpendLimits
}

function readSpendLimits(settings: unknown): SpendLimits {
  if (!settings || typeof settings !== 'object') return {}
  const costLimits = (settings as Record<string, unknown>).costLimits
  if (!costLimits || typeof costLimits !== 'object') return {}
  const limits = costLimits as Record<string, unknown>
  return {
    dailyUsd: typeof limits.dailyUsd === 'number' ? limits.dailyUsd : undefined,
    monthlyUsd: typeof limits.monthlyUsd === 'number' ? limits.monthlyUsd : undefined,
  }
}

/**
 * Sums AuditLog.newData.costUsd for a tenant's agent runs since a given time.
 * Every terminal run status writes exactly one of these actions (see AUDIT_ACTION
 * in agent.ts), so runs that ended in approval_required/escalated/partial count too.
 */
async function sumCostSince(tenantId: string, since: Date): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ total: number | null }>>`
    SELECT COALESCE(SUM(("newData"->>'costUsd')::numeric), 0)::float AS total
    FROM "AuditLog"
    WHERE "tenantId" = ${tenantId}
      AND action IN ('AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_FINISHED', 'AGENT_RUN_ESCALATED', 'VOICE_DRAFT_DISCARDED')
      AND "createdAt" >= ${since}
      AND "newData"->>'costUsd' IS NOT NULL
  `
  return rows[0]?.total ?? 0
}

/**
 * Checks a tenant's rolling daily/monthly LLM spend (summed from the same
 * AuditLog.newData.costUsd rows runAgent() already writes) against limits
 * stored in Tenant.settings.costLimits, e.g. `{ "costLimits": { "dailyUsd": 5,
 * "monthlyUsd": 100 } }`. No limit configured for a period = unlimited for
 * that period (opt-in, so existing tenants aren't silently blocked).
 */
export async function checkSpendCap(tenantId: string): Promise<SpendCapResult> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } })
  const limits = readSpendLimits(tenant?.settings)

  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  const [spentTodayUsd, spentThisMonthUsd] = await Promise.all([
    limits.dailyUsd !== undefined ? sumCostSince(tenantId, startOfDay) : Promise.resolve(0),
    limits.monthlyUsd !== undefined ? sumCostSince(tenantId, startOfMonth) : Promise.resolve(0),
  ])

  if (limits.dailyUsd !== undefined && spentTodayUsd >= limits.dailyUsd) {
    return {
      allowed: false,
      reason: `Daily LLM spend cap reached ($${spentTodayUsd.toFixed(4)} / $${limits.dailyUsd.toFixed(2)})`,
      spentTodayUsd,
      spentThisMonthUsd,
      limits,
    }
  }

  if (limits.monthlyUsd !== undefined && spentThisMonthUsd >= limits.monthlyUsd) {
    return {
      allowed: false,
      reason: `Monthly LLM spend cap reached ($${spentThisMonthUsd.toFixed(4)} / $${limits.monthlyUsd.toFixed(2)})`,
      spentTodayUsd,
      spentThisMonthUsd,
      limits,
    }
  }

  return { allowed: true, spentTodayUsd, spentThisMonthUsd, limits }
}
