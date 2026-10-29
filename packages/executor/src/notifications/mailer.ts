import nodemailer from 'nodemailer'
import { safeErrorMessage } from '@ai-workforce/domain'

/**
 * Outgoing email for platform notifications (approval requests today). Sending is off unless
 * SMTP_HOST is set: without it createMailerFromEnv() returns null and callers record the
 * notification as skipped instead of failing.
 */
export interface EmailMessage {
  to: string
  subject: string
  text: string
  html: string
}

export interface Mailer {
  /** Where mail goes, for logs (never includes credentials). */
  readonly description: string
  send(message: EmailMessage): Promise<void>
}

export interface MailerConfig {
  host: string
  port: number
  secure: boolean
  user?: string
  password?: string
  from: string
}

const truthy = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value ?? '')

/** Reads SMTP_* settings. Returns null (email off) when SMTP_HOST is unset; throws on a half-finished setup. */
export function mailerConfigFromEnv(env: Record<string, string | undefined> = process.env): MailerConfig | null {
  const host = env.SMTP_HOST?.trim()
  if (!host) return null
  const port = Number(env.SMTP_PORT?.trim() || 587)
  if (!Number.isInteger(port) || port <= 0) throw new Error(`SMTP_PORT "${env.SMTP_PORT}" is not a port number`)
  const user = env.SMTP_USER?.trim() || undefined
  const from = env.EMAIL_FROM?.trim() || (user?.includes('@') ? user : '')
  if (!from) throw new Error('SMTP_HOST is set but EMAIL_FROM is not (the address notifications are sent from)')
  return {
    host,
    port,
    // Port 465 is implicit TLS; 587/25 upgrade with STARTTLS.
    secure: env.SMTP_SECURE?.trim() ? truthy(env.SMTP_SECURE) : port === 465,
    user,
    password: env.SMTP_PASSWORD || undefined,
    from,
  }
}

export function createSmtpMailer(config: MailerConfig): Mailer {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
    // Message content is ours, but never let a message pull in local files or URLs.
    disableFileAccess: true,
    disableUrlAccess: true,
  })
  return {
    description: `SMTP ${config.host}:${config.port} as ${config.from}`,
    async send(message) {
      await transport.sendMail({ from: config.from, to: message.to, subject: message.subject, text: message.text, html: message.html })
    },
  }
}

export function createMailerFromEnv(env: Record<string, string | undefined> = process.env): Mailer | null {
  const config = mailerConfigFromEnv(env)
  return config ? createSmtpMailer(config) : null
}

let cachedEnvMailer: { mailer: Mailer | null; reason?: string } | undefined

/** The process-wide mailer from SMTP_* (built once). `reason` says why email is off when mailer is null. */
export function envMailer(): { mailer: Mailer | null; reason?: string } {
  if (!cachedEnvMailer) {
    try {
      const mailer = createMailerFromEnv()
      cachedEnvMailer = mailer ? { mailer } : { mailer: null, reason: 'email is not configured (SMTP_HOST is not set)' }
    } catch (error) {
      console.error(`Notification emails are off: ${safeErrorMessage(error)}`)
      cachedEnvMailer = { mailer: null, reason: `email is misconfigured: ${safeErrorMessage(error)}` }
    }
  }
  return cachedEnvMailer
}

/**
 * Domains reserved for documentation and testing (RFC 2606/6761), plus `.local`: the demo and
 * test users live there. Mail to them could only bounce, so it is never attempted.
 */
const RESERVED_TLDS = ['local', 'localhost', 'test', 'example', 'invalid', 'internal']
const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net']

export function isDeliverableAddress(email: string): boolean {
  const match = /^[^\s@<>,;]+@([^\s@<>,;]+\.[^\s@<>,;]+)$/.exec(email.trim())
  if (!match) return false
  const domain = match[1].toLowerCase().replace(/\.$/, '')
  const tld = domain.split('.').pop()!
  return !RESERVED_TLDS.includes(tld) && !RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))
}
