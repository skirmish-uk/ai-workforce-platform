import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, safeErrorMessage } from '@ai-workforce/domain'
import { EMAIL_INTEGRATION_NAME, mailboxCredentialsSchema, testMailbox } from '@ai-workforce/integrations'
import { encryptionConfigured, isPlaceholderCredentials, removeOAuthConnection, storeOAuthConnection } from '@ai-workforce/tools'
import { switchMailboxTools } from '@ai-workforce/executor'
import { UserRole } from '@prisma/client'
import { tenantFor } from '../../../../lib/tenant'

export const dynamic = 'force-dynamic'

/** Connection tests per business per hour: each one logs in to an outside mail server. */
const ATTEMPTS_PER_HOUR = 10

/**
 * Any mailbox over IMAP/SMTP (docs/EMAIL_CONNECT.md).
 * GET     state of the connection and which mailbox the agents use
 * POST    { email, password, username?, fromName?, imap: { host, port }, smtp: { host, port }, saveSentCopy? }
 *         logs in to both (sending nothing) and stores the connection encrypted only if both work
 * DELETE  forgets the stored password and turns the connection off
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(session.user.role as UserRole, 'integration:read')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const tenantId = tenantFor(session, request)
  const row = await prisma.integration.findFirst({ where: { tenantId, name: EMAIL_INTEGRATION_NAME }, orderBy: { createdAt: 'asc' } })
  const config = (row?.config ?? {}) as Record<string, unknown>
  const state = !row || !row.isActive ? 'not_connected' : config.sandbox === true ? 'sandbox' : isPlaceholderCredentials(row.credentials) ? 'not_connected' : 'connected'
  // Which mailbox the agents are set up for: a preview of switching each way.
  const [toEmail, toGmail] = await Promise.all([switchMailboxTools({ tenantId, to: 'email', apply: false }), switchMailboxTools({ tenantId, to: 'gmail', apply: false })])
  return NextResponse.json({
    data: {
      state,
      account: state === 'connected' ? (config.connectedAccount as string | null) ?? null : null,
      servers: state === 'connected' ? (config.servers as unknown) ?? null : null,
      connectedAt: state === 'connected' ? (config.connectedAt as string | null) ?? null : null,
      encryption: encryptionConfigured(),
      canManage: hasPermission(session.user.role as UserRole, 'integration:write'),
      agents: { onGmail: toEmail.agents.map((a) => ({ name: a.name, skipped: a.skipped ?? null })), onEmail: toGmail.agents.map((a) => ({ name: a.name, skipped: a.skipped ?? null })) },
    },
  })
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session.user.role as UserRole, 'integration:write')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const tenantId = tenantFor(session, request)
    if (!encryptionConfigured()) return NextResponse.json({ error: 'Passwords can’t be stored: CREDENTIALS_ENCRYPTION_KEY is not set on the server.' }, { status: 503 })

    const parsed = mailboxCredentialsSchema.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success) return NextResponse.json({ error: `Check the form: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` }, { status: 400 })
    const creds = parsed.data

    const recent = await prisma.auditLog.count({ where: { tenantId, action: 'MAILBOX_CONNECT_ATTEMPT', createdAt: { gte: new Date(Date.now() - 3_600_000) } } })
    if (recent >= ATTEMPTS_PER_HOUR) return NextResponse.json({ error: `${ATTEMPTS_PER_HOUR} connection attempts in the last hour; try again later.` }, { status: 429 })

    const result = await testMailbox(creds)
    const servers = { imap: `${creds.imap.host}:${creds.imap.port}`, smtp: `${creds.smtp.host}:${creds.smtp.port}` }
    // Never the password: who tried which servers, and what happened.
    await prisma.auditLog.create({ data: { action: 'MAILBOX_CONNECT_ATTEMPT', entityType: 'Integration', entityId: EMAIL_INTEGRATION_NAME, tenantId, userId: session.user.id, newData: { account: creds.email, servers, imap: result.imap.ok ? 'ok' : result.imap.error ?? 'failed', smtp: result.smtp.ok ? 'ok' : result.smtp.error ?? 'failed' } } })
    if (!result.ok) return NextResponse.json({ error: 'The mailbox could not be connected. Nothing was stored.', test: result }, { status: 400 })

    const stored = await storeOAuthConnection({ tenantId, name: EMAIL_INTEGRATION_NAME, provider: 'imap', scopes: ['imap', 'smtp'], credentials: creds, account: creds.email, connectedByUserId: session.user.id })
    // Non-secret details for the integrations page and for the agents' tool notes.
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: stored.id } })
    await prisma.integration.update({ where: { id: stored.id }, data: { config: { ...((row.config ?? {}) as Record<string, unknown>), servers, folders: result.imap.folders ?? null, customLabels: result.imap.customLabels ?? null } } })
    await prisma.auditLog.create({ data: { action: 'INTEGRATION_CONNECTED', entityType: 'Integration', entityId: stored.id, tenantId, userId: session.user.id, newData: { name: EMAIL_INTEGRATION_NAME, provider: 'imap', account: creds.email, servers } } })
    return NextResponse.json({ data: { connected: true, account: creds.email, test: result } }, { status: stored.created ? 201 : 200 })
  } catch (error) {
    console.error('Connecting a mailbox failed:', safeErrorMessage(error))
    return NextResponse.json({ error: `Could not connect: ${safeErrorMessage(error)}` }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(session.user.role as UserRole, 'integration:write')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const tenantId = tenantFor(session, request)
  const { removed } = await removeOAuthConnection(tenantId, EMAIL_INTEGRATION_NAME)
  if (removed) await prisma.auditLog.create({ data: { action: 'INTEGRATION_DISCONNECTED', entityType: 'Integration', entityId: EMAIL_INTEGRATION_NAME, tenantId, userId: session.user.id, newData: { name: EMAIL_INTEGRATION_NAME, provider: 'imap' } } })
  return NextResponse.json({ data: { removed } })
}
