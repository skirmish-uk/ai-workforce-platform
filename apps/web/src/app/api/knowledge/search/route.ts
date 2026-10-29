import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { hasPermission } from '@ai-workforce/domain'
import { isEmbeddingConfigured, searchKnowledge, searchKnowledgeKeyword } from '@ai-workforce/knowledge'
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
    const { query, limit = 5, agentId } = body

    if (!query || typeof query !== 'string') {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 })
    }

    if (isEmbeddingConfigured()) {
      const results = await searchKnowledge({ tenantId, query, agentId, topK: Math.min(limit, 20) })
      return NextResponse.json({
        mode: 'semantic',
        results: results.map((r) => ({
          documentId: r.documentId,
          title: r.documentTitle,
          content: r.content,
          score: r.score,
        })),
      })
    }

    // No OPENAI_API_KEY configured: fall back to keyword search so the feature still works.
    const docs = await searchKnowledgeKeyword({ tenantId, query, limit })
    return NextResponse.json({
      mode: 'keyword',
      results: docs.map((doc) => ({
        documentId: doc.id,
        title: doc.title,
        content: doc.content.slice(0, 500),
        contentType: doc.contentType,
      })),
    })
  } catch (error) {
    console.error('Error searching knowledge:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}