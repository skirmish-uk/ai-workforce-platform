import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { enqueueEmbedDocument } from '@ai-workforce/queue'
import { UserRole } from '@prisma/client'

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

    if (!hasPermission(userRole, 'knowledge:read')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const where: Record<string, unknown> = { tenantId }
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { content: { contains: search, mode: 'insensitive' } },
      ]
    }

    const [documents, total] = await Promise.all([
      prisma.knowledgeDocument.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          _count: { select: { sources: true } },
        },
      }),
      prisma.knowledgeDocument.count({ where }),
    ])

    return NextResponse.json({
      data: documents,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    console.error('Error listing knowledge documents:', error)
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

    if (!hasPermission(userRole, 'knowledge:write')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const formData = await request.formData()
    const file = formData.get('file') as File
    const title = formData.get('title') as string

    if (!file || !title) {
      return NextResponse.json({ error: 'File and title are required' }, { status: 400 })
    }

    if (!canAccessTenant(userRole, session.user.tenantId, session.user.tenantId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const content = await file.text()
    const contentType = file.type || 'text/plain'

    const document = await prisma.knowledgeDocument.create({
      data: {
        title,
        content,
        contentType,
        metadata: { fileName: file.name, fileSize: file.size },
        tenantId: session.user.tenantId,
      },
    })

    await prisma.auditLog.create({
      data: {
        action: 'KNOWLEDGE_UPLOAD',
        entityType: 'KnowledgeDocument',
        entityId: document.id,
        tenantId: session.user.tenantId,
        userId: session.user.id,
        newData: { title: document.title, contentType: document.contentType },
      },
    })

    // Chunk + embed asynchronously; the document is searchable via keyword fallback
    // immediately, and semantically once the embed-document job completes.
    await enqueueEmbedDocument({ documentId: document.id })

    return NextResponse.json(document, { status: 201 })
  } catch (error) {
    console.error('Error uploading knowledge document:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}