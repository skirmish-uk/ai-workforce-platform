import { prisma } from '@ai-workforce/db'
import { enqueueDeployment } from './queues'

/**
 * Starts a deployment the same way POST /api/agents/[id]/deploy does (Deployment row,
 * EVALUATING, audit, deployment job). Used when the revision pipeline promotes a newly
 * created agent; the deployment worker still runs its own validation gate.
 */
export async function startAgentDeployment(agentId: string, reason: string): Promise<string> {
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
  await enqueueDeployment({ deploymentId: deployment.id, agentId, action: 'deploy' })
  return deployment.id
}
