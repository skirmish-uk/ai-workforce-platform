/**
 * Embeds knowledge documents for semantic search (pgvector). Documents uploaded through the
 * dashboard are indexed by the embed-document worker; seeded documents are not, so run this
 * once after adding OPENAI_API_KEY:
 *
 *   npx tsx scripts/reindex-knowledge.ts            # documents with no chunks yet
 *   npx tsx scripts/reindex-knowledge.ts --all      # every document (e.g. after changing chunking)
 *
 * Costs a small amount of OpenAI embedding usage. Uses DATABASE_URL from the root .env.
 */
import { config } from 'dotenv'
import path from 'node:path'
const loaded = config({ path: path.resolve(__dirname, '../.env') })
// dotenv never overrides a variable that is already set, even to an empty string, so an empty
// OPENAI_API_KEY exported by the shell would hide the real one in .env. Treat empty as unset.
for (const [key, value] of Object.entries(loaded.parsed ?? {})) {
  if (process.env[key] === '' && value !== '') process.env[key] = value
}

import { prisma } from '@ai-workforce/db'
import { indexDocument, isEmbeddingConfigured } from '@ai-workforce/knowledge'

async function main(): Promise<void> {
  if (!isEmbeddingConfigured()) throw new Error('OPENAI_API_KEY is not set in the root .env; nothing to do.')
  const all = process.argv.includes('--all')
  const docs = await prisma.knowledgeDocument.findMany({ where: all ? {} : { chunkCount: 0 }, select: { id: true, title: true } })
  console.log(`Indexing ${docs.length} document(s)${all ? '' : ' without chunks'}...`)
  for (const doc of docs) {
    await indexDocument(doc.id)
    console.log(`  ✓ ${doc.title}`)
  }
}

main()
  .catch((error) => {
    console.error(`✖ ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
