import { prisma } from '@ai-workforce/db'
import type { Prisma } from '@prisma/client'
import { canApprove, safeErrorMessage } from '@ai-workforce/domain'
import { formatCurrentTime } from '../context'
import { readApprovalNotificationSettings } from './approval-emails'
import { appBaseUrl, oneLine, renderDigest, splitRecipients, type DigestSection } from './format'
import { envMailer, isDeliverableAddress, type EmailMessage, type Mailer } from './mailer'

/**
 * Tells people when an agent has handed work to them (Handover rows, created by runAgent on
 * platform__escalate). Same pattern as approval emails: the worker's scheduler tick claims each
 * new handover once (Handover.notifiedAt) and emails one digest per recipient per tenant.
 *
 * Recipients: the agent contract's escalation destination when it is an email address, the
 * tenant's admins, and settings.notifications.approvalRecipients. Reserved domains are never
 * mailed; off without SMTP_HOST; tenants opt out with settings.notifications.handoverEmails =
 * false. The email carries the task and the agent's reason (redacted when the run recorded them),
 * since acting on a handover needs them, and links to the inbox.
 */

const DEFAULT_MAX_AGE_HOURS = 24

export interface HandoverEmailItem {
  agentName: string
  task: string
  reason: string
  severity: string
  at: Date
}

export function composeHandoverEmail(params: { to: string; tenantName: string; items: HandoverEmailItem[]; url: string; tenantSettings?: unknown }): EmailMessage {
  const { items, tenantName } = params
  const first = items[0]
  const subject = oneLine(items.length === 1 ? `${first.agentName} handed you a request: ${first.task}` : `${items.length} requests handed to you in ${tenantName}`).slice(0, 200)
  const sections: DigestSection[] = items.map((item) => ({
    title: item.task.length > 140 ? `${item.task.slice(0, 137)}…` : item.task,
    lines: [
      ['From', item.agentName],
      ['Why', item.reason.length > 600 ? `${item.reason.slice(0, 597)}…` : item.reason],
      ['Priority', item.severity],
      ['When', formatCurrentTime(params.tenantSettings, item.at).text],
    ],
  }))
  const { text, html } = renderDigest({
    intro: items.length === 1 ? `${first.agentName} stopped and handed this to a person in ${tenantName}.` : `Your agents handed ${items.length} requests to a person in ${tenantName}.`,
    sections,
    url: params.url,
    urlLabel: 'Open the handover inbox',
    note: 'The agent did nothing further. Deal with it yourself, then mark it handled in the inbox so the team knows.',
    why: `You're receiving this because you look after agents for ${tenantName}.`,
  })
  return { to: params.to, subject, text, html }
}

export interface NotifyHandoversOptions {
  now?: Date
  mailer?: Mailer | null
  appUrl?: string
  isDeliverable?: (email: string) => boolean
  maxAgeHours?: number
}

export async function notifyHandovers(options: NotifyHandoversOptions = {}): Promise<{ handovers: number; emailsSent: number; skipped: number; failed: number }> {
  const now = options.now ?? new Date()
  const { mailer } = options.mailer !== undefined ? { mailer: options.mailer } : envMailer()
  const isDeliverable = options.isDeliverable ?? isDeliverableAddress
  const result = { handovers: 0, emailsSent: 0, skipped: 0, failed: 0 }

  const candidates = await prisma.handover.findMany({
    where: { status: 'OPEN', notifiedAt: null, createdAt: { gte: new Date(now.getTime() - (options.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS) * 3_600_000) } },
    orderBy: { createdAt: 'asc' },
    take: 200,
  })
  const claimed: typeof candidates = []
  for (const h of candidates) {
    const { count } = await prisma.handover.updateMany({ where: { id: h.id, notifiedAt: null }, data: { notifiedAt: now } })
    if (count === 1) claimed.push(h)
  }
  result.handovers = claimed.length

  const byTenant = new Map<string, typeof claimed>()
  for (const h of claimed) byTenant.set(h.tenantId, [...(byTenant.get(h.tenantId) ?? []), h])

  for (const [tenantId, handovers] of Array.from(byTenant)) {
    try {
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, settings: true } })
      if (!tenant) continue
      const notifications = ((tenant.settings ?? {}) as { notifications?: Record<string, unknown> }).notifications ?? {}
      const audit = (h: (typeof handovers)[number], action: string, data: Record<string, unknown>) =>
        prisma.auditLog.create({ data: { tenantId, action, entityType: 'Handover', entityId: h.id, newData: { handoverId: h.id, runId: h.runId, agentId: h.agentId, ...data } as Prisma.InputJsonObject } })
      if (notifications.handoverEmails === false || !mailer) {
        for (const h of handovers) await audit(h, 'HANDOVER_NOTIFICATION_SKIPPED', { reason: mailer ? 'handover emails are turned off for this tenant' : 'email is not configured' })
        result.skipped += handovers.length
        continue
      }
      const { extraRecipients } = readApprovalNotificationSettings(tenant.settings)
      const [agents, admins] = await Promise.all([
        prisma.agent.findMany({ where: { id: { in: handovers.map((h) => h.agentId) } }, select: { id: true, name: true } }),
        prisma.user.findMany({ where: { tenantId }, select: { email: true, role: true } }),
      ])
      const agentName = new Map(agents.map((a) => [a.id, a.name]))
      const inbox = new Map<string, { email: string; items: Array<{ h: (typeof handovers)[number]; item: HandoverEmailItem }> }>()
      for (const h of handovers) {
        const { recipients, undeliverable } = splitRecipients(
          [...(h.destination.includes('@') ? [h.destination] : []), ...admins.filter((u) => canApprove(u.role, 'CUSTOMER_APPROVAL')).map((u) => u.email), ...extraRecipients],
          isDeliverable
        )
        if (!recipients.length) {
          await audit(h, 'HANDOVER_NOTIFICATION_SKIPPED', { reason: 'nobody to email (no deliverable address)', notMailed: undeliverable })
          result.skipped++
          continue
        }
        const item = { agentName: agentName.get(h.agentId) ?? 'An agent', task: h.task, reason: h.reason, severity: h.severity, at: h.createdAt }
        for (const email of recipients) {
          const entry = inbox.get(email.toLowerCase()) ?? { email, items: [] }
          entry.items.push({ h, item })
          inbox.set(email.toLowerCase(), entry)
        }
      }
      const delivered = new Map<string, string[]>()
      for (const { email, items } of Array.from(inbox.values())) {
        try {
          await mailer.send(composeHandoverEmail({ to: email, tenantName: tenant.name, items: items.map((i) => i.item), url: `${appBaseUrl(options.appUrl)}/dashboard/approvals#handovers`, tenantSettings: tenant.settings }))
          result.emailsSent++
          for (const { h } of items) delivered.set(h.id, [...(delivered.get(h.id) ?? []), email])
        } catch (error) {
          console.error(`Handover email to ${email} failed: ${safeErrorMessage(error)}`)
        }
      }
      for (const h of handovers) {
        if (!inbox.size) continue
        const emailed = delivered.get(h.id)
        if (emailed?.length) await audit(h, 'HANDOVER_NOTIFICATION_SENT', { emailed })
        else if ([...inbox.values()].some((e) => e.items.some((i) => i.h.id === h.id))) {
          await audit(h, 'HANDOVER_NOTIFICATION_FAILED', {})
          result.failed++
        }
      }
    } catch (error) {
      console.error(`Handover notifications for tenant ${tenantId} failed:`, safeErrorMessage(error))
      result.failed += handovers.length
    }
  }
  return result
}
