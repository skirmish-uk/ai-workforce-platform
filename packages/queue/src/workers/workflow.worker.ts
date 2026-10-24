import { Worker } from 'bullmq'
import { executeWorkflow } from '@ai-workforce/executor'
import { getRedisConnection } from '../connection'
import type { WorkflowRunJobData } from '../queues'

export function createWorkflowWorker(): Worker<WorkflowRunJobData> {
  return new Worker<WorkflowRunJobData>(
    'workflow-run',
    async (job) => executeWorkflow(job.data.workflowRunId),
    { connection: getRedisConnection(), concurrency: 3 }
  )
}
