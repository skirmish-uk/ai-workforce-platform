import { prisma } from '@ai-workforce/db'
import { embedText, isEmbeddingConfigured } from './embedder'

export interface KnowledgeSearchResult {
  chunkId: string
  documentId: string
  documentTitle: string
  content: string
  /** 1 - cosine distance; higher is more relevant. */
  score: number
}

interface RawSearchRow {
  id: string
  documentId: string
  content: string
  title: string
  distance: number
}

/**
 * Semantic search over a tenant's knowledge chunks via pgvector cosine
 * distance, optionally scoped to the documents attached to one agent.
 * Returns [] (never throws) when embeddings aren't configured, so callers
 * can fall back to keyword search.
 */
export async function searchKnowledge(params: {
  tenantId: string
  query: string
  agentId?: string
  topK?: number
}): Promise<KnowledgeSearchResult[]> {
  const { tenantId, query, agentId, topK = 5 } = params
  if (!isEmbeddingConfigured() || !query.trim()) return []

  const embedding = await embedText(query)
  const vectorLiteral = `[${embedding.join(',')}]`

  const rows = agentId
    ? await prisma.$queryRaw<RawSearchRow[]>`
        SELECT c.id, c."documentId", c.content, d.title, (c.embedding <=> ${vectorLiteral}::vector) AS distance
        FROM "KnowledgeChunk" c
        JOIN "KnowledgeDocument" d ON d.id = c."documentId"
        JOIN "AgentKnowledgeSource" s ON s."documentId" = c."documentId" AND s."agentId" = ${agentId}
        WHERE c."tenantId" = ${tenantId} AND c.embedding IS NOT NULL
        ORDER BY distance ASC
        LIMIT ${topK}
      `
    : await prisma.$queryRaw<RawSearchRow[]>`
        SELECT c.id, c."documentId", c.content, d.title, (c.embedding <=> ${vectorLiteral}::vector) AS distance
        FROM "KnowledgeChunk" c
        JOIN "KnowledgeDocument" d ON d.id = c."documentId"
        WHERE c."tenantId" = ${tenantId} AND c.embedding IS NOT NULL
        ORDER BY distance ASC
        LIMIT ${topK}
      `

  return rows.map((row) => ({
    chunkId: row.id,
    documentId: row.documentId,
    documentTitle: row.title,
    content: row.content,
    score: 1 - row.distance,
  }))
}

/**
 * Keyword fallback used when no OPENAI_API_KEY is configured, so knowledge
 * search still works end-to-end in an un-keyed demo environment.
 */
export async function searchKnowledgeKeyword(params: {
  tenantId: string
  query: string
  limit?: number
}): Promise<Array<{ id: string; title: string; content: string; contentType: string }>> {
  const { tenantId, query, limit = 5 } = params
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
  })
  return docs.map((doc) => ({ id: doc.id, title: doc.title, content: doc.content, contentType: doc.contentType }))
}
