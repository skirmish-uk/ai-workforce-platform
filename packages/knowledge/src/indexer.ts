import { randomUUID } from 'node:crypto'
import { prisma } from '@ai-workforce/db'
import { chunkText } from './chunker'
import { embedTexts, isEmbeddingConfigured } from './embedder'

export interface IndexDocumentResult {
  chunkCount: number
  skipped: boolean
  reason?: string
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

/**
 * (Re-)chunks and (re-)embeds a KnowledgeDocument, replacing any previously
 * indexed chunks. Best-effort: if no OpenAI key is configured, the document
 * stays searchable only via the SQL LIKE fallback in searchKnowledge().
 */
export async function indexDocument(documentId: string): Promise<IndexDocumentResult> {
  if (!isEmbeddingConfigured()) {
    return { chunkCount: 0, skipped: true, reason: 'OPENAI_API_KEY not configured' }
  }

  const document = await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: documentId } })
  const chunks = chunkText(document.content)

  await prisma.$executeRaw`DELETE FROM "KnowledgeChunk" WHERE "documentId" = ${documentId}`

  if (!chunks.length) {
    await prisma.knowledgeDocument.update({ where: { id: documentId }, data: { chunkCount: 0 } })
    return { chunkCount: 0, skipped: false }
  }

  const embeddings = await embedTexts(chunks.map((chunk) => chunk.content))

  for (let i = 0; i < chunks.length; i++) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "KnowledgeChunk"
         (id, "chunkIndex", content, "tokenCount", metadata, embedding, "documentId", "tenantId", "createdAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector, $7, $8, now())`,
      randomUUID(),
      chunks[i].index,
      chunks[i].content,
      Math.round(chunks[i].content.length / 4),
      '{}',
      toVectorLiteral(embeddings[i]),
      documentId,
      document.tenantId
    )
  }

  await prisma.knowledgeDocument.update({ where: { id: documentId }, data: { chunkCount: chunks.length } })
  return { chunkCount: chunks.length, skipped: false }
}

export async function deleteDocumentChunks(documentId: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "KnowledgeChunk" WHERE "documentId" = ${documentId}`
}
