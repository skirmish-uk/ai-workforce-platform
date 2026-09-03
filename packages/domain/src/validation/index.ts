import { z } from 'zod'
import { UserRole, AgentStatus, ApprovalLevel, SubscriptionStatus } from '@prisma/client'

export const userRoleSchema = z.nativeEnum(UserRole)
export const agentStatusSchema = z.nativeEnum(AgentStatus)
export const approvalLevelSchema = z.nativeEnum(ApprovalLevel)
export const subscriptionStatusSchema = z.nativeEnum(SubscriptionStatus)

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
})

export type PaginationInput = z.infer<typeof paginationSchema>

export const idParamSchema = z.object({
  id: z.string().cuid(),
})

export const tenantIdParamSchema = z.object({
  tenantId: z.string().cuid(),
})

export const userSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100).optional(),
  role: userRoleSchema.default('CUSTOMER_STAFF'),
  password: z.string().min(8).optional(),
})

export const createUserSchema = userSchema.extend({
  password: z.string().min(8),
  tenantId: z.string().cuid(),
})

export const updateUserSchema = userSchema.partial().extend({
  tenantId: z.string().cuid().optional(),
})

export type CreateUserInput = z.infer<typeof createUserSchema>
export type UpdateUserInput = z.infer<typeof updateUserSchema>

export const agentSchema = z.object({
  name: z.string().min(1).max(100),
  role: z.string().min(1).max(100),
  mission: z.string().min(10),
  systemPrompt: z.string().min(50),
  modelProvider: z.string().min(1),
  modelName: z.string().min(1),
  modelConfig: z.record(z.unknown()).default({}),
  status: agentStatusSchema.default('DRAFT'),
  config: z.record(z.unknown()).default({}),
  tenantId: z.string().cuid(),
  skills: z.array(z.string().cuid()).optional(),
})

export const createAgentSchema = agentSchema
export const updateAgentSchema = agentSchema.partial().omit({ tenantId: true })

export type CreateAgentInput = z.infer<typeof createAgentSchema>
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>

export const skillSchema = z.object({
  name: z.string().min(1).max(100),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(10),
  purpose: z.string().min(10),
  instructions: z.string().min(20),
  requiredTools: z.array(z.string()).default([]),
  inputs: z.record(z.unknown()).default({}),
  outputs: z.record(z.unknown()).default({}),
  constraints: z.array(z.string()).default([]),
  failureHandling: z.record(z.unknown()).default({}),
  evaluationCases: z.array(z.record(z.unknown())).default([]),
  metadata: z.record(z.unknown()).default({}),
  isActive: z.boolean().default(true),
  tenantId: z.string().cuid().optional(),
})

export const createSkillSchema = skillSchema
export const updateSkillSchema = skillSchema.partial().omit({ tenantId: true })

export type CreateSkillInput = z.infer<typeof createSkillSchema>
export type UpdateSkillInput = z.infer<typeof updateSkillSchema>

export const knowledgeDocumentSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(10),
  contentType: z.string().default('text/markdown'),
  metadata: z.record(z.unknown()).default({}),
  tenantId: z.string().cuid(),
})

export const createKnowledgeDocumentSchema = knowledgeDocumentSchema
export const updateKnowledgeDocumentSchema = knowledgeDocumentSchema.partial().omit({ tenantId: true })

export type CreateKnowledgeDocumentInput = z.infer<typeof createKnowledgeDocumentSchema>
export type UpdateKnowledgeDocumentInput = z.infer<typeof updateKnowledgeDocumentSchema>

export const workflowSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  trigger: z.record(z.unknown()).default({}),
  steps: z.array(z.record(z.unknown())).default([]),
  config: z.record(z.unknown()).default({}),
  retryPolicy: z.record(z.unknown()).default({ maxRetries: 3, backoffMs: 1000 }),
  timeout: z.number().int().positive().default(300),
  isActive: z.boolean().default(true),
  tenantId: z.string().cuid(),
  agentId: z.string().cuid().optional(),
})

export const createWorkflowSchema = workflowSchema
export const updateWorkflowSchema = workflowSchema.partial().omit({ tenantId: true })

export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>

export const integrationSchema = z.object({
  name: z.string().min(1).max(100),
  provider: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  credentials: z.record(z.unknown()).default({}),
  scopes: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  tenantId: z.string().cuid(),
})

export const createIntegrationSchema = integrationSchema
export const updateIntegrationSchema = integrationSchema.partial().omit({ tenantId: true })

export type CreateIntegrationInput = z.infer<typeof createIntegrationSchema>
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>

export const subscriptionSchema = z.object({
  plan: z.string().min(1),
  status: subscriptionStatusSchema.default('TRIAL'),
  currentPeriodStart: z.date(),
  currentPeriodEnd: z.date(),
  cancelAtPeriodEnd: z.boolean().default(false),
  metadata: z.record(z.unknown()).default({}),
  tenantId: z.string().cuid(),
})

export const createSubscriptionSchema = subscriptionSchema
export const updateSubscriptionSchema = subscriptionSchema.partial().omit({ tenantId: true })

export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>
export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>