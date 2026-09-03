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
    const tenantId = searchParams.get('tenantId') || undefined

    const where = {
      ...(tenantId ? { agent: { tenantId } } : {}),
      ...(search ? {
        OR: [
          { agent: { name: { contains: search, mode: 'insensitive' as const } } },
        ],
      } : {}),
    }

    const [runtimes, total] = await Promise.all([
      prisma.deployment.findMany({
        where,
        include: {
          agent: { select: { name: true, tenantId: true, tenant: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.deployment.count({ where }),
    ])

    return NextResponse.json({
      runtimes,
      meta: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    console.error('Operator runtimes error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}