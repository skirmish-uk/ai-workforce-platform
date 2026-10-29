/**
 * Sets up the self-repair moment for a showcase (DEMO.md, "Self-repair"). Jordan (Website
 * Enquiries) answers three realistic enquiries; its outdated playbook puts the price list in
 * every reply, so the demo admin rejects each draft in Approvals with the reason staff would
 * give. Three rejections out of three crosses the "people reject most of its approvals"
 * threshold, so Morgan's automatic repair review starts on the scheduler's next 10-minute
 * check, or at once with "Review the team now" on the Team page.
 *
 *   npm run demo:stage-repair       # after npm run demo:reset, 10+ minutes before the moment
 *   scripts/demo-deploy.sh stage-repair      # the same, inside the Docker stack
 *
 * Real model calls (about $0.01); the replies go to the sandbox Gmail connection and are
 * rejected, so nothing is sent anywhere. Uses the root .env.
 */
import { config } from 'dotenv'
import path from 'node:path'
const loaded = config({ path: path.resolve(__dirname, '../.env') })
for (const [key, value] of Object.entries(loaded.parsed ?? {})) {
  if (process.env[key] === '' && value !== '') process.env[key] = value
}

import { prisma } from '@ai-workforce/db'
import { decideApproval, runAgent } from '@ai-workforce/executor'
import { STAGED_REPAIR_AGENT_ID, STAGED_REPAIR_REJECTION } from '../packages/db/prisma/seed-showcase'

const ENQUIRIES = [
  'Website form from Priya Shah <priya@harbourdental.example>: "Hi, do you do SEO for a small dental group? What would it involve?"',
  'Website form from James Okafor <james@okafor-plumbing.example>: "We need more leads from Google. Can someone tell me about your packages?"',
  'Website form from Lena Park <lena@northwind-logistics.example>: "We are looking at LinkedIn ads for next quarter. How do you usually work with new clients?"',
]

async function main(): Promise<void> {
  const agent = await prisma.agent.findUnique({ where: { id: STAGED_REPAIR_AGENT_ID } })
  if (!agent) throw new Error(`${STAGED_REPAIR_AGENT_ID} not found: run the seed (or npm run demo:reset) first.`)
  if (agent.version !== 1) console.warn(`Jordan is at version ${agent.version}: the flaw may already be fixed. Run npm run demo:reset first to restore it.`)
  const admin = await prisma.user.findFirst({ where: { tenantId: agent.tenantId, role: 'CUSTOMER_ADMIN' }, orderBy: { createdAt: 'asc' } })
  if (!admin) throw new Error('No customer admin in the demo tenant to reject the drafts.')

  // All three drafts first, then the rejections: a rejection with a reason becomes a lesson for
  // Jordan straight away (docs/TEAMWORK.md), so rejecting as we go would fix the later drafts.
  let rejected = 0
  let cost = 0
  const runs = []
  for (const input of ENQUIRIES) {
    const run = await runAgent(STAGED_REPAIR_AGENT_ID, input, { trigger: 'api', userId: admin.id })
    cost += run.costUsd ?? 0
    const draft = run.toolCalls.find((c) => c.toolName === 'gmail__send_email')
    const body = JSON.stringify(draft?.input ?? {})
    const quotesPrices = /\$\s?\d/.test(body)
    console.log(`\n• ${input.slice(0, 72)}…\n  status: ${run.status}; draft quotes prices: ${quotesPrices ? 'yes' : 'no'}`)
    runs.push(run)
  }
  for (const run of runs) {
    if (run.status === 'approval_required' && run.approvalId) {
      await decideApproval({ approvalId: run.approvalId, decision: 'reject', actor: { id: admin.id, role: admin.role, tenantId: admin.tenantId }, reason: STAGED_REPAIR_REJECTION })
      rejected++
    } else {
      console.log(`  no approval to reject (${run.error ?? run.status})`)
    }
  }
  if (rejected) console.log(`\nRejected ${rejected} as ${admin.email}: "${STAGED_REPAIR_REJECTION}"`)
  console.log(`\n${rejected} of ${ENQUIRIES.length} drafts rejected, $${cost.toFixed(4)}.`)
  console.log(rejected >= 3
    ? 'Ready: Jordan shows "needs attention" on the Team page. Morgan\'s automatic review starts within 10 minutes (worker running), or click "Review the team now".'
    : 'Fewer than 3 rejections, so the automatic review will not start. Run this again, or use "Review the team now".')
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
