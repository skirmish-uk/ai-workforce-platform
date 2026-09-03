import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'

async function checkDocAccess(session: { user: { id: string; role: string; tenantId: string } }, docId: string) {
  const doc = await prisma.knowledgeDocument.findUnique({ where: { id: docId } })
  if (!doc) throw new Error('NOT_FOUND')
  
  if (!canAccessTenant(session.user.role as UserRole, session.user.tenantId, doc.tenantId)) {
    throw new Error('FORBIDDEN')
  }
  return doc
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    await checkDocAccess(session, id)

    const doc = await prisma.knowledgeDocument.findUnique({
      where: { id },
      include: {
        sources: { include: { agent: { select: { id: true, name: true } } } },
      },
    })

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    return NextResponse.json(doc)
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }
    console.error('Error fetching document:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const doc = await checkDocAccess(session, id)

    const userRole = session.user.role as UserRole
    if (!hasPermission(userRole, 'knowledge:delete')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    await prisma.knowledgeDocument.delete({ where: { id } })

    await prisma.auditLog.create({
      data: {
        action: 'KNOWLEDGE_DELETE',
        entityType: 'KnowledgeDocument',
        entityId: id,
        tenantId: doc.tenantId,
        userId: session.user.id,
        oldData: doc,
      },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }
    console.error('Error deleting document:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}