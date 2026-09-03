import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@ai-workforce/db'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user || !['PLATFORM_ADMIN', 'PLATFORM_OPERATOR'].includes(session.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const searchParams = request.nextUrl.searchParams
    const page = parseInt(searchParams.get('page') || '1')
    const pageSize = parseInt(searchParams.get('pageSize') || '20')
    const search = searchParams.get('search') || ''

    const where = search ? {
      OR: [
        { name: { contains: search, mode: 'insensitive' as const } },
        { slug: { contains: search, mode: 'insensitive' as const } },
      ],
    } : {}

    const [tenants, total] = await Promise.all([
      prisma.tenant.findMany({
        where,
        include: {
          _count: {
            select: { users: true, agents: true },
          },
          subscriptions: {
            select: { status: true, plan: true },
            take: 1,
            orderBy: { createdAt: 'desc' },
          },
          invoices: {
            where: { status: 'PAID' },
            select: { amount: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.tenant.count({ where }),
    ])

    const tenantsWithRevenue = tenants.map((tenant) => ({
      ...tenant,
      monthlyRevenue: tenant.invoices[0]?.amount || 0,
    }))

    return NextResponse.json({
      tenants: tenantsWithRevenue,
      meta: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    console.error('Operator tenants error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user || session.user.role !== 'PLATFORM_ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { name, slug, industry, geography, settings } = body

    if (!name || !slug) {
      return NextResponse.json({ error: 'Name and slug are required' }, { status: 400 })
    }

    const existing = await prisma.tenant.findUnique({ where: { slug } })
    if (existing) {
      return NextResponse.json({ error: 'Slug already exists' }, { status: 400 })
    }

    const tenant = await prisma.tenant.create({
      data: {
        name,
        slug,
        industry,
        geography,
        settings: settings || {},
      },
    })

    return NextResponse.json(tenant, { status: 201 })
  } catch (error) {
    console.error('Create tenant error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}