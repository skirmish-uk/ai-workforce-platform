import { CronExpressionParser } from 'cron-parser'
import { prisma } from '@ai-workforce/db'
import type { AgentStatus, Prisma, Schedule } from '@prisma/client'
import { expireStaleApprovals, findDueManagerReviews, notifyAgentActions, notifyPendingApprovals, findPendingRevisionIds, resolveAgentContract, watchPromotedRevisions } from '@ai-workforce/executor'
import { agentRunQueue, enqueueRevision, type AgentRunJobData } from './queues'

const POLL_INTERVAL_MS = 60_000

export type ScheduleWithAgent = Schedule & { agent: { status: AgentStatus; config: Prisma.JsonValue; mission: string } }

export interface SchedulerDeps {
  findSchedules: () => Promise<ScheduleWithAgent[]>
  /** Must be idempotent on jobId (BullMQ ignores an add whose jobId already exists). */
  enqueue: (data: AgentRunJobData, jobId: string) => Promise<void>
  /** Waiting/active/delayed runs already queued for this schedule. */
  inFlight: (scheduleId: string) => Promise<number>
  markHandled: (scheduleId: string, at: Date) => Promise<void>
}

export function defaultSchedulerDeps(): SchedulerDeps {
  return {
    findSchedules: () =>
      prisma.schedule.findMany({
        where: { isActive: true, agent: { isCandidate: false } },
        include: { agent: { select: { status: true, config: true, mission: true } } },
      }),
    enqueue: async (data, jobId) => {
      await agentRunQueue.add('scheduled-run', data, { jobId })
    },
    inFlight: async (scheduleId) => {
      const jobs = await agentRunQueue.getJobs(['active', 'waiting', 'delayed', 'prioritized'])
      return jobs.filter((job) => job?.data?.scheduleId === scheduleId).length
    },
    markHandled: async (scheduleId, at) => {
      await prisma.schedule.update({ where: { id: scheduleId }, data: { lastRunAt: at } })
    },
  }
}

export interface DispatchResult {
  dispatched: number
  skipped: Array<{ scheduleId: string; reason: string }>
}

/**
 * Checks every active Schedule and enqueues an agent run for each one whose
 * cron fired in the last poll window (cadence and timezone come from the
 * Schedule row). Per-agent contract rules (Agent.config.contract.schedule):
 *
 * - missedRunPolicy: a fire time that passed while no scheduler was running
 *   (detected via lastRunAt) is dropped ("skip", default) or run once ("run_once").
 * - maxConcurrentRuns: backpressure — no new run while that many are still queued/active.
 * - PAUSED/ARCHIVED agents and invalid contracts are never dispatched.
 *
 * A deterministic jobId (schedule id + fire minute) makes dispatch idempotent:
 * re-polling the same minute, or a second scheduler instance, cannot double-enqueue
 * while BullMQ retains the job. Scheduled runs go through the same runAgent
 * policy/approval path as every other run.
 */
export async function dispatchDueSchedules(now: Date = new Date(), deps: SchedulerDeps = defaultSchedulerDeps()): Promise<DispatchResult> {
  const schedules = await deps.findSchedules()
  const result: DispatchResult = { dispatched: 0, skipped: [] }
  const skip = (scheduleId: string, reason: string) => result.skipped.push({ scheduleId, reason })

  for (const schedule of schedules) {
    try {
      if (schedule.agent.status === 'PAUSED' || schedule.agent.status === 'ARCHIVED') {
        skip(schedule.id, `agent is ${schedule.agent.status}`)
        continue
      }
      const resolved = resolveAgentContract(schedule.agent)
      if (resolved.errors.length) {
        skip(schedule.id, 'agent contract is invalid')
        continue
      }
      const policy = resolved.contract.schedule

      const interval = CronExpressionParser.parse(schedule.cron, {
        currentDate: new Date(now.getTime() + 1000),
        tz: schedule.timezone,
      })
      const prevFire = interval.prev().toDate()
      const windowStart = new Date(now.getTime() - POLL_INTERVAL_MS)
      const dueNow = prevFire <= now && prevFire > windowStart
      const missed = !dueNow && schedule.lastRunAt !== null && prevFire > schedule.lastRunAt && prevFire <= windowStart

      if (!dueNow && !missed) continue
      if (missed && policy.missedRunPolicy === 'skip') {
        await deps.markHandled(schedule.id, now)
        skip(schedule.id, `missed fire at ${prevFire.toISOString()} dropped (missedRunPolicy=skip)`)
        continue
      }

      if ((await deps.inFlight(schedule.id)) >= policy.maxConcurrentRuns) {
        skip(schedule.id, `concurrency limit ${policy.maxConcurrentRuns} reached`)
        continue
      }

      // BullMQ rejects custom job IDs containing ":" (used as a Redis key delimiter internally).
      const jobId = `schedule-${schedule.id}-${Math.floor(prevFire.getTime() / POLL_INTERVAL_MS)}`
      await deps.enqueue(
        { agentId: schedule.agentId, input: JSON.stringify(schedule.payload ?? {}), trigger: 'schedule', scheduleId: schedule.id },
        jobId
      )
      await deps.markHandled(schedule.id, now)
      result.dispatched++
    } catch (error) {
      console.error(`Failed to evaluate schedule ${schedule.id} (cron="${schedule.cron}"):`, error)
      skip(schedule.id, 'evaluation error')
    }
  }

  return result
}

/** Hands PROPOSED revisions to the agent-revision worker (deterministic job id: no double enqueue). */
export async function dispatchRevisions(): Promise<number> {
  const ids = await findPendingRevisionIds()
  for (const revisionId of ids) await enqueueRevision({ revisionId })
  return ids.length
}

/** Starts an automatic manager review for each tenant whose agents crossed a problem threshold. */
export async function dispatchManagerReviews(now = new Date()): Promise<number> {
  const due = await findDueManagerReviews(now)
  for (const review of due) {
    await agentRunQueue.add(
      'manager-review',
      { agentId: review.managerId, input: review.input, trigger: 'event' },
      { jobId: `manager-review-${review.tenantId}-${Math.floor(now.getTime() / 60_000)}` }
    )
  }
  return due.length
}

const MANAGER_CHECK_INTERVAL_MS = 10 * 60_000
let lastManagerCheck = 0

export function startScheduler(intervalMs = POLL_INTERVAL_MS): NodeJS.Timeout {
  return setInterval(() => {
    dispatchDueSchedules().catch((error) => console.error('Scheduler tick failed:', error))
    expireStaleApprovals().catch((error) => console.error('Approval expiry sweep failed:', error))
    notifyPendingApprovals()
      .then((r) => r.approvals && console.log(`Approval emails: ${r.approvals} new approval(s), ${r.emailsSent} email(s) sent, ${r.skipped} skipped, ${r.failed} failed`))
      .catch((error) => console.error('Approval notification sweep failed:', error))
    notifyAgentActions()
      .then((r) => r.actions && console.log(`Action emails (NOTIFY level): ${r.actions} action(s), ${r.emailsSent} email(s) sent, ${r.skipped} skipped, ${r.failed} failed`))
      .catch((error) => console.error('Action notification sweep failed:', error))
    dispatchRevisions().catch((error) => console.error('Revision dispatch failed:', error))
    watchPromotedRevisions().catch((error) => console.error('Revision watch failed:', error))
    // Checking every tenant's metrics is heavier than the rest of the tick: every 10 minutes is enough.
    if (Date.now() - lastManagerCheck >= MANAGER_CHECK_INTERVAL_MS) {
      lastManagerCheck = Date.now()
      dispatchManagerReviews().catch((error) => console.error('Manager review dispatch failed:', error))
    }
  }, intervalMs)
}
