import { prisma } from '@ai-workforce/db'
import { z } from 'zod'

export enum BillingInterval {
  MONTHLY = 'MONTHLY',
  YEARLY = 'YEARLY',
}

export enum PlanTier {
  STARTER = 'starter',
  GROWTH = 'growth',
  ENTERPRISE = 'enterprise',
}

export interface Plan {
  id: string
  name: string
  tier: PlanTier
  description: string
  priceMonthly: number // in cents
  priceYearly: number // in cents
  currency: string
  features: string[]
  limits: PlanLimits
  isActive: boolean
  stripePriceIdMonthly?: string
  stripePriceIdYearly?: string
  createdAt: Date
  updatedAt: Date
}

export interface PlanLimits {
  maxAgents: number
  maxWorkflows: number
  maxSkills: number
  maxKnowledgeDocuments: number
  maxIntegrations: number
  maxTeamMembers: number
  apiCallsPerMonth: number
  storageGB: number
  supportLevel: 'email' | 'priority' | 'dedicated'
  customIntegrations: boolean
  sso: boolean
  auditLogs: boolean
}

export const planSchema = z.object({
  name: z.string().min(1).max(100),
  tier: z.nativeEnum(PlanTier),
  description: z.string().min(10),
  priceMonthly: z.number().int().positive(),
  priceYearly: z.number().int().positive(),
  currency: z.string().length(3).default('AUD'),
  features: z.array(z.string()).default([]),
  limits: z.object({
    maxAgents: z.number().int().positive().default(1),
    maxWorkflows: z.number().int().positive().default(10),
    maxSkills: z.number().int().positive().default(5),
    maxKnowledgeDocuments: z.number().int().positive().default(100),
    maxIntegrations: z.number().int().positive().default(5),
    maxTeamMembers: z.number().int().positive().default(2),
    apiCallsPerMonth: z.number().int().positive().default(10000),
    storageGB: z.number().int().positive().default(1),
    supportLevel: z.enum(['email', 'priority', 'dedicated']).default('email'),
    customIntegrations: z.boolean().default(false),
    sso: z.boolean().default(false),
    auditLogs: z.boolean().default(false),
  }),
  isActive: z.boolean().default(true),
  stripePriceIdMonthly: z.string().optional(),
  stripePriceIdYearly: z.string().optional(),
})

export type CreatePlanInput = z.infer<typeof planSchema>

export const defaultPlans: Plan[] = [
  {
    id: 'plan_starter',
    name: 'Starter',
    tier: PlanTier.STARTER,
    description: 'Perfect for small teams getting started with AI automation',
    priceMonthly: 29900, // $299 AUD
    priceYearly: 299000, // $2,990 AUD (2 months free)
    currency: 'AUD',
    features: [
      '1 AI Agent',
      'Up to 10 workflows',
      '5 custom skills',
      '100 knowledge documents',
      '5 integrations',
      '2 team members',
      '10,000 API calls/month',
      '1 GB storage',
      'Email support',
    ],
    limits: {
      maxAgents: 1,
      maxWorkflows: 10,
      maxSkills: 5,
      maxKnowledgeDocuments: 100,
      maxIntegrations: 5,
      maxTeamMembers: 2,
      apiCallsPerMonth: 10000,
      storageGB: 1,
      supportLevel: 'email',
      customIntegrations: false,
      sso: false,
      auditLogs: false,
    },
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'plan_growth',
    name: 'Growth',
    tier: PlanTier.GROWTH,
    description: 'For growing teams needing more automation capacity',
    priceMonthly: 79900, // $799 AUD
    priceYearly: 799000, // $7,990 AUD
    currency: 'AUD',
    features: [
      'Up to 5 AI Agents',
      'Up to 50 workflows',
      '20 custom skills',
      '1,000 knowledge documents',
      '20 integrations',
      '10 team members',
      '100,000 API calls/month',
      '10 GB storage',
      'Priority email support',
      'Custom integrations',
    ],
    limits: {
      maxAgents: 5,
      maxWorkflows: 50,
      maxSkills: 20,
      maxKnowledgeDocuments: 1000,
      maxIntegrations: 20,
      maxTeamMembers: 10,
      apiCallsPerMonth: 100000,
      storageGB: 10,
      supportLevel: 'priority',
      customIntegrations: true,
      sso: false,
      auditLogs: true,
    },
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'plan_enterprise',
    name: 'Enterprise',
    tier: PlanTier.ENTERPRISE,
    description: 'For large organizations with advanced requirements',
    priceMonthly: 199900, // $1,999 AUD
    priceYearly: 1999000, // $19,990 AUD
    currency: 'AUD',
    features: [
      'Unlimited AI Agents',
      'Unlimited workflows',
      'Unlimited custom skills',
      'Unlimited knowledge documents',
      'Unlimited integrations',
      'Unlimited team members',
      'Unlimited API calls',
      'Unlimited storage',
      'Dedicated support',
      'Custom integrations',
      'SSO/SAML',
      'Full audit logs',
      'Custom SLA',
      'On-premise deployment option',
    ],
    limits: {
      maxAgents: -1, // unlimited
      maxWorkflows: -1,
      maxSkills: -1,
      maxKnowledgeDocuments: -1,
      maxIntegrations: -1,
      maxTeamMembers: -1,
      apiCallsPerMonth: -1,
      storageGB: -1,
      supportLevel: 'dedicated',
      customIntegrations: true,
      sso: true,
      auditLogs: true,
    },
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
]

export async function getActivePlans(): Promise<Plan[]> {
  return defaultPlans.filter(p => p.isActive)
}

export async function getPlanById(planId: string): Promise<Plan | null> {
  return defaultPlans.find(p => p.id === planId) || null
}

export async function getPlanByTier(tier: PlanTier): Promise<Plan | null> {
  return defaultPlans.find(p => p.tier === tier && p.isActive) || null
}