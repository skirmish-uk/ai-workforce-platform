import { Worker } from 'bullmq'
import { learnFromWebsite } from '@ai-workforce/executor'
import { getRedisConnection } from '../connection'
import type { WebsiteImportJobData } from '../queues'

/** Reads a business's website and drafts its profile for review (docs/ONBOARDING_WEBSITE.md). */
export function createWebsiteWorker(): Worker<WebsiteImportJobData> {
  return new Worker<WebsiteImportJobData>('website-import', async (job) => learnFromWebsite(job.data.importId), { connection: getRedisConnection(), concurrency: 2 })
}
