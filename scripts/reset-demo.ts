/**
 * Puts the demo tenant (demo-agency) back into a clean showcase state with one command:
 *
 *   npm run demo:reset                 # clear activity, keep the agents' tested upgrades
 *   npm run demo:reset -- --full       # delete the demo tenant and reseed from scratch
 *   npm run demo:reset -- --dry-run    # show what would be removed, change nothing
 *   npm run demo:reset -- --full --skip-embed   # don't call OpenAI to re-embed documents
 *
 * Default ("activity") reset removes everything a demo leaves behind: runs and their audit
 * trail, approvals, hand-offs, notification records, team cases, learned memories, workflow runs, open/failed revisions, sandbox candidates, queued jobs, and
 * anything created during the demo (agents, workflows, documents, users without a "demo-"
 * seed id). Promoted revisions stay, so Sarah keeps her current version and playbook and the
 * Improvements page keeps its history. The exception is Jordan, whose flaw is staged for the
 * self-repair moment: Jordan always goes back to the flawed version 1. Then the seed runs to
 * restore anything missing.
 *
 * --full deletes the whole demo tenant (and its playbooks), reseeds, and re-embeds the
 * knowledge documents when OPENAI_API_KEY is set. Agents go back to version 1, so upgrades
 * made by revisions are lost.
 *
 * Only ever touches the demo-agency tenant, and refuses to run against a non-local database
 * unless --allow-remote is passed. Clearing the audit trail also resets the tenant's spend
 * toward its cost cap.
 */
import { config } from 'dotenv'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const loaded = config({ path: path.resolve(__dirname, '../.env') })
// dotenv never overrides a variable that is already set, even to an empty string. Treat empty as unset.
for (const [key, value] of Object.entries(loaded.parsed ?? {})) {
  if (process.env[key] === '' && value !== '') process.env[key] = value
}

import { prisma } from '@ai-workforce/db'
import { restoreStagedFlaw } from '../packages/db/prisma/seed-showcase'

const TENANT_SLUG = 'demo-agency'
const SEEDED_USERS = ['admin@demo-agency.local', 'staff@demo-agency.local']
/** Revisions worth keeping after a reset: they describe how the current agents came to be. */
const KEPT_REVISION_STATUSES = ['PROMOTED', 'ROLLED_BACK']
const REMOVABLE_JOB_STATES = ['waiting', 'delayed', 'prioritized', 'waiting-children'] as const

const args = new Set(process.argv.slice(2))
const full = args.has('--full')
const dryRun = args.has('--dry-run')
const isSeeded = (id: string) => id.startsWith('demo-')

function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set (root .env).')
  const host = new URL(url).hostname
  if (!['localhost', '127.0.0.1', '::1', 'postgres'].includes(host) && !args.has('--allow-remote')) {
    throw new Error(`Refusing to reset a database on "${host}". This is for local demo databases; pass --allow-remote if you really mean it.`)
  }
}

function runSeed(): void {
  console.log('\n🌱 Reseeding...')
  const result = spawnSync('npx', ['tsx', 'prisma/seed.ts'], { cwd: path.resolve(__dirname, '../packages/db'), stdio: 'inherit', env: process.env })
  if (result.status !== 0) throw new Error('Seed failed; see the output above.')
}

/** Removes not-yet-started jobs that belong to the demo tenant, so nothing old runs after the reset. */
async function removeQueuedJobs(ids: { agents: Set<string>; workflowRuns: Set<string>; approvals: Set<string>; revisions: Set<string>; documents: Set<string> }): Promise<number> {
  let queue: typeof import('@ai-workforce/queue')
  try {
    queue = await import('@ai-workforce/queue')
  } catch (error) {
    console.warn(`  ! Skipped queued jobs: ${(error as Error).message}`)
    return 0
  }
  const belongs = (data: Record<string, unknown>) =>
    ids.agents.has(data.agentId as string) ||
    ids.workflowRuns.has(data.workflowRunId as string) ||
    ids.approvals.has(data.approvalId as string) ||
    ids.revisions.has(data.revisionId as string) ||
    ids.documents.has(data.documentId as string)
  const queues = [queue.agentRunQueue, queue.workflowRunQueue, queue.embedDocumentQueue, queue.deploymentQueue, queue.approvalExecuteQueue, queue.evaluationQueue, queue.revisionQueue]
  let removed = 0
  try {
    for (const q of queues) {
      for (const job of await q.getJobs([...REMOVABLE_JOB_STATES])) {
        if (!job || !belongs((job.data ?? {}) as unknown as Record<string, unknown>)) continue
        if (!dryRun) await job.remove()
        removed++
      }
    }
  } catch (error) {
    console.warn(`  ! Could not reach Redis to clear queued jobs: ${(error as Error).message}`)
  } finally {
    await Promise.all(queues.map((q) => q.close().catch(() => undefined)))
    // The queues share one Redis client that close() leaves open; quit it so the script exits.
    await queue.getRedisConnection().quit().catch(() => undefined)
  }
  return removed
}

async function main(): Promise<void> {
  assertLocalDatabase()
  const tenant = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } })
  if (!tenant) {
    console.log(`No "${TENANT_SLUG}" tenant yet.`)
    if (!dryRun) runSeed()
    return
  }
  const tenantId = tenant.id
  console.log(`${dryRun ? '[dry run] ' : ''}Resetting ${tenant.name} (${full ? 'full: delete and reseed' : 'activity only, upgrades kept'})...`)

  const [agents, workflowRuns, approvals, revisions, documents] = await Promise.all([
    prisma.agent.findMany({ where: { tenantId }, select: { id: true, isCandidate: true } }),
    prisma.workflowRun.findMany({ where: { tenantId }, select: { id: true } }),
    prisma.approval.findMany({ where: { tenantId }, select: { id: true } }),
    prisma.agentRevision.findMany({ where: { tenantId }, select: { id: true, status: true, agentId: true } }),
    prisma.knowledgeDocument.findMany({ where: { tenantId }, select: { id: true } }),
  ])
  const jobs = await removeQueuedJobs({
    agents: new Set(agents.map((a) => a.id)),
    workflowRuns: new Set(workflowRuns.map((r) => r.id)),
    approvals: new Set(approvals.map((a) => a.id)),
    revisions: new Set(revisions.map((r) => r.id)),
    documents: new Set(documents.map((d) => d.id)),
  })
  console.log(`  queued jobs removed: ${jobs}`)

  if (full) {
    const skills = await prisma.skill.count({ where: { tenantId } })
    console.log(`  tenant deleted with ${agents.length} agent(s), ${skills} playbook(s), ${documents.length} document(s) and all activity`)
    if (!dryRun) {
      // Playbooks are SetNull on tenant delete, so remove them explicitly first.
      await prisma.skill.deleteMany({ where: { tenantId } })
      await prisma.tenant.delete({ where: { id: tenantId } })
    }
  } else {
    const removableAgents = agents.filter((a) => a.isCandidate || !isSeeded(a.id)).map((a) => a.id)
    const keptAgents = agents.filter((a) => !removableAgents.includes(a.id)).map((a) => a.id)
    const removableRevisions = revisions.filter((r) => !KEPT_REVISION_STATUSES.includes(r.status) || !r.agentId || !keptAgents.includes(r.agentId)).map((r) => r.id)
    const steps: Array<[string, () => Promise<{ count: number }>, () => Promise<number>]> = [
      ['approvals', () => prisma.approval.deleteMany({ where: { tenantId } }), () => prisma.approval.count({ where: { tenantId } })],
      ['hand-offs to a person', () => prisma.handover.deleteMany({ where: { tenantId } }), () => prisma.handover.count({ where: { tenantId } })],
      ['notification records', () => prisma.notification.deleteMany({ where: { tenantId } }), () => prisma.notification.count({ where: { tenantId } })],
      ['team cases and their tasks', () => prisma.teamCase.deleteMany({ where: { tenantId } }), () => prisma.teamCase.count({ where: { tenantId } })],
      ['memories learned in demos (the seeded ones stay)', () => prisma.memory.deleteMany({ where: { tenantId, NOT: { id: { startsWith: 'demo-' } } } }), () => prisma.memory.count({ where: { tenantId, NOT: { id: { startsWith: 'demo-' } } } })],
      ['workflows (and their runs)', () => prisma.workflow.deleteMany({ where: { tenantId, NOT: { id: { startsWith: 'demo-' } } } }), () => prisma.workflow.count({ where: { tenantId, NOT: { id: { startsWith: 'demo-' } } } })],
      ['workflow runs', () => prisma.workflowRun.deleteMany({ where: { tenantId } }), () => prisma.workflowRun.count({ where: { tenantId } })],
      ['revisions (open, failed or for removed agents)', () => prisma.agentRevision.deleteMany({ where: { id: { in: removableRevisions } } }), async () => removableRevisions.length],
      ['agents created during demos and sandbox candidates', () => prisma.agent.deleteMany({ where: { id: { in: removableAgents } } }), async () => removableAgents.length],
      ['deployments', () => prisma.deployment.deleteMany({ where: { agentId: { in: keptAgents } } }), () => prisma.deployment.count({ where: { agentId: { in: keptAgents } } })],
      ['schedules added during demos', () => prisma.schedule.deleteMany({ where: { agentId: { in: keptAgents }, NOT: { id: { startsWith: 'demo-' } } } }), () => prisma.schedule.count({ where: { agentId: { in: keptAgents }, NOT: { id: { startsWith: 'demo-' } } } })],
      ['documents added during demos', () => prisma.knowledgeDocument.deleteMany({ where: { tenantId, NOT: { id: { startsWith: 'demo-' } } } }), () => prisma.knowledgeDocument.count({ where: { tenantId, NOT: { id: { startsWith: 'demo-' } } } })],
      ['incidents', () => prisma.incident.deleteMany({ where: { tenantId } }), () => prisma.incident.count({ where: { tenantId } })],
      ['change requests', () => prisma.changeRequest.deleteMany({ where: { tenantId } }), () => prisma.changeRequest.count({ where: { tenantId } })],
      ['users added during demos', () => prisma.user.deleteMany({ where: { tenantId, email: { notIn: SEEDED_USERS } } }), () => prisma.user.count({ where: { tenantId, email: { notIn: SEEDED_USERS } } })],
      ['audit rows (runs, tool calls, spend)', () => prisma.auditLog.deleteMany({ where: { tenantId } }), () => prisma.auditLog.count({ where: { tenantId } })],
    ]
    for (const [label, remove, count] of steps) {
      const n = dryRun ? await count() : (await remove()).count
      console.log(`  ${label}: ${n}`)
    }
    if (!dryRun) {
      // Back to the seeded operating state: agents in DRAFT (not paused or deployed), schedules off, kill switch off.
      await prisma.agent.updateMany({ where: { id: { in: keptAgents } }, data: { status: 'DRAFT' } })
      await prisma.schedule.updateMany({ where: { agentId: { in: keptAgents } }, data: { isActive: false } })
      const settings = { ...((tenant.settings ?? {}) as Record<string, unknown>) }
      delete settings.killSwitch
      await prisma.tenant.update({ where: { id: tenantId }, data: { settings: settings as object } })
      // Jordan's flaw is the self-repair moment: undo Morgan's fix so it can be shown again.
      const restored = await restoreStagedFlaw(prisma, tenantId)
      console.log(`  Jordan's staged flaw restored: ${restored.revisions} revision(s), ${restored.playbookVersions} playbook version(s) removed`)
    }
    console.log(`  kept: ${keptAgents.length} agent(s) at their current versions, ${revisions.length - removableRevisions.length} promoted/rolled-back revision(s)`)
  }

  if (dryRun) return
  runSeed()

  if (full) {
    const { isEmbeddingConfigured, indexDocument } = await import('@ai-workforce/knowledge')
    if (args.has('--skip-embed')) {
      console.log('Skipped embedding (--skip-embed): run scripts/reindex-knowledge.ts later for semantic search.')
    } else if (isEmbeddingConfigured()) {
      const docs = await prisma.knowledgeDocument.findMany({ where: { tenant: { slug: TENANT_SLUG }, chunkCount: 0 }, select: { id: true } })
      for (const doc of docs) await indexDocument(doc.id)
      console.log(`Embedded ${docs.length} knowledge document(s) for semantic search.`)
    } else {
      console.log('OPENAI_API_KEY not set: knowledge search will use keyword matching.')
    }
  }
  console.log('\n✅ Demo reset. Restart the worker if it was running during the reset.')
}

main()
  .catch((error) => {
    console.error('❌ Reset failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
