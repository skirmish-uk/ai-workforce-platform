import { Worker } from 'bullmq'
import { prisma } from '@ai-workforce/db'
import { createLLMClient, LLMConfigError } from '@ai-workforce/llm'
import { resolveEffectiveStage, validateAgentDefinition } from '@ai-workforce/executor'
import { agentHeartbeat, globalWatchdog, registerAgent } from '@ai-workforce/monitoring'
import { getRedisConnection } from '../connection'
import type { DeploymentJobData } from '../queues'

/**
 * There is no container/VM provisioning in this platform yet (see CLAUDE.md
 * Phase 8) — "deploying" an agent means: validate its config can actually run
 * (model provider configured, system prompt present), mark it PRODUCTION, and
 * register it with the Watchdog so every future runAgent() call reports a
 * heartbeat. The agent runtime IS the shared worker process; there is no
 * per-agent process to start or stop.
 */
async function runDeploy(deploymentId: string, agentId: string): Promise<void> {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })

  try {
    const skills = await prisma.agentSkill.findMany({ where: { agentId, enabled: true }, include: { skill: true } })
    const validation = validateAgentDefinition(
      agent,
      skills.filter((link) => link.skill.isActive).map((link) => link.skill),
      { forDeployment: true }
    )
    if (!validation.ok) {
      throw new Error(`Agent definition is not deployable:\n- ${validation.errors.join('\n- ')}`)
    }
    // Promotion to limited/expanded autonomy needs evaluation evidence for this exact version.
    const effective = await resolveEffectiveStage(agent, validation.contract)
    if (effective.capped) {
      throw new Error(`${effective.reason} Run an evaluation (POST /api/agents/${agentId}/evaluations) or deploy at approval_gated.`)
    }
    // Constructing the client validates the provider/model and that an API key is configured;
    // it makes no network call.
    createLLMClient(agent.modelProvider, agent.modelName)

    const warningLog = validation.warnings.length ? `\nWarnings:\n- ${validation.warnings.join('\n- ')}` : ''
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: 'running', deployedAt: new Date(), logs: `Deployment validated and activated (autonomy stage: ${effective.stage}).${warningLog}` },
    })
    await prisma.agent.update({
      where: { id: agentId },
      data: { status: 'PRODUCTION', deployedAt: new Date() },
    })

    registerAgent(agentId, agent.name, agent.tenantId)
    agentHeartbeat(agentId, { deploymentId })
  } catch (error) {
    const message = error instanceof LLMConfigError || error instanceof Error ? error.message : 'Deployment failed'
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: 'failed', logs: message },
    })
    await prisma.agent.update({ where: { id: agentId }, data: { status: 'DRAFT' } })
    throw error
  }
}

async function runRollback(deploymentId: string, agentId: string): Promise<void> {
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { status: 'rolled_back', rolledBackAt: new Date() },
  })

  const previousRunning = await prisma.deployment.findFirst({
    where: { agentId, status: 'running', id: { not: deploymentId } },
    orderBy: { version: 'desc' },
  })

  await prisma.agent.update({
    where: { id: agentId },
    data: { status: previousRunning ? 'PRODUCTION' : 'PAUSED' },
  })

  if (!previousRunning) {
    globalWatchdog.unregisterComponent(`agent_${agentId}`)
  }
}

export function createDeploymentWorker(): Worker<DeploymentJobData> {
  return new Worker<DeploymentJobData>(
    'deployment',
    async (job) => {
      if (job.data.action === 'deploy') {
        return runDeploy(job.data.deploymentId, job.data.agentId)
      }
      return runRollback(job.data.deploymentId, job.data.agentId)
    },
    { connection: getRedisConnection(), concurrency: 2 }
  )
}
