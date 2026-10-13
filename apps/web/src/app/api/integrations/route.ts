import { NextRequest, NextResponse } from 'next/server'
import { CredentialsKeyError, describeCredentials, encryptCredentials, isPlaceholderCredentials } from '@ai-workforce/tools'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'
import { createIntegrationSchema, paginationSchema } from '@ai-workforce/domain'

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const page = parseInt(searchParams.get('page') || '1')
    const pageSize = parseInt(searchParams.get('pageSize') || '20')
    const search = searchParams.get('search') || undefined
    const tenantId = session.user.tenantId

    const userRole = session.user.role as UserRole

    if (!hasPermission(userRole, 'integration:read')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const where: Record<string, unknown> = { tenantId }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { provider: { contains: search, mode: 'insensitive' } },
      ]
    }

    const [integrations, total] = await Promise.all([
      prisma.integration.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.integration.count({ where }),
    ])

    // Credentials never leave the server: callers only learn whether they exist.
    return NextResponse.json({
      data: integrations.map(({ credentials, ...rest }) => ({ ...rest, ...describeCredentials(credentials) })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    console.error('Error listing integrations:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userRole = session.user.role as UserRole

    if (!hasPermission(userRole, 'integration:write')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const validated = createIntegrationSchema.parse(body)

    if (!canAccessTenant(userRole, session.user.tenantId, validated.tenantId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const provided = (validated.credentials ?? {}) as Record<string, unknown>
    let credentials: unknown = provided
    try {
      // Real secrets are encrypted at rest; refuse to store them in plaintext.
      if (!isPlaceholderCredentials(provided)) credentials = encryptCredentials(provided, validated.tenantId)
    } catch (error) {
      if (error instanceof CredentialsKeyError) {
        return NextResponse.json({ error: 'Credentials cannot be stored: encryption is not configured on the server.' }, { status: 503 })
      }
      throw error
    }

    const created = await prisma.integration.create({
      data: {
        ...validated,
        config: validated.config as any,
        credentials: credentials as any,
      },
    })
    const { credentials: _stored, ...integration } = created
    const safe = { ...integration, ...describeCredentials(_stored) }

    await prisma.auditLog.create({
      data: {
        action: 'INTEGRATION_CREATE',
        entityType: 'Integration',
        entityId: integration.id,
        tenantId: validated.tenantId,
        userId: session.user.id,
        newData: safe as any,
      },
    })

    return NextResponse.json(safe, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json({ error: 'Validation error', details: error.message }, { status: 400 })
    }
    console.error('Error creating integration:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}