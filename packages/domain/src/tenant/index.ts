import { prisma } from '@ai-workforce/db'
import { UserRole } from '@prisma/client'
import { z } from 'zod'

export interface TenantContext {
  tenantId: string
  userId: string
  role: UserRole
  tenantSlug: string
}

export interface TenantWithRelations {
  id: string
  name: string
  slug: string
  industry: string | null
  geography: string | null
  settings: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  _count?: {
    users: number
    agents: number
    skills: number
    workflows: number
  }
}

export const createTenantSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  industry: z.string().optional(),
  geography: z.string().optional(),
})

export const updateTenantSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  industry: z.string().optional(),
  geography: z.string().optional(),
  settings: z.record(z.unknown()).optional(),
})

export type CreateTenantInput = z.infer<typeof createTenantSchema>
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>

export async function createTenant(data: CreateTenantInput, actorId: string) {
  const existing = await prisma.tenant.findUnique({ where: { slug: data.slug } })
  if (existing) {
    throw new Error('Tenant slug already exists')
  }

  const tenant = await prisma.tenant.create({
    data: {
      name: data.name,
      slug: data.slug,
      industry: data.industry,
      geography: data.geography,
    },
  })

  await prisma.auditLog.create({
    data: {
      action: 'TENANT_CREATE',
      entityType: 'Tenant',
      entityId: tenant.id,
      tenantId: tenant.id,
      userId: actorId,
      newData: tenant,
    },
  })

  return tenant
}

export async function getTenantById(tenantId: string) {
  return prisma.tenant.findUnique({
    where: { id: tenantId },
  })
}

export async function getTenantBySlug(slug: string) {
  return prisma.tenant.findUnique({
    where: { slug },
  })
}

export async function listTenants(options: {
  page?: number
  pageSize?: number
  search?: string
} = {}) {
  const { page = 1, pageSize = 20, search } = options
  const where = search
    ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          { slug: { contains: search, mode: 'insensitive' as const } },
        ],
      }
    : {}

  const [tenants, total] = await Promise.all([
    prisma.tenant.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        _count: {
          select: { users: true, agents: true, skills: true, workflows: true },
        },
      },
    }),
    prisma.tenant.count({ where }),
  ])

  return {
    data: tenants,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}

export async function updateTenant(tenantId: string, data: UpdateTenantInput, actorId: string) {
  const oldTenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
  if (!oldTenant) throw new Error('Tenant not found')

  const tenant = await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      ...data,
      settings: data.settings as any,
    },
  })

  await prisma.auditLog.create({
    data: {
      action: 'TENANT_UPDATE',
      entityType: 'Tenant',
      entityId: tenantId,
      tenantId: tenantId,
      userId: actorId,
      oldData: oldTenant as any,
      newData: tenant as any,
    },
  })

  return tenant
}

export async function deleteTenant(tenantId: string, actorId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
  if (!tenant) throw new Error('Tenant not found')

  await prisma.tenant.delete({ where: { id: tenantId } })

  await prisma.auditLog.create({
    data: {
      action: 'TENANT_DELETE',
      entityType: 'Tenant',
      entityId: tenantId,
      tenantId: tenantId,
      userId: actorId,
      oldData: tenant,
    },
  })

  return { success: true }
}

export async function getTenantStats(tenantId: string) {
  const [users, agents, skills, workflows, integrations, subscription] = await Promise.all([
    prisma.user.count({ where: { tenantId } }),
    prisma.agent.count({ where: { tenantId, isCandidate: false } }),
    prisma.skill.count({ where: { tenantId } }),
    prisma.workflow.count({ where: { tenantId } }),
    prisma.integration.count({ where: { tenantId, isActive: true } }),
    prisma.subscription.findFirst({ where: { tenantId } }),
  ])

  return { users, agents, skills, workflows, integrations, subscription }
}