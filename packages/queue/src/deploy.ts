import { prisma } from '@ai-workforce/db'
import { enqueueDeployment } from './queues'
import { runDeploy } from './workers/deployment.worker'

/**
 * Starts a deployment the same way POST /api/agents/[id]/deploy does (Deployment row,
 * EVALUATING, audit, deployment job). Used when the revision pipeline promotes a newly
 * created agent; the deployment worker still runs its own validation gate.
 */
export async function startAgentDeployment(agentId: string, reason: string): Promise<string> {
  const deploymentId = await createDeployment(agentId, reason)
  await enqueueDeployment({ deploymentId, agentId, action: 'deploy' })
  return deploymentId
}

/**
 * Deploys in this process instead of the worker, through the same validation gate, for
 * scripts (the demo reset) that must not depend on a running worker. Returns the gate's
 * error instead of throwing; the agent is left in DRAFT when it fails.
 */
export async function deployAgentNow(agentId: string, reason: string): Promise<{ deploymentId: string; error?: string }> {
  const deploymentId = await createDeployment(agentId, reason)
  try {
    await runDeploy(deploymentId, agentId)
    return { deploymentId }
  } catch (error) {
    return { deploymentId, error: error instanceof Error ? error.message : String(error) }
  }
}

async function createDeployment(agentId: string, reason: string): Promise<string> {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
  const deployment = await prisma.deployment.create({
    data: { agentId, version: agent.version, config: agent.config as never, status: 'deploying' },
  })
  await prisma.agent.update({ where: { id: agentId }, data: { status: 'EVALUATING' } })
  await prisma.auditLog.create({
    data: {
      action: 'AGENT_DEPLOY_START',
      entityType: 'Deployment',
      entityId: deployment.id,
      tenantId: agent.tenantId,
      newData: { agentId, version: agent.version, reason },
    },
  })
  return deployment.id
}
