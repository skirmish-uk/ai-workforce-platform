/**
 * Deploys every demo agent that isn't live yet, through the same validation gate as the
 * Deploy button (contract, playbooks with owners and test cases, registered tools, model key;
 * evaluation evidence for limited/expanded autonomy), so the team shows as Production.
 * Runs in this process, so no worker is needed. `npm run demo:reset` calls it after reseeding.
 *
 *   npm run demo:deploy
 *
 * Deploying changes no permissions or autonomy: every agent stays at its contract's stage.
 */
import { config } from 'dotenv'
import path from 'node:path'
const loaded = config({ path: path.resolve(__dirname, '../.env') })
for (const [key, value] of Object.entries(loaded.parsed ?? {})) {
  if (process.env[key] === '' && value !== '') process.env[key] = value
}

import { prisma } from '@ai-workforce/db'

const TENANT_SLUG = 'demo-agency'

/** Returns how many agents were deployed and the ones the gate refused, with why. */
export async function deployDemoTeam(): Promise<{ deployed: string[]; failed: Array<{ name: string; error: string }> }> {
  const queue = await import('@ai-workforce/queue')
  const agents = await prisma.agent.findMany({
    where: { tenant: { slug: TENANT_SLUG }, isCandidate: false, status: { in: ['DRAFT', 'EVALUATING'] } },
    orderBy: { id: 'asc' },
    select: { id: true, name: true },
  })
  const deployed: string[] = []
  const failed: Array<{ name: string; error: string }> = []
  try {
    for (const agent of agents) {
      const result = await queue.deployAgentNow(agent.id, 'demo team deployment (scripts/deploy-demo-team.ts)')
      if (result.error) failed.push({ name: agent.name, error: result.error })
      else deployed.push(agent.name)
    }
  } finally {
    // Importing the queue package opens a Redis client; quit it so the script exits.
    await queue.getRedisConnection().quit().catch(() => undefined)
  }
  return { deployed, failed }
}

if (require.main === module) {
  deployDemoTeam()
    .then(({ deployed, failed }) => {
      for (const name of deployed) console.log(`  ✓ ${name}`)
      for (const f of failed) console.log(`  ✗ ${f.name}: ${f.error}`)
      console.log(deployed.length || failed.length ? `Deployed ${deployed.length}, refused ${failed.length}.` : 'Every demo agent is already live.')
      process.exit(failed.length ? 1 : 0)
    })
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
