import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const tenantId = session.user.tenantId
    const userRole = session.user.role as UserRole

    if (!hasPermission(userRole, 'tenant:read')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const onboarding = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        industry: true,
        geography: true,
        settings: true,
        createdAt: true,
      },
    })

    if (!onboarding) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 })
    }

    return NextResponse.json(onboarding)
  } catch (error) {
    console.error('Error fetching onboarding:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const tenantId = session.user.tenantId
    const userRole = session.user.role as UserRole

    if (!hasPermission(userRole, 'tenant:write')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (!canAccessTenant(userRole, session.user.tenantId, tenantId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const { step, data } = body

    const updateData: Record<string, unknown> = {}

    switch (step) {
      case 1: { // Business Profile
        updateData.industry = data.industry
        updateData.geography = data.geography
        const existingTenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } })
        const existingSettings = (existingTenant?.settings as Record<string, unknown>) || {}
        updateData.settings = {
          ...existingSettings,
          businessProfile: {
            companySize: data.companySize,
            services: data.services,
            targetCustomers: data.targetCustomers,
            painPoints: data.painPoints,
            currentSoftware: data.currentSoftware,
            existingSOPs: data.existingSOPs,
            complianceRequirements: data.complianceRequirements,
          },
        }
        break
      }
      case 2: { // Goals
        const tenantForGoals = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } })
        const existingSettings = (tenantForGoals?.settings as Record<string, unknown>) || {}
        updateData.settings = {
          ...existingSettings,
          goals: data.goals,
        }
        break
      }
      case 3: { // Workflow Selection
        const tenantForWorkflows = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } })
        const existingSettings2 = (tenantForWorkflows?.settings as Record<string, unknown>) || {}
        updateData.settings = {
          ...existingSettings2,
          selectedWorkflows: data.workflows,
        }
        break
      }
      case 4: { // Knowledge Upload
        const tenantForKnowledge = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } })
        const existingSettings3 = (tenantForKnowledge?.settings as Record<string, unknown>) || {}
        updateData.settings = {
          ...existingSettings3,
          knowledgeUploaded: true,
        }
        break
      }
      case 5: { // Integration Checklist
        const tenantForIntegrations = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } })
        const existingSettings4 = (tenantForIntegrations?.settings as Record<string, unknown>) || {}
        updateData.settings = {
          ...existingSettings4,
          integrationsConfigured: data.integrations,
        }
        break
      }
      default:
        return NextResponse.json({ error: 'Invalid step' }, { status: 400 })
    }

    const tenant = await prisma.tenant.update({
      where: { id: tenantId },
      data: updateData,
    })

    await prisma.auditLog.create({
      data: {
        action: 'ONBOARDING_UPDATE',
        entityType: 'Tenant',
        entityId: tenantId,
        tenantId,
        userId: session.user.id,
        metadata: { step, data },
      },
    })

    return NextResponse.json({ success: true, tenant })
  } catch (error) {
    console.error('Error updating onboarding:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}