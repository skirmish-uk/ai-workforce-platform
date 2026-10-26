/**
 * Operational alerts (site down, backup missed, a new kind of server error) sent to one
 * webhook: ALERT_WEBHOOK_URL. Works with ntfy (plain text; subscribe to the topic in the ntfy
 * app), Slack incoming webhooks and Discord webhooks. Unset: alerts are only logged. See
 * docs/DEPLOY.md "Backups and alerts".
 */

export type AlertTarget = 'slack' | 'discord' | 'text'

export function alertTarget(url: string): AlertTarget {
  if (/^https:\/\/hooks\.slack\.com\//.test(url)) return 'slack'
  if (/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//.test(url)) return 'discord'
  return 'text'
}

/** The request body each kind of webhook expects. */
export function alertRequest(url: string, title: string, message: string): { headers: Record<string, string>; body: string } {
  const text = `${title}\n${message}`.trim()
  switch (alertTarget(url)) {
    case 'slack':
      return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }
    case 'discord':
      return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900) }) }
    default:
      // ntfy reads the title from a header and the message from the body.
      return { headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: title.replace(/[^\x20-\x7e]/g, '').slice(0, 200) }, body: message.slice(0, 3500) }
  }
}

/** Sends an alert, never throwing: an alert that can't be delivered is logged instead. */
export async function sendAlert(title: string, message: string, env: Record<string, string | undefined> = process.env, deps: { fetch?: typeof fetch } = {}): Promise<boolean> {
  const url = env.ALERT_WEBHOOK_URL?.trim()
  console.warn(`[alert] ${title}: ${message}`)
  if (!url) return false
  try {
    const { headers, body } = alertRequest(url, title, message)
    const res = await (deps.fetch ?? fetch)(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) console.error(`[alert] webhook returned ${res.status}`)
    return res.ok
  } catch (error) {
    console.error('[alert] webhook failed:', error instanceof Error ? error.message : error)
    return false
  }
}
