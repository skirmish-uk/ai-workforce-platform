/**
 * Live Gmail test through the platform's real code path (no LLM, no cost).
 *
 *   npx tsx scripts/gmail-live-test.ts auth                       # one-time: authorise a Google account
 *   npx tsx scripts/gmail-live-test.ts send  --to you@example.com # approval → real Gmail send
 *   npx tsx scripts/gmail-live-test.ts reply --thread <threadId>  # read the thread, send a threaded reply
 *
 * Needs GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in the root .env from a Google
 * Cloud OAuth client of type "Desktop app" (loopback redirect), with the Gmail
 * API enabled and your account added as a test user.
 *
 * Writes to the database in DATABASE_URL (dev DB by default): the OAuth tokens
 * go into the demo tenant's Gmail Integration row (the platform's existing,
 * currently unencrypted, credential store), and each send leaves a real
 * Approval + AuditLog trail for demo-agent-1.
 */
import { config } from 'dotenv'
import path from 'node:path'
const loaded = config({ path: path.resolve(__dirname, '../.env') })
// dotenv never overrides a variable that is already set, even to an empty string, so an empty
// OPENAI_API_KEY exported by the shell would hide the real one in .env. Treat empty as unset.
for (const [key, value] of Object.entries(loaded.parsed ?? {})) {
  if (process.env[key] === '' && value !== '') process.env[key] = value
}

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { google } from 'googleapis'
import { prisma } from '@ai-workforce/db'
import { gmailAdapter, toGoogleCredentials } from '@ai-workforce/integrations'
import { createToolApproval, decideApproval, executeApprovedAction } from '@ai-workforce/executor'
import { decryptCredentials, encryptCredentials, getToolRiskProfile } from '@ai-workforce/tools'

const AGENT_ID = 'demo-agent-1'
const APPROVER_EMAIL = 'admin@demo-agency.local'
const PORT = 53682
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

function requireGoogleClient(): void {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in the root .env (Google Cloud OAuth client, type "Desktop app").')
  }
}

async function demoContext() {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: AGENT_ID } })
  const integrations = await prisma.integration.findMany({ where: { tenantId: agent.tenantId, name: 'Gmail' }, orderBy: { createdAt: 'asc' } })
  if (!integrations.length) throw new Error('Demo tenant has no Gmail integration row; run the seed first.')
  return { agent, integration: integrations[0], duplicates: integrations.slice(1) }
}

async function gmailFor(credentials: Record<string, unknown>) {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, REDIRECT_URI)
  auth.setCredentials(toGoogleCredentials(credentials))
  return google.gmail({ version: 'v1', auth })
}

async function auth(): Promise<void> {
  requireGoogleClient()
  const { integration, duplicates } = await demoContext()
  const state = randomBytes(16).toString('hex')
  const url = gmailAdapter.authUrl(REDIRECT_URI, state)

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', REDIRECT_URI)
      if (u.pathname !== '/oauth2callback') return void res.writeHead(404).end()
      const error = u.searchParams.get('error')
      if (error || u.searchParams.get('state') !== state || !u.searchParams.get('code')) {
        res.writeHead(400).end('Authorisation failed — check the terminal.')
        server.close()
        return reject(new Error(error ? `Google returned: ${error}` : 'State mismatch or missing code'))
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Authorised. You can close this tab and return to the terminal.')
      server.close()
      resolve(u.searchParams.get('code')!)
    })
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`\nOpen this URL in your browser and approve access:\n\n${url}\n\nWaiting on ${REDIRECT_URI} ...`)
    })
    setTimeout(() => {
      server.close()
      reject(new Error('Timed out after 5 minutes waiting for the OAuth redirect'))
    }, 5 * 60_000).unref()
  })

  const credentials = await gmailAdapter.exchangeCode(code, REDIRECT_URI)
  // Real tokens: leave sandbox mode so tools hit the real mailbox.
  const config = (integration.config ?? {}) as Record<string, unknown>
  // Stored encrypted (requires CREDENTIALS_ENCRYPTION_KEY); real tokens leave sandbox mode.
  const encrypted = encryptCredentials(credentials as unknown as Record<string, unknown>, integration.tenantId)
  await prisma.integration.update({ where: { id: integration.id }, data: { credentials: encrypted as never, isActive: true, config: { ...config, sandbox: false } as never } })
  if (duplicates.length) {
    // The seed has created duplicate Gmail rows; make sure the platform picks the one with tokens.
    await prisma.integration.updateMany({ where: { id: { in: duplicates.map((d) => d.id) } }, data: { isActive: false } })
  }
  const profile = await (await gmailFor(credentials as unknown as Record<string, unknown>)).users.getProfile({ userId: 'me' })
  console.log(`\nStored tokens for ${profile.data.emailAddress} on integration ${integration.id}` + (duplicates.length ? ` (deactivated ${duplicates.length} duplicate Gmail rows)` : '') + '.')
}

/** Approval → decision → executeApprovedAction: the same path an agent's send takes in production. */
async function sendViaPlatform(args: { to: string[]; subject: string; body: string; threadId?: string; inReplyTo?: string }) {
  requireGoogleClient()
  const { agent, integration } = await demoContext()
  const creds = decryptCredentials(integration.credentials, integration.tenantId)
  if (!creds.accessToken && !creds.refreshToken) throw new Error('No Gmail tokens stored yet — run the "auth" step first.')
  const approver = await prisma.user.findUniqueOrThrow({ where: { email: APPROVER_EMAIL } })
  const runId = `live-test-${Date.now()}`

  const approvalId = await createToolApproval({
    tenantId: agent.tenantId,
    agentId: agent.id,
    agentVersion: agent.version,
    runId,
    toolName: 'gmail__send_email',
    adapterName: 'Gmail',
    input: args,
    level: 'CUSTOMER_APPROVAL',
    profile: getToolRiskProfile('gmail__send_email'),
    rationale: 'Manual live test of the Gmail integration.',
    policyReason: 'Live test',
    ttlHours: 1,
  })
  await decideApproval({ approvalId, decision: 'approve', actor: { id: approver.id, role: approver.role, tenantId: approver.tenantId }, reason: 'live test' })
  const result = await executeApprovedAction(approvalId)
  console.log(JSON.stringify({ runId, approvalId, status: result.status, output: result.output, error: result.error }, null, 2))
  if (result.status !== 'EXECUTED') process.exitCode = 1
  return result
}

async function send(): Promise<void> {
  const to = arg('to')
  if (!to) throw new Error('--to <address> is required')
  const stamp = new Date().toISOString()
  await sendViaPlatform({
    to: [to],
    subject: `AI Workforce live test ${stamp}`,
    body: `This is a live test email sent by the AI Workforce platform's Gmail integration at ${stamp}.\n\nIt went through the approval path (approval created, approved by the demo admin, executed by executeApprovedAction). Reply to it, or run the "reply" step, to test threading.`,
  })
}

async function reply(): Promise<void> {
  const threadId = arg('thread')
  if (!threadId) throw new Error('--thread <threadId> is required (printed by the send step as output.threadId)')
  requireGoogleClient()
  const { integration } = await demoContext()
  const gmail = await gmailFor(decryptCredentials(integration.credentials, integration.tenantId))

  // "Receive": read the thread through the Gmail API with the stored platform credentials.
  const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'metadata', metadataHeaders: ['Message-ID', 'Subject', 'From', 'To'] })
  const last = thread.data.messages?.at(-1)
  const header = (n: string) => last?.payload?.headers?.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? undefined
  const messageId = header('Message-ID')
  const subject = header('Subject') ?? ''
  const replyTo = header('From')?.match(/<([^>]+)>/)?.[1] ?? header('From')
  if (!messageId || !replyTo) throw new Error(`Could not read Message-ID/From from thread ${threadId}`)
  console.log(`Received: "${subject}" from ${replyTo} (${thread.data.messages?.length} message(s) in thread)`)

  await sendViaPlatform({
    to: [replyTo],
    subject: subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`,
    body: `Automated threaded reply from the AI Workforce live test at ${new Date().toISOString()}.`,
    threadId,
    inReplyTo: messageId,
  })
}

const commands: Record<string, () => Promise<void>> = { auth, send, reply }
const command = commands[process.argv[2] ?? '']
if (!command) {
  console.error('Usage: npx tsx scripts/gmail-live-test.ts <auth|send|reply> [--to address] [--thread id]')
  process.exit(2)
}
command()
  .catch((error) => {
    console.error(`\n✖ ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
