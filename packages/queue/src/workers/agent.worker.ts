import { Worker } from 'bullmq'
import { buildTaskInput, finishTask, runAgent, startTask } from '@ai-workforce/executor'
import { safeErrorMessage } from '@ai-workforce/domain'
import { getRedisConnection } from '../connection'
import { enqueueAgentTask, isAgentRunCancelled, type AgentRunJobData } from '../queues'

/** A hand-off queued a teammate's task: start it now rather than at the next scheduler sweep. */
function dispatch(task: { id: string; runId: string; agentId: string }): void {
  void enqueueAgentTask(task).catch((error) => console.error(`Could not queue task ${task.id}:`, safeErrorMessage(error)))
}

export function createAgentWorker(): Worker<AgentRunJobData> {
  return new Worker<AgentRunJobData>(
    'agent-run',
    async (job) => {
      if (job.data.taskId) {
        // A team-case task: claimed once, given the case so far as its input.
        if (!(await startTask(job.data.taskId))) return { skipped: true, reason: 'task is no longer queued' }
        const built = await buildTaskInput(job.data.taskId)
        if (!built) return { skipped: true, reason: 'task not found' }
        try {
          return await runAgent(built.agentId, built.input, {
            runId: job.id,
            trigger: 'handoff',
            task: built.task,
            isCancelled: () => (job.id ? isAgentRunCancelled(job.id) : false),
            onTaskQueued: dispatch,
          })
        } catch (error) {
          await finishTask(job.data.taskId, { status: 'failed', error: safeErrorMessage(error) }).catch(() => undefined)
          throw error
        }
      }
      return runAgent(job.data.agentId, job.data.input, {
        // run id == job id, so the API's jobId traces straight to the audit trail.
        runId: job.id,
        userId: job.data.userId,
        workflowRunId: job.data.workflowRunId,
        trigger: job.data.trigger ?? 'api',
        conversation: job.data.conversation,
        isCancelled: () => (job.id ? isAgentRunCancelled(job.id) : false),
        onTaskQueued: dispatch,
        // Voice: the web route is listening on this channel to speak each sentence as it lands.
        onTextDelta: job.data.streamChannel
          ? (delta, step) => { void getRedisConnection().publish(job.data.streamChannel!, JSON.stringify({ step, delta })).catch(() => undefined) }
          : undefined,
      })
    },
    { connection: getRedisConnection(), concurrency: 5 }
  )
}
