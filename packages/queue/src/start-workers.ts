import './load-env'
import { globalWatchdog } from '@ai-workforce/monitoring'
import { createAgentWorker } from './workers/agent.worker'
import { createApprovalWorker } from './workers/approval.worker'
import { createDeploymentWorker } from './workers/deployment.worker'
import { createEmbedWorker } from './workers/embed.worker'
import { createEvaluationWorker } from './workers/evaluation.worker'
import { createRevisionWorker } from './workers/revision.worker'
import { createWorkflowWorker } from './workers/workflow.worker'
import { createWebsiteWorker } from './workers/website.worker'
import { startScheduler } from './scheduler'

/**
 * Standalone worker process. Run with `npm run start --workspace @ai-workforce/queue`
 * (or `npx tsx packages/queue/src/start-workers.ts`) alongside the Next.js app —
 * per CLAUDE.md design decision #1, agent/workflow execution is async and must
 * never run inline in an API route.
 */
async function main(): Promise<void> {
  if (/^(1|true|yes|on)$/i.test(process.env.AGENTS_DISABLED ?? '')) {
    console.warn('AGENTS_DISABLED is set: every agent run will be refused with status "blocked" (kill switch).')
  }

  const workers = [
    createAgentWorker(),
    createWorkflowWorker(),
    createEmbedWorker(),
    createDeploymentWorker(),
    createApprovalWorker(),
    createEvaluationWorker(),
    createRevisionWorker(),
    createWebsiteWorker(),
  ]

  for (const worker of workers) {
    worker.on('failed', (job, err) => {
      console.error(`[${worker.name}] job ${job?.id ?? 'unknown'} failed:`, err)
    })
  }

  globalWatchdog.startMonitoring()
  const schedulerHandle = startScheduler()

  console.log(
    `AI Workforce workers started: ${workers.map((w) => w.name).join(', ')}. Scheduler polling every 60s (also expires stale approvals, queues proposed revisions and watches promoted ones).`
  )

  const shutdown = async () => {
    console.log('Shutting down workers...')
    clearInterval(schedulerHandle)
    globalWatchdog.stopMonitoring()
    await Promise.all(workers.map((worker) => worker.close()))
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('Failed to start workers:', error)
  process.exit(1)
})
