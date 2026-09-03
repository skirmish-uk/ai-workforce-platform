import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@ai-workforce/db'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { IncidentStatus } from '@prisma/client'

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
    const statusParam = searchParams.get('status') || undefined

    const validStatuses: IncidentStatus[] = ['OPEN', 'INVESTIGATING', 'IDENTIFIED', 'RESOLVED', 'CLOSED']
    const status = validStatuses.includes(statusParam as IncidentStatus) ? statusParam as IncidentStatus : undefined

    const where = {
      ...(tenantId ? { tenantId } : {}),
      ...(status ? { status } : {}),
      ...(search ? {
        OR: [
          { title: { contains: search, mode: 'insensitive' as const } },
          { description: { contains: search, mode: 'insensitive' as const } },
        ],
      } : {}),
    }

    const [incidents, total] = await Promise.all([
      prisma.incident.findMany({
        where,
        include: {
          tenant: { select: { name: true } },
          assignee: { select: { name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.incident.count({ where }),
    ])

    return NextResponse.json({
      incidents,
      meta: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    console.error('Operator incidents error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}