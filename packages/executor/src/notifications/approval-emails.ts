import { prisma } from '@ai-workforce/db'
import type { ApprovalLevel, Prisma } from '@prisma/client'
import { canApprove, redactString, safeErrorMessage } from '@ai-workforce/domain'
import { formatCurrentTime } from '../context'
import { createMailerFromEnv, isDeliverableAddress, type EmailMessage, type Mailer } from './mailer'

/**
 * Emails the people who can decide a pending approval, so an agent waiting on a human is not
 * only visible to someone who happens to open /dashboard/approvals.
 *
 * Runs as a sweep in the worker's scheduler tick (packages/queue/src/scheduler.ts) rather than
 * at each of the three places approvals are created (tool calls, workflow approval steps, agent
 * revisions), so every kind is covered and an SMTP outage never slows an agent run down.
 *
 * - Each approval is claimed once (Approval.notifiedAt), so a second worker or a retry can't
 *   announce it twice. A failed send is audited, not retried: the dashboard still shows it.
 * - Recipients: tenant users whose role can approve at the approval's level (customer admins
 *   for CUSTOMER_APPROVAL, platform admins/operators for OPERATOR_APPROVAL), the agent's
 *   ApprovalPolicy.notifyEmails for that action, and Tenant.settings.notifications.approvalRecipients.
 *   Reserved domains (.local, .test, example.com...) are never mailed: the demo users live there.
 * - One email per recipient per tick, listing every new approval for that tenant.
 * - The email says what is waiting and links to the dashboard. It never carries the content the
 *   agent wants to send (that may be customer data) and has no approve-by-email link: deciding
 *   always needs a signed-in user.
 * - Off when SMTP_HOST is unset (audited as skipped) or when the tenant sets
 *   settings.notifications.approvalEmails = false.
 */

export const APPROVAL_NOTIFICATION_ACTIONS = {
  sent: 'APPROVAL_NOTIFICATION_SENT',
  skipped: 'APPROVAL_NOTIFICATION_SKIPPED',
  failed: 'APPROVAL_NOTIFICATION_FAILED',
} as const

/** Approvals older than this when first seen are not announced (e.g. after the worker was down for days). */
const DEFAULT_MAX_AGE_HOURS = 24

export interface ApprovalNotificationSettings {
  enabled: boolean
  extraRecipients: string[]
}

export function readApprovalNotificationSettings(tenantSettings: unknown): ApprovalNotificationSettings {
  const settings = tenantSettings && typeof tenantSettings === 'object' ? (tenantSettings as Record<string, unknown>) : {}
  const notifications = settings.notifications && typeof settings.notifications === 'object' ? (settings.notifications as Record<string, unknown>) : {}
  const extra = Array.isArray(notifications.approvalRecipients) ? notifications.approvalRecipients : []
  return {
    enabled: notifications.approvalEmails !== false,
    extraRecipients: extra.filter((e): e is string => typeof e === 'string' && e.includes('@')),
  }
}

// ---------------------------------------------------------------------------------------------
// The email
// ---------------------------------------------------------------------------------------------

export interface ApprovalEmailItem {
  agentName: string | null
  /** What the agent wants to do, e.g. "Gmail: send email". */
  label: string
  target: string | null
  risk: string | null
  rationale: string | null
  sandbox: boolean
  expiresAt: Date | null
}

/** "gmail__send_email" -> "Gmail: send email"; anything else is tidied up as-is. */
export function describeAction(action: string): string {
  const [service, name] = action.includes('__') ? action.split('__', 2) : [null, action]
  const words = (s: string) => s.replace(/[-_]+/g, ' ').trim()
  const tool = words(name ?? action)
  if (!service) return tool.charAt(0).toUpperCase() + tool.slice(1)
  const serviceName = words(service).replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bCrm\b/, 'CRM').replace(/\bHubspot\b/, 'HubSpot')
  return `${serviceName}: ${tool}`
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export function composeApprovalEmail(params: {
  to: string
  tenantName: string
  items: ApprovalEmailItem[]
  url: string
  /** Tenant.settings, for the time zone expiry times are shown in. */
  tenantSettings?: unknown
}): EmailMessage {
  const { items, tenantName, url } = params
  const first = items[0]
  const subject = oneLine(
    items.length === 1
      ? `${first.agentName ?? 'A workflow'} is waiting for your approval: ${first.label}`
      : `${items.length} actions are waiting for your approval in ${tenantName}`
  ).slice(0, 200)

  const details = items.map((item) => {
    const lines: Array<[string, string]> = []
    if (item.agentName) lines.push(['Agent', item.agentName])
    if (item.target) lines.push(['Where', item.target])
    if (item.rationale) lines.push(['Why', item.rationale])
    if (item.risk) lines.push(['Risk', item.risk.replace(/_/g, ' ')])
    if (item.expiresAt) lines.push(['Expires', formatCurrentTime(params.tenantSettings, item.expiresAt).text])
    if (item.sandbox) lines.push(['Sandbox', 'fictional data, nothing real will be sent'])
    return { title: item.label, lines: lines.map(([k, v]) => [k, oneLine(v)] as [string, string]) }
  })

  const intro =
    items.length === 1
      ? `${first.agentName ?? 'A workflow'} is waiting for your approval in ${tenantName}.`
      : `${items.length} actions are waiting for your approval in ${tenantName}.`
  const note = 'Nothing happens until someone approves. The exact content is shown in the dashboard; it is not included in this email.'
  const why = `You're receiving this because you can approve actions for ${tenantName}.`

  const text = [
    intro,
    '',
    ...details.flatMap((d, i) => [`${items.length > 1 ? `${i + 1}. ` : ''}${d.title}`, ...d.lines.map(([k, v]) => `   ${k}: ${v}`), '']),
    `Review and decide: ${url}`,
    '',
    note,
    why,
  ].join('\n')

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#171717">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;border:1px solid #e5e5e5">
<p style="margin:0 0 16px;font-size:16px">${escapeHtml(intro)}</p>
${details
  .map(
    (d) => `<div style="border:1px solid #e5e5e5;border-radius:8px;padding:12px 16px;margin:0 0 12px">
<p style="margin:0 0 8px;font-weight:600">${escapeHtml(d.title)}</p>
<table style="border-collapse:collapse;font-size:14px">${d.lines
      .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#737373;vertical-align:top">${escapeHtml(k)}</td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`)
      .join('')}</table>
</div>`
  )
  .join('\n')}
<p style="margin:20px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Review in the dashboard</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#525252">${escapeHtml(note)}</p>
<p style="margin:0;font-size:12px;color:#a3a3a3">${escapeHtml(why)}</p>
</div></body></html>`

  return { to: params.to, subject, text, html }
}

// ---------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------

export interface NotifyApprovalsOptions {
  now?: Date
  /** null = email off. Default: built once from SMTP_* (createMailerFromEnv). */
  mailer?: Mailer | null
  /** Base URL of the dashboard. Default: APP_URL, then NEXTAUTH_URL. */
  appUrl?: string
  /** Default skips reserved/test domains (isDeliverableAddress). */
  isDeliverable?: (email: string) => boolean
  maxAgeHours?: number
  limit?: number
}

export interface NotifyApprovalsResult {
  /** Approvals claimed by this sweep. */
  approvals: number
  /** Emails sent (one per recipient per tenant). */
  emailsSent: number
  skipped: number
  failed: number
}

let envMailer: { mailer: Mailer | null; reason?: string } | undefined
function mailerFromEnv(): { mailer: Mailer | null; reason?: string } {
  if (!envMailer) {
    try {
      const mailer = createMailerFromEnv()
      envMailer = mailer ? { mailer } : { mailer: null, reason: 'email is not configured (SMTP_HOST is not set)' }
    } catch (error) {
      console.error(`Approval emails are off: ${safeErrorMessage(error)}`)
      envMailer = { mailer: null, reason: `email is misconfigured: ${safeErrorMessage(error)}` }
    }
  }
  return envMailer
}

type PendingApproval = {
  id: string
  tenantId: string
  agentId: string | null
  workflowRunId: string | null
  action: string
  level: ApprovalLevel
  expiresAt: Date | null
  input: Prisma.JsonValue
}

interface Summary {
  action?: string
  target?: string
  riskClass?: string
  rationale?: string
}

async function audit(approval: PendingApproval, action: string, data: Record<string, unknown>) {
  await prisma.auditLog.create({
    data: {
      tenantId: approval.tenantId,
      action,
      entityType: 'Approval',
      entityId: approval.id,
      workflowRunId: approval.workflowRunId,
      newData: { approvalId: approval.id, agentId: approval.agentId, ...data } as Prisma.InputJsonObject,
    },
  })
}

export async function notifyPendingApprovals(options: NotifyApprovalsOptions = {}): Promise<NotifyApprovalsResult> {
  const now = options.now ?? new Date()
  const { mailer, reason: mailerOffReason } =
    options.mailer !== undefined ? { mailer: options.mailer, reason: options.mailer ? undefined : 'email is not configured' } : mailerFromEnv()
  const isDeliverable = options.isDeliverable ?? isDeliverableAddress
  const baseUrl = (options.appUrl ?? process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
  const url = `${baseUrl}/dashboard/approvals`
  const result: NotifyApprovalsResult = { approvals: 0, emailsSent: 0, skipped: 0, failed: 0 }

  const candidates: PendingApproval[] = await prisma.approval.findMany({
    where: {
      status: 'PENDING',
      notifiedAt: null,
      createdAt: { gte: new Date(now.getTime() - (options.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS) * 3_600_000) },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take: options.limit ?? 200,
    select: { id: true, tenantId: true, agentId: true, workflowRunId: true, action: true, level: true, expiresAt: true, input: true },
  })

  // Claim first: whoever flips notifiedAt owns the notification.
  const claimed: PendingApproval[] = []
  for (const approval of candidates) {
    const { count } = await prisma.approval.updateMany({ where: { id: approval.id, notifiedAt: null }, data: { notifiedAt: now } })
    if (count === 1) claimed.push(approval)
  }
  result.approvals = claimed.length

  const byTenant = new Map<string, PendingApproval[]>()
  for (const approval of claimed) byTenant.set(approval.tenantId, [...(byTenant.get(approval.tenantId) ?? []), approval])

  for (const [tenantId, approvals] of Array.from(byTenant)) {
    try {
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, settings: true } })
      if (!tenant) continue
      const settings = readApprovalNotificationSettings(tenant.settings)
      if (!settings.enabled) {
        for (const approval of approvals) await audit(approval, APPROVAL_NOTIFICATION_ACTIONS.skipped, { reason: 'approval emails are turned off for this tenant' })
        result.skipped += approvals.length
        continue
      }

      const agentIds = Array.from(new Set(approvals.map((a) => a.agentId).filter((id): id is string => Boolean(id))))
      const [agents, integrations, tenantUsers, policies] = await Promise.all([
        prisma.agent.findMany({ where: { id: { in: agentIds }, tenantId }, select: { id: true, name: true } }),
        prisma.integration.findMany({ where: { tenantId, isActive: true }, select: { name: true, config: true } }),
        prisma.user.findMany({ where: { tenantId }, select: { email: true, role: true } }),
        prisma.approvalPolicy.findMany({ where: { agentId: { in: agentIds } }, select: { agentId: true, action: true, notifyEmails: true } }),
      ])
      const needsOperators = approvals.some((a) => a.level === 'OPERATOR_APPROVAL')
      const operators = needsOperators
        ? await prisma.user.findMany({ where: { role: { in: ['PLATFORM_ADMIN', 'PLATFORM_OPERATOR'] } }, select: { email: true, role: true } })
        : []
      const agentName = new Map(agents.map((a) => [a.id, a.name]))
      const sandboxTargets = new Set(integrations.filter((i) => (i.config as Record<string, unknown> | null)?.sandbox === true).map((i) => i.name))

      const inbox = new Map<string, { email: string; approvalIds: string[] }>()
      const plan = new Map<string, { recipients: string[]; undeliverable: string[]; item: ApprovalEmailItem }>()
      for (const approval of approvals) {
        // Tenant users who can decide this level; operator-level approvals go to the platform team.
        const people = approval.level === 'OPERATOR_APPROVAL' ? operators : tenantUsers
        const wanted = [
          ...people.filter((u) => canApprove(u.role, approval.level)).map((u) => u.email),
          ...policies.filter((p) => p.agentId === approval.agentId && (p.action === approval.action || p.action === '*')).flatMap((p) => p.notifyEmails),
          ...(approval.level === 'OPERATOR_APPROVAL' ? [] : settings.extraRecipients),
        ]
        const unique = Array.from(new Map(wanted.map((e) => [e.trim().toLowerCase(), e.trim()])).values())
        const recipients = unique.filter((e) => isDeliverable(e))
        const undeliverable = unique.filter((e) => !isDeliverable(e))

        const payload = (approval.input ?? {}) as { kind?: string; summary?: Summary }
        const summary = payload.summary ?? {}
        plan.set(approval.id, {
          recipients,
          undeliverable,
          item: {
            agentName: approval.agentId ? agentName.get(approval.agentId) ?? null : null,
            label: payload.kind === 'tool_call' ? describeAction(approval.action) : oneLine(summary.action ?? describeAction(approval.action)),
            target: payload.kind === 'agent_revision' ? null : summary.target ?? null,
            risk: summary.riskClass ?? null,
            rationale: summary.rationale ? redactString(oneLine(summary.rationale), 300) : null,
            sandbox: sandboxTargets.has(String(summary.target ?? '')),
            expiresAt: approval.expiresAt,
          },
        })
        for (const email of recipients) {
          const key = email.toLowerCase()
          const entry = inbox.get(key) ?? { email, approvalIds: [] }
          entry.approvalIds.push(approval.id)
          inbox.set(key, entry)
        }
      }

      // Send (one email per recipient), remembering who got what.
      const delivered = new Map<string, string[]>()
      const failures = new Map<string, Array<{ to: string; error: string }>>()
      if (mailer) {
        for (const { email, approvalIds } of Array.from(inbox.values())) {
          const message = composeApprovalEmail({ to: email, tenantName: tenant.name, url, tenantSettings: tenant.settings, items: approvalIds.map((id) => plan.get(id)!.item) })
          try {
            await mailer.send(message)
            result.emailsSent++
            for (const id of approvalIds) delivered.set(id, [...(delivered.get(id) ?? []), email])
          } catch (error) {
            const reason = safeErrorMessage(error)
            console.error(`Approval email to ${email} failed: ${reason}`)
            for (const id of approvalIds) failures.set(id, [...(failures.get(id) ?? []), { to: email, error: reason }])
          }
        }
      }

      for (const approval of approvals) {
        const { recipients, undeliverable } = plan.get(approval.id)!
        const base = { level: approval.level, ...(undeliverable.length ? { notMailed: undeliverable } : {}) }
        if (!recipients.length) {
          await audit(approval, APPROVAL_NOTIFICATION_ACTIONS.skipped, { ...base, reason: 'nobody to email (no approver with a deliverable address)' })
          result.skipped++
        } else if (!mailer) {
          await audit(approval, APPROVAL_NOTIFICATION_ACTIONS.skipped, { ...base, reason: mailerOffReason, wouldEmail: recipients })
          result.skipped++
        } else if (delivered.get(approval.id)?.length) {
          await audit(approval, APPROVAL_NOTIFICATION_ACTIONS.sent, { ...base, emailed: delivered.get(approval.id), ...(failures.has(approval.id) ? { failed: failures.get(approval.id) } : {}) })
        } else {
          await audit(approval, APPROVAL_NOTIFICATION_ACTIONS.failed, { ...base, failed: failures.get(approval.id) ?? [] })
          result.failed++
        }
      }
    } catch (error) {
      console.error(`Approval notifications for tenant ${tenantId} failed:`, safeErrorMessage(error))
      result.failed += approvals.length
    }
  }

  return result
}
