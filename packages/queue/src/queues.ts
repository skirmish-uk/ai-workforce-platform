import { Queue } from 'bullmq'
import { getRedisConnection } from './connection'

export interface AgentRunJobData {
  agentId: string
  input: string
  userId?: string
  workflowRunId?: string
  trigger?: 'api' | 'schedule' | 'manual' | 'voice' | 'event'
  scheduleId?: string
  /** Publish the model's text as it is written on this Redis channel (voice turns). */
  streamChannel?: string
  /** The dashboard conversation this run belongs to, and the person's own words in it. */
  conversation?: { id: string; message: string }
}

export interface WorkflowRunJobData {
  workflowRunId: string
}

export interface EmbedDocumentJobData {
  documentId: string
}

export interface DeploymentJobData {
  deploymentId: string
  agentId: string
  action: 'deploy' | 'rollback'
}

export interface ApprovalExecuteJobData {
  approvalId: string
}

export interface EvaluationJobData {
  agentId: string
  requestedById?: string
}

export interface RevisionJobData {
  revisionId: string
}

const connection = getRedisConnection()

export const agentRunQueue = new Queue<AgentRunJobData>('agent-run', { connection })
export const workflowRunQueue = new Queue<WorkflowRunJobData>('workflow-run', { connection })
export const embedDocumentQueue = new Queue<EmbedDocumentJobData>('embed-document', { connection })
export const deploymentQueue = new Queue<DeploymentJobData>('deployment', { connection })
export const approvalExecuteQueue = new Queue<ApprovalExecuteJobData>('approval-execute', { connection })
export const evaluationQueue = new Queue<EvaluationJobData>('agent-evaluation', { connection })
export const revisionQueue = new Queue<RevisionJobData>('agent-revision', { connection })

export async function enqueueAgentRun(data: AgentRunJobData) {
  return agentRunQueue.add('agent-run', data)
}

export async function enqueueWorkflowRun(data: WorkflowRunJobData, options: { resumeKey?: string } = {}) {
  // BullMQ rejects custom job IDs containing ":" (used as a Redis key delimiter internally).
  // A resume uses its own job id: the original id is still retained by BullMQ and would be deduplicated.
  const jobId = options.resumeKey ? `workflow-run-${data.workflowRunId}-resume-${options.resumeKey}` : `workflow-run-${data.workflowRunId}`
  return workflowRunQueue.add('workflow-run', data, { jobId })
}

export async function enqueueEmbedDocument(data: EmbedDocumentJobData) {
  return embedDocumentQueue.add('embed-document', data, { jobId: `embed-${data.documentId}` })
}

export async function enqueueDeployment(data: DeploymentJobData) {
  return deploymentQueue.add(data.action, data, { jobId: `deployment-${data.deploymentId}-${data.action}` })
}

/** One job per approval: a duplicate enqueue is ignored, and execution itself is also exactly-once. */
export async function enqueueApprovalExecution(data: ApprovalExecuteJobData) {
  return approvalExecuteQueue.add('approval-execute', data, { jobId: `approval-${data.approvalId}` })
}

export async function enqueueEvaluation(data: EvaluationJobData) {
  return evaluationQueue.add('agent-evaluation', data)
}

/** One job per revision (processing is also claimed exactly once in processRevision). */
export async function enqueueRevision(data: RevisionJobData) {
  return revisionQueue.add('agent-revision', data, { jobId: `revision-${data.revisionId}` })
}

/**
 * Waits for an agent run to finish (the voice route needs the answer within the request).
 * The run itself still executes in the worker, so policy, kill switches and the audit
 * trail are the same as for any other run. Polls job state; resolves with the job's
 * return value, or null on timeout (the run keeps going and is visible on the agent page).
 */
export async function waitForAgentRun<T = unknown>(jobId: string, timeoutMs = 45_000, pollMs = 250): Promise<{ state: 'completed'; result: T } | { state: 'failed'; reason: string } | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await agentRunQueue.getJob(jobId)
    if (!job) return { state: 'failed', reason: 'Run not found' }
    const state = await job.getState()
    if (state === 'completed') {
      // The job object was read before it finished, so its return value can still be missing:
      // read it again (this race crashed voice answers with "Error in input stream").
      const done = job.returnvalue ?? (await agentRunQueue.getJob(jobId))?.returnvalue
      if (done !== null && done !== undefined) return { state: 'completed', result: done as T }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      continue
    }
    if (state === 'failed') return { state: 'failed', reason: job.failedReason ?? 'Run failed' }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return null
}

const CANCEL_KEY_PREFIX = 'agent-run-cancel'
const CANCEL_TTL_SECONDS = 6 * 60 * 60

export function cancelKey(jobId: string): string {
  return `${CANCEL_KEY_PREFIX}-${jobId}`
}

/**
 * Cancels an agent run: a queued job is removed outright; an active job gets a
 * cancellation flag that runAgent checks between iterations and before every
 * tool call (it stops at the next safe point, never mid-tool-call).
 */
export async function requestAgentRunCancel(jobId: string): Promise<'removed' | 'flagged' | 'not_found' | 'already_finished'> {
  const job = await agentRunQueue.getJob(jobId)
  if (!job) return 'not_found'
  const state = await job.getState()
  if (state === 'completed' || state === 'failed') return 'already_finished'
  if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
    await job.remove()
    return 'removed'
  }
  await getRedisConnection().set(cancelKey(jobId), '1', 'EX', CANCEL_TTL_SECONDS)
  return 'flagged'
}

export async function isAgentRunCancelled(jobId: string): Promise<boolean> {
  return (await getRedisConnection().exists(cancelKey(jobId))) === 1
}
