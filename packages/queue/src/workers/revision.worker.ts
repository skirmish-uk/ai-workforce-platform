import { Worker } from 'bullmq'
import { processRevision } from '@ai-workforce/executor'
import { getRedisConnection } from '../connection'
import { startAgentDeployment } from '../deploy'
import type { RevisionJobData } from '../queues'

/**
 * Revision pipeline: sandbox → evaluation → replay → promote or request approval.
 * Concurrency 1: evaluations make real model calls, so this bounds spend.
 */
export function createRevisionWorker(): Worker<RevisionJobData> {
  return new Worker<RevisionJobData>(
    'agent-revision',
    async (job) => {
      const outcome = await processRevision(job.data.revisionId)
      if (outcome.deployAgentId) await startAgentDeployment(outcome.deployAgentId, `revision ${outcome.revisionId}`)
      return outcome
    },
    { connection: getRedisConnection(), concurrency: 1 }
  )
}
