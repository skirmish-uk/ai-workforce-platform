import { prisma } from '@ai-workforce/db'
import { Plan, PlanLimits, getPlanById, getPlanByTier, PlanTier } from './plans'

export interface EntitlementCheckResult {
  allowed: boolean
  reason?: string
  currentUsage?: number
  limit?: number
}

export interface TenantEntitlements {
  tenantId: string
  plan: Plan
  limits: PlanLimits
  currentUsage: UsageMetrics
}

export interface UsageMetrics {
  maxAgents: number
  maxWorkflows: number
  maxSkills: number
  maxKnowledgeDocuments: number
  maxIntegrations: number
  maxTeamMembers: number
  apiCallsPerMonth: number
  storageGB: number
}

export type MeasurableResource = 
  | 'maxAgents'
  | 'maxWorkflows'
  | 'maxSkills'
  | 'maxKnowledgeDocuments'
  | 'maxIntegrations'
  | 'maxTeamMembers'
  | 'apiCallsPerMonth'
  | 'storageGB'

export async function getTenantEntitlements(tenantId: string): Promise<TenantEntitlements | null> {
  const subscription = await prisma.subscription.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
  })

  if (!subscription) {
    // Check if tenant exists but has no subscription (trial or free)
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) return null

    // Default to starter plan limits for trial
    const starterPlan = await getPlanByTier(PlanTier.STARTER)
    if (!starterPlan) return null

    return {
      tenantId,
      plan: starterPlan,
      limits: starterPlan.limits,
      currentUsage: await getCurrentUsage(tenantId),
    }
  }

  // Get plan details from plan
  const plan = await getPlanById(subscription.plan)
  if (!plan) return null

  return {
    tenantId,
    plan,
    limits: plan.limits,
    currentUsage: await getCurrentUsage(tenantId),
  }
}

async function getCurrentUsage(tenantId: string): Promise<any> {
  const [
    agents,
    workflows,
    skills,
    knowledgeDocs,
    integrations,
    teamMembers,
  ] = await Promise.all([
    prisma.agent.count({ where: { tenantId } }),
    prisma.workflow.count({ where: { tenantId } }),
    prisma.skill.count({ where: { tenantId: { not: null } } }), // custom skills only
    prisma.knowledgeDocument.count({ where: { tenantId } }),
    prisma.integration.count({ where: { tenantId, isActive: true } }),
    prisma.user.count({ where: { tenantId } }),
  ])

  // TODO: Get actual API calls and storage usage from metrics
  return {
    maxAgents: agents,
    maxWorkflows: workflows,
    maxSkills: skills,
    maxKnowledgeDocuments: knowledgeDocs,
    maxIntegrations: integrations,
    maxTeamMembers: teamMembers,
    apiCallsPerMonth: 0, // TODO: Get from metrics
    storageGB: 0, // TODO: Get from storage metrics
  }
}

export async function checkEntitlement(
  tenantId: string,
  resource: MeasurableResource,
  quantity = 1
): Promise<EntitlementCheckResult> {
  const entitlements = await getTenantEntitlements(tenantId)
  if (!entitlements) {
    return { allowed: false, reason: 'No subscription found' }
  }

  const limit = entitlements.limits[resource]
  const currentUsage = entitlements.currentUsage[resource]

  // Unlimited (-1 means unlimited)
  if (limit === -1) {
    return { allowed: true, currentUsage, limit: -1 }
  }

  const newUsage = currentUsage + quantity
  const allowed = newUsage <= limit

  return {
    allowed,
    reason: allowed ? undefined : `Limit exceeded: ${newUsage}/${limit} ${resource}`,
    currentUsage,
    limit,
  }
}

export async function checkAndIncrementUsage(
  tenantId: string,
  resource: MeasurableResource,
  quantity = 1
): Promise<EntitlementCheckResult> {
  const check = await checkEntitlement(tenantId, resource, quantity)
  if (!check.allowed) return check

  // TODO: Actually increment usage counter in database
  // This would be a separate usage tracking table
  return { ...check, currentUsage: (check.currentUsage || 0) + quantity }
}

export async function getUsagePercentage(tenantId: string): Promise<Record<string, number>> {
  const entitlements = await getTenantEntitlements(tenantId)
  if (!entitlements) return {}

  const percentages: Record<string, number> = {}
  const limits = entitlements.limits
  const usage = entitlements.currentUsage

  // Only calculate percentages for measurable resources (those that exist in both limits and usage)
  const measurableKeys = [
    'maxAgents',
    'maxWorkflows',
    'maxSkills',
    'maxKnowledgeDocuments',
    'maxIntegrations',
    'maxTeamMembers',
    'apiCallsPerMonth',
    'storageGB',
  ] as const

  for (const key of measurableKeys) {
    const limit = limits[key]
    const current = usage[key]

    if (limit === -1) {
      percentages[key] = 0 // Unlimited
    } else if (limit === 0) {
      percentages[key] = 100 // No limit set
    } else {
      percentages[key] = Math.min(100, Math.round((current / limit) * 100))
    }
  }

  return percentages
}

export async function isFeatureEnabled(tenantId: string, feature: string): Promise<boolean> {
  const entitlements = await getTenantEntitlements(tenantId)
  if (!entitlements) return false

  const limits = entitlements.limits

  switch (feature) {
    case 'customIntegrations':
      return limits.customIntegrations === true
    case 'sso':
      return limits.sso === true
    case 'auditLogs':
      return limits.auditLogs === true
    case 'prioritySupport':
      return limits.supportLevel !== 'email'
    case 'dedicatedSupport':
      return limits.supportLevel === 'dedicated'
    default:
      return false
  }
}

export async function getUpgradeRecommendation(tenantId: string): Promise<{ recommended: boolean; reason?: string; suggestedTier?: string }> {
  const percentages = await getUsagePercentage(tenantId)
  if (!percentages || Object.keys(percentages).length === 0) {
    return { recommended: false }
  }

  const highUsage = Object.entries(percentages).filter(([, pct]) => pct >= 80)
  if (highUsage.length === 0) {
    return { recommended: false }
  }

  const subscription = await prisma.subscription.findFirst({
    where: { tenantId: tenantId as string },
    orderBy: { createdAt: 'desc' },
  })

  if (!subscription) return { recommended: true, reason: 'No active subscription' }

  const currentTier = subscription.plan
  const tiers = ['starter', 'growth', 'enterprise']
  const currentIndex = tiers.indexOf(currentTier)

  if (currentIndex >= tiers.length - 1) {
    return { recommended: false } // Already on highest tier
  }

  return {
    recommended: true,
    reason: `${highUsage.length} resource(s) at 80%+ capacity`,
    suggestedTier: tiers[currentIndex + 1],
  }
}