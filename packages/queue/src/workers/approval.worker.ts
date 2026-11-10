import { Worker } from 'bullmq'
import { executeApprovedAction } from '@ai-workforce/executor'
import { getRedisConnection } from '../connection'
import { startAgentDeployment } from '../deploy'
import { enqueueWorkflowRun, type ApprovalExecuteJobData } from '../queues'

/**
 * Runs after a human approves: executes exactly the approved tool call or
 * promotes the approved agent revision (no-op for workflow-step approvals), then resumes the paused WorkflowRun, if any,
 * from its checkpoint.
 */
export function createApprovalWorker(): Worker<ApprovalExecuteJobData> {
  return new Worker<ApprovalExecuteJobData>(
    'approval-execute',
    async (job) => {
      const result = await executeApprovedAction(job.data.approvalId)
      // An approved revision that created a new agent: deploy it (the deployment worker re-validates).
      const deployAgentId = (result.output as { deployAgentId?: string } | null | undefined)?.deployAgentId
      if (result.status === 'EXECUTED' && deployAgentId) await startAgentDeployment(deployAgentId, `approval ${job.data.approvalId}`)
      if (result.workflowRunId) {
        await enqueueWorkflowRun({ workflowRunId: result.workflowRunId }, { resumeKey: job.data.approvalId })
      }
      return result
    },
    { connection: getRedisConnection(), concurrency: 2 }
  )
}
