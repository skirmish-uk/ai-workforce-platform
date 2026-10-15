import { prisma } from '@ai-workforce/db'
import { Prisma } from '@prisma/client'
import { canApprove, safeErrorMessage } from '@ai-workforce/domain'
import { formatCurrentTime } from '../context'
import { readApprovalNotificationSettings } from './approval-emails'
import { appBaseUrl, describeAction, renderDigest, splitRecipients, type DigestSection } from './format'
import { envMailer, isDeliverableAddress, type EmailMessage, type Mailer } from './mailer'

/**
 * The NOTIFY permission level: the action runs without waiting for anyone, and the people who
 * could have approved it are told afterwards.
 *
 * runAuthorizedTool marks the audit row of a NOTIFY-level call that ran (`newData.notify`; never
 * for dry runs). This sweep, in the worker's scheduler tick next to notifyPendingApprovals(),
 * finds those rows and emails one digest per recipient per tenant. A Notification row
 * (unique per kind + audit row) is claimed before sending, so each action is announced once.
 *
 * Recipients, settings and safety rules match approval emails (approval-emails.ts): tenant users
 * who can approve customer-level actions, the agent's ApprovalPolicy.notifyEmails for that
 * action (or "*"), settings.notifications.approvalRecipients; reserved domains are never mailed;
 * off without SMTP_HOST. Tenants opt out with settings.notifications.actionEmails = false.
 * As with approvals, the email never includes the content the agent sent.
 */

export const ACTION_NOTIFICATION_KIND = 'agent_action'
const TOOL_CALL_ACTIONS = ['AGENT_TOOL_CALL', 'AGENT_TOOL_CALL_SIMULATED']
const DEFAULT_MAX_AGE_HOURS = 24

export interface ActionEmailItem {
  agentName: string | null
  label: string
  at: Date
  /** Ran against a sandbox connection: nothing real happened. */
  sandbox: boolean
}

export function composeActionEmail(params: { to: string; tenantName: string; items: ActionEmailItem[]; url: string; tenantSettings?: unknown }): EmailMessage {
  const { items, tenantName } = params
  const first = items[0]
  const agents = new Set(items.map((i) => i.agentName ?? 'An agent'))
  const who = agents.size === 1 ? first.agentName ?? 'An agent' : 'Your agents'
  const subject = (items.length === 1 ? `${who} did: ${first.label}` : `${who} took ${items.length} actions in ${tenantName}`).replace(/[\r\n]+/g, ' ').slice(0, 200)

  const sections: DigestSection[] = items.map((item) => {
    const lines: Array<[string, string]> = []
    if (item.agentName && agents.size > 1) lines.push(['Agent', item.agentName])
    lines.push(['When', formatCurrentTime(params.tenantSettings, item.at).text])
    lines.push(['Result', item.sandbox ? 'simulated on a sandbox connection; nothing real was sent' : 'done'])
    return { title: item.label, lines }
  })

  const { text, html } = renderDigest({
    intro: items.length === 1 ? `${who} took an action in ${tenantName} that is set to notify you.` : `${who} took ${items.length} actions in ${tenantName} that are set to notify you.`,
    sections,
    url: params.url,
    urlLabel: 'See what the agent did',
    note: "These actions don't wait for approval; you hear about them afterwards. To require approval instead, change the agent's permission for that action. The content is shown in the dashboard, not in this email.",
    why: `You're receiving this because you oversee agents for ${tenantName}.`,
  })
  return { to: params.to, subject, text, html }
}

export interface NotifyActionsOptions {
  now?: Date
  mailer?: Mailer | null
  appUrl?: string
  isDeliverable?: (email: string) => boolean
  maxAgeHours?: number
  limit?: number
}

export interface NotifyActionsResult {
  actions: number
  emailsSent: number
  skipped: number
  failed: number
}

type ActionRow = { id: string; tenantId: string; entityId: string; createdAt: Date; action: string; newData: Prisma.JsonValue }

export async function notifyAgentActions(options: NotifyActionsOptions = {}): Promise<NotifyActionsResult> {
  const now = options.now ?? new Date()
  const { mailer, reason: mailerOffReason } =
    options.mailer !== undefined ? { mailer: options.mailer, reason: options.mailer ? undefined : 'email is not configured' } : envMailer()
  const isDeliverable = options.isDeliverable ?? isDeliverableAddress
  const result: NotifyActionsResult = { actions: 0, emailsSent: 0, skipped: 0, failed: 0 }

  const rows: ActionRow[] = await prisma.auditLog.findMany({
    where: {
      action: { in: TOOL_CALL_ACTIONS },
      entityType: 'Agent',
      createdAt: { gte: new Date(now.getTime() - (options.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS) * 3_600_000) },
      newData: { path: ['notify'], equals: true },
    },
    orderBy: { createdAt: 'asc' },
    take: options.limit ?? 200,
    select: { id: true, tenantId: true, entityId: true, createdAt: true, action: true, newData: true },
  })
  if (!rows.length) return result
  const done = new Set(
    (await prisma.notification.findMany({ where: { kind: ACTION_NOTIFICATION_KIND, sourceId: { in: rows.map((r) => r.id) } }, select: { sourceId: true } })).map((n) => n.sourceId)
  )

  // Claim: the unique (kind, sourceId) row decides who announces each action.
  const claimed: Array<ActionRow & { notificationId: string }> = []
  for (const row of rows) {
    if (done.has(row.id)) continue
    try {
      const n = await prisma.notification.create({ data: { kind: ACTION_NOTIFICATION_KIND, sourceId: row.id, tenantId: row.tenantId } })
      claimed.push({ ...row, notificationId: n.id })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue
      throw error
    }
  }
  result.actions = claimed.length

  const finish = (notificationId: string, status: 'SENT' | 'SKIPPED' | 'FAILED', detail: Record<string, unknown>) =>
    prisma.notification.update({ where: { id: notificationId }, data: { status, detail: detail as Prisma.InputJsonObject } })

  const byTenant = new Map<string, typeof claimed>()
  for (const row of claimed) byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) ?? []), row])

  for (const [tenantId, actions] of Array.from(byTenant)) {
    try {
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, settings: true } })
      if (!tenant) continue
      const settings = tenant.settings && typeof tenant.settings === 'object' ? (tenant.settings as Record<string, unknown>) : {}
      const notifications = (settings.notifications ?? {}) as Record<string, unknown>
      if (notifications.actionEmails === false) {
        for (const a of actions) await finish(a.notificationId, 'SKIPPED', { reason: 'action emails are turned off for this tenant' })
        result.skipped += actions.length
        continue
      }
      const { extraRecipients } = readApprovalNotificationSettings(tenant.settings)

      const agentIds = Array.from(new Set(actions.map((a) => a.entityId)))
      const [agents, admins, policies] = await Promise.all([
        prisma.agent.findMany({ where: { id: { in: agentIds }, tenantId }, select: { id: true, name: true } }),
        prisma.user.findMany({ where: { tenantId }, select: { email: true, role: true } }),
        prisma.approvalPolicy.findMany({ where: { agentId: { in: agentIds } }, select: { agentId: true, action: true, notifyEmails: true } }),
      ])
      const agentName = new Map(agents.map((a) => [a.id, a.name]))

      const inbox = new Map<string, { email: string; ids: string[] }>()
      const plan = new Map<string, { recipients: string[]; undeliverable: string[]; item: ActionEmailItem; agentId: string }>()
      for (const a of actions) {
        const data = (a.newData ?? {}) as Record<string, unknown>
        const tool = String(data.tool ?? 'unknown tool')
        const wanted = [
          ...admins.filter((u) => canApprove(u.role, 'CUSTOMER_APPROVAL')).map((u) => u.email),
          ...policies.filter((p) => p.agentId === a.entityId && (p.action === tool || p.action === '*')).flatMap((p) => p.notifyEmails),
          ...extraRecipients,
        ]
        const split = splitRecipients(wanted, isDeliverable)
        plan.set(a.id, {
          ...split,
          agentId: a.entityId,
          item: { agentName: agentName.get(a.entityId) ?? null, label: describeAction(tool), at: a.createdAt, sandbox: a.action === 'AGENT_TOOL_CALL_SIMULATED' },
        })
        for (const email of split.recipients) {
          const entry = inbox.get(email.toLowerCase()) ?? { email, ids: [] }
          entry.ids.push(a.id)
          inbox.set(email.toLowerCase(), entry)
        }
      }

      const delivered = new Map<string, string[]>()
      const failures = new Map<string, Array<{ to: string; error: string }>>()
      if (mailer) {
        for (const { email, ids } of Array.from(inbox.values())) {
          const agentsInEmail = new Set(ids.map((id) => plan.get(id)!.agentId))
          const url = `${appBaseUrl(options.appUrl)}/dashboard/agents${agentsInEmail.size === 1 ? `/${encodeURIComponent(Array.from(agentsInEmail)[0])}` : ''}`
          const message = composeActionEmail({ to: email, tenantName: tenant.name, url, tenantSettings: tenant.settings, items: ids.map((id) => plan.get(id)!.item) })
          try {
            await mailer.send(message)
            result.emailsSent++
            for (const id of ids) delivered.set(id, [...(delivered.get(id) ?? []), email])
          } catch (error) {
            const reason = safeErrorMessage(error)
            console.error(`Action email to ${email} failed: ${reason}`)
            for (const id of ids) failures.set(id, [...(failures.get(id) ?? []), { to: email, error: reason }])
          }
        }
      }

      for (const a of actions) {
        const { recipients, undeliverable } = plan.get(a.id)!
        const base = { auditLogId: a.id, agentId: a.entityId, ...(undeliverable.length ? { notMailed: undeliverable } : {}) }
        if (!recipients.length) {
          await finish(a.notificationId, 'SKIPPED', { ...base, reason: 'nobody to email (no admin with a deliverable address)' })
          result.skipped++
        } else if (!mailer) {
          await finish(a.notificationId, 'SKIPPED', { ...base, reason: mailerOffReason, wouldEmail: recipients })
          result.skipped++
        } else if (delivered.get(a.id)?.length) {
          await finish(a.notificationId, 'SENT', { ...base, emailed: delivered.get(a.id), ...(failures.has(a.id) ? { failed: failures.get(a.id) } : {}) })
        } else {
          await finish(a.notificationId, 'FAILED', { ...base, failed: failures.get(a.id) ?? [] })
          result.failed++
        }
      }
    } catch (error) {
      console.error(`Action notifications for tenant ${tenantId} failed:`, safeErrorMessage(error))
      result.failed += actions.length
    }
  }
  return result
}
