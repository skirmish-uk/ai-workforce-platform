import { z } from 'zod'
import { AUTONOMY_STAGES } from '@ai-workforce/tools'

/**
 * Tenant-level switch and limits for self-management (Tenant.settings.selfManagement).
 * Off by default: a tenant opts in, and only a human can change it
 * (PUT /api/tenants/[id]/self-management). No agent tool writes tenant settings.
 */
export const selfManagementPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * Hard ceiling on the autonomy stage any proposed revision may set, even with a
     * human approval. Raising an agent above this needs a direct human edit.
     */
    maxAutonomyStage: z.enum(AUTONOMY_STAGES).default('limited'),
    /** Runaway protection: proposals accepted per tenant per rolling 24 h. */
    maxRevisionsPerDay: z.number().int().min(1).max(100).default(10),
    /** Recent real inputs replayed against a candidate (dry run, live reads only). 0 disables replay. */
    replayRuns: z.number().int().min(0).max(20).default(5),
    /** Lifetime of the approval created for a risk-increasing revision. */
    approvalTtlHours: z.number().positive().max(720).default(72),
    /** Every agent gets platform__suggest_improvement, feeding the manager. */
    collectSuggestions: z.boolean().default(true),
    /** Post-promotion watch: automatic rollback if live metrics degrade. */
    watch: z
      .object({
        hours: z.number().positive().max(720).default(72),
        /** Minimum real runs since promotion before a verdict is reached. */
        minRuns: z.number().int().min(1).max(1000).default(5),
        /** Compared with the 7 days before promotion, when that window had runs. */
        maxDodPassRateDrop: z.number().min(0).max(1).default(0.15),
        maxFailureRateIncrease: z.number().min(0).max(1).default(0.15),
        /** Absolute floors used when there is no baseline (new agents, idle agents). */
        minDodPassRate: z.number().min(0).max(1).default(0.7),
        maxFailureRate: z.number().min(0).max(1).default(0.3),
      })
      .default({}),
  })
  .strict()

export type SelfManagementPolicy = z.infer<typeof selfManagementPolicySchema>

export function readSelfManagementPolicy(tenantSettings: unknown): { policy: SelfManagementPolicy; error?: string } {
  const raw =
    tenantSettings && typeof tenantSettings === 'object' ? (tenantSettings as Record<string, unknown>).selfManagement : undefined
  const parsed = selfManagementPolicySchema.safeParse(raw ?? {})
  if (parsed.success) return { policy: parsed.data }
  // An invalid policy fails closed: self-management stays off until a human fixes it.
  return {
    policy: selfManagementPolicySchema.parse({}),
    error: `Invalid Tenant.settings.selfManagement: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
  }
}
