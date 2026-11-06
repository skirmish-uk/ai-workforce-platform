import { z } from 'zod'

/**
 * USER.md mapping (brief §4): business/user context lives once per tenant in
 * `Tenant.settings.businessContext` and is shared by all of that tenant's
 * agents. Only job-relevant context belongs here — no credentials, and as
 * little personal data as possible. Missing facts are listed in `unknowns`
 * so agents ask instead of inventing them.
 */
export const businessContextSchema = z
  .object({
    description: z.string(),
    goals: z.array(z.string()),
    outputFormat: z.string(),
    communicationStyle: z.string(),
    terminology: z.array(z.object({ term: z.string(), meaning: z.string() })),
    productsAndServices: z.array(z.string()),
    policies: z.array(z.string()),
    stakeholders: z.array(z.object({ role: z.string(), priority: z.string().optional() })),
    processes: z.array(z.string()),
    constraints: z.array(z.string()),
    unknowns: z.array(z.string()),
  })
  .partial()
  .strict()

export type BusinessContext = z.infer<typeof businessContextSchema>

export function readBusinessContext(settings: unknown): { context: BusinessContext | null; error?: string } {
  if (!settings || typeof settings !== 'object') return { context: null }
  const raw = (settings as Record<string, unknown>).businessContext
  if (raw === undefined || raw === null) return { context: null }
  const parsed = businessContextSchema.safeParse(raw)
  if (!parsed.success) {
    return { context: null, error: `Tenant.settings.businessContext is invalid: ${parsed.error.issues[0]?.message ?? 'unknown error'}` }
  }
  return { context: parsed.data }
}

const list = (items: string[] | undefined) => (items?.length ? items.map((i) => `- ${i}`).join('\n') : undefined)

export function formatBusinessContext(context: BusinessContext | null): string {
  if (!context) {
    return 'No business context has been recorded for this organisation. Do not assume goals, policies, prices or terminology — ask when they matter.'
  }
  const sections: Array<[string, string | undefined]> = [
    ['About the business', context.description],
    ['Goals and priorities', list(context.goals)],
    ['Preferred output format', context.outputFormat],
    ['Communication style', context.communicationStyle],
    ['Approved terminology', context.terminology?.length ? context.terminology.map((t) => `- ${t.term}: ${t.meaning}`).join('\n') : undefined],
    ['Approved products and services', list(context.productsAndServices)],
    ['Policies', list(context.policies)],
    ['Stakeholders', context.stakeholders?.length ? context.stakeholders.map((s) => `- ${s.role}${s.priority ? ` (${s.priority})` : ''}`).join('\n') : undefined],
    ['Business processes', list(context.processes)],
    ['Constraints', list(context.constraints)],
    ['Known unknowns — ask, do not guess', list(context.unknowns)],
  ]
  return sections
    .filter(([, body]) => body && body.trim())
    .map(([title, body]) => `### ${title}\n${body}`)
    .join('\n\n')
}
