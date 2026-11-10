import { Worker } from 'bullmq'
import { indexDocument } from '@ai-workforce/knowledge'
import { getRedisConnection } from '../connection'
import type { EmbedDocumentJobData } from '../queues'

export function createEmbedWorker(): Worker<EmbedDocumentJobData> {
  return new Worker<EmbedDocumentJobData>(
    'embed-document',
    async (job) => indexDocument(job.data.documentId),
    { connection: getRedisConnection(), concurrency: 3 }
  )
}
