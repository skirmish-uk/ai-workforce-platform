/**
 * Runs agents' evaluation suites against the real model (dry runs: no tool touches a real
 * system) and prints each case. Costs model usage; each agent's contract caps cost per run.
 *
 *   npx tsx scripts/run-evals.ts demo-assistant-1            # one agent; records an Evaluation
 *   npx tsx scripts/run-evals.ts --all                       # every live agent in the demo tenant
 *   npx tsx scripts/run-evals.ts demo-assistant-1 --model claude-haiku-5-5
 *       # try another model without changing the agent: the agent's model is swapped for the
 *       # run and restored afterwards, and the Evaluation row is deleted so it never counts as
 *       # evidence for the agent's real configuration.
 *   --repeat 3                                               # run the suite N times (flakiness)
 *
 * A recorded passing Evaluation for the agent's current version is what lets the `limited` and
 * `expanded` autonomy stages take effect (docs/AGENT_OPERATING_SYSTEM.md). Uses the root .env.
 */
import { config } from 'dotenv'
import path from 'node:path'
const loaded = config({ path: path.resolve(__dirname, '../.env') })
for (const [key, value] of Object.entries(loaded.parsed ?? {})) {
  if (process.env[key] === '' && value !== '') process.env[key] = value
}

import { prisma } from '@ai-workforce/db'
import { runEvaluation } from '@ai-workforce/executor'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > -1 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const model = arg('--model')
  const repeat = Math.max(1, Number(arg('--repeat') ?? 1))
  const flagValues = new Set([model, arg('--repeat')].filter(Boolean))
  let ids = process.argv.slice(2).filter((a) => !a.startsWith('--') && !flagValues.has(a))
  if (process.argv.includes('--all')) {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'demo-agency' } })
    const agents = await prisma.agent.findMany({ where: { tenantId: tenant.id, isCandidate: false, status: { not: 'ARCHIVED' } }, orderBy: { id: 'asc' }, select: { id: true } })
    ids = agents.map((a) => a.id)
  }
  if (!ids.length) throw new Error('Name agent ids, or pass --all')

  let grandTotal = 0
  const summary: string[] = []
  for (const id of ids) {
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id } })
    const original = { modelName: agent.modelName, modelProvider: agent.modelProvider }
    if (model) await prisma.agent.update({ where: { id }, data: { modelName: model } })
    try {
      for (let round = 1; round <= repeat; round++) {
        const label = `${agent.name} v${agent.version} on ${model ?? agent.modelName}${repeat > 1 ? ` (round ${round}/${repeat})` : ''}`
        console.log(`\n▶ ${label}`)
        const result = await runEvaluation(id, { name: model ? `experiment: ${model}` : undefined })
        let cost = 0
        for (const c of result.results) {
          cost += c.costUsd ?? 0
          console.log(`  ${c.passed ? '✓' : '✗'} ${c.name}${c.status ? ` [${c.status}]` : ''}${c.passed ? '' : ` — ${c.failures.join('; ')}`}`)
        }
        grandTotal += cost
        const line = `${label}: ${Math.round(result.passRate * 100)}% (${result.results.filter((r) => r.passed).length}/${result.results.length}) ${result.passed ? 'PASSED' : 'FAILED'}, $${cost.toFixed(4)}`
        console.log(`  → ${line}`)
        summary.push(line)
        if (model) {
          // An experiment is not evidence for the agent's real configuration.
          await prisma.auditLog.deleteMany({ where: { action: 'AGENT_EVALUATION_COMPLETED', newData: { path: ['evaluationId'], equals: result.evaluationId } } })
          await prisma.evaluation.delete({ where: { id: result.evaluationId } })
        }
      }
    } finally {
      if (model) await prisma.agent.update({ where: { id }, data: original })
    }
  }
  console.log(`\nSummary\n${summary.map((s) => `  ${s}`).join('\n')}\n  Total model cost: $${grandTotal.toFixed(4)}`)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
