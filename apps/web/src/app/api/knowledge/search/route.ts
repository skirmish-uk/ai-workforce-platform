import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userRole = session.user.role as UserRole
    const tenantId = session.user.tenantId

    if (!hasPermission(userRole, 'knowledge:read')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const { query, limit = 5 } = body

    if (!query || typeof query !== 'string') {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 })
    }

    const docs = await prisma.knowledgeDocument.findMany({
      where: {
        tenantId,
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { content: { contains: query, mode: 'insensitive' } },
        ],
      },
      take: Math.min(limit, 20),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        content: true,
        contentType: true,
        metadata: true,
        createdAt: true,
      },
    })

    return NextResponse.json({
      results: docs.map(doc => ({
        id: doc.id,
        title: doc.title,
        content: doc.content.slice(0, 500),
        contentType: doc.contentType,
        metadata: doc.metadata,
        createdAt: doc.createdAt,
      })),
    })
  } catch (error) {
    console.error('Error searching knowledge:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}