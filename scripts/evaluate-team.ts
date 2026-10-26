/**
 * Runs every demo agent's test suite against the real model (dry runs: nothing is sent or
 * changed) and records each result as an Evaluation, the evidence limited/expanded autonomy
 * needs. Jordan is skipped by default: he carries the staged flaw for the self-repair moment
 * (DEMO.md "Self-repair"), so his suite is meant to fail until Morgan fixes him.
 *
 *   npm run demo:evaluate                     # the whole team except Jordan
 *   npm run demo:evaluate -- demo-agent-1     # only these agents
 *   npm run demo:evaluate -- --include-staged # Jordan too
 *
 * Costs a few cents per agent (one model run per test case).
 */
import { config } from 'dotenv'
import path from 'node:path'
const loaded = config({ path: path.resolve(__dirname, '../.env') })
for (const [key, value] of Object.entries(loaded.parsed ?? {})) {
  if (process.env[key] === '' && value !== '') process.env[key] = value
}

import { prisma } from '@ai-workforce/db'
import { runEvaluation } from '@ai-workforce/executor'

const TENANT_SLUG = 'demo-agency'
const STAGED = ['demo-enquiries-1']

async function main() {
  const args = process.argv.slice(2)
  const only = args.filter((a) => !a.startsWith('--'))
  const includeStaged = args.includes('--include-staged')
  const agents = await prisma.agent.findMany({
    where: { tenant: { slug: TENANT_SLUG }, isCandidate: false, ...(only.length ? { id: { in: only } } : {}) },
    orderBy: { id: 'asc' },
    select: { id: true, name: true, version: true },
  })
  let failedAgents = 0
  for (const agent of agents) {
    if (!only.length && !includeStaged && STAGED.includes(agent.id)) {
      console.log(`- ${agent.name}: skipped (staged flaw for the self-repair demo)`)
      continue
    }
    const started = Date.now()
    const result = await runEvaluation(agent.id)
    const cost = result.results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
    const passedCases = result.results.filter((r) => r.passed).length
    console.log(`${result.passed ? '✓' : '✗'} ${agent.name} v${agent.version}: ${passedCases}/${result.results.length} cases, $${cost.toFixed(4)}, ${Math.round((Date.now() - started) / 1000)} s (evaluation ${result.evaluationId})`)
    for (const r of result.results.filter((c) => !c.passed)) console.log(`    ✗ ${r.name}: ${r.failures.join('; ')}`)
    if (!result.passed) failedAgents++
  }
  await prisma.$disconnect()
  process.exit(failedAgents ? 1 : 0)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
