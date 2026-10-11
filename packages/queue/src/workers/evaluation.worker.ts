import { Worker } from 'bullmq'
import { runEvaluation } from '@ai-workforce/executor'
import { getRedisConnection } from '../connection'
import type { EvaluationJobData } from '../queues'

/** Dry-run evaluation suite (real model calls, simulated tools). Concurrency 1 to bound spend. */
export function createEvaluationWorker(): Worker<EvaluationJobData> {
  return new Worker<EvaluationJobData>('agent-evaluation', async (job) => runEvaluation(job.data.agentId), {
    connection: getRedisConnection(),
    concurrency: 1,
  })
}
