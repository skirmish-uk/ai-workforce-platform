import { Worker } from 'bullmq'
import { runAgent } from '@ai-workforce/executor'
import { getRedisConnection } from '../connection'
import { isAgentRunCancelled, type AgentRunJobData } from '../queues'

export function createAgentWorker(): Worker<AgentRunJobData> {
  return new Worker<AgentRunJobData>(
    'agent-run',
    async (job) =>
      runAgent(job.data.agentId, job.data.input, {
        // run id == job id, so the API's jobId traces straight to the audit trail.
        runId: job.id,
        userId: job.data.userId,
        workflowRunId: job.data.workflowRunId,
        trigger: job.data.trigger ?? 'api',
        isCancelled: () => (job.id ? isAgentRunCancelled(job.id) : false),
      }),
    { connection: getRedisConnection(), concurrency: 5 }
  )
}
