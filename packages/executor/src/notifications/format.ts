/** Shared pieces of the notification emails (approval-emails.ts, action-emails.ts). */

/** "gmail__send_email" -> "Gmail: send email"; anything else is tidied up as-is. */
export function describeAction(action: string): string {
  const [service, name] = action.includes('__') ? action.split('__', 2) : [null, action]
  const words = (s: string) => s.replace(/[-_]+/g, ' ').trim()
  const tool = words(name ?? action)
  if (!service) return tool.charAt(0).toUpperCase() + tool.slice(1)
  const serviceName = words(service).replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bCrm\b/, 'CRM').replace(/\bHubspot\b/, 'HubSpot')
  return `${serviceName}: ${tool}`
}

export const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export interface DigestSection {
  title: string
  lines: Array<[label: string, value: string]>
}

/** Renders the plain-text and HTML bodies every notification email shares. */
export function renderDigest(params: { intro: string; sections: DigestSection[]; url: string; urlLabel: string; note: string; why: string }): { text: string; html: string } {
  const sections = params.sections.map((s) => ({ title: oneLine(s.title), lines: s.lines.map(([k, v]) => [k, oneLine(v)] as [string, string]) }))
  const numbered = sections.length > 1

  const text = [
    params.intro,
    '',
    ...sections.flatMap((s, i) => [`${numbered ? `${i + 1}. ` : ''}${s.title}`, ...s.lines.map(([k, v]) => `   ${k}: ${v}`), '']),
    `${params.urlLabel}: ${params.url}`,
    '',
    params.note,
    params.why,
  ].join('\n')

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#171717">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;border:1px solid #e5e5e5">
<p style="margin:0 0 16px;font-size:16px">${escapeHtml(params.intro)}</p>
${sections
  .map(
    (s) => `<div style="border:1px solid #e5e5e5;border-radius:8px;padding:12px 16px;margin:0 0 12px">
<p style="margin:0 0 8px;font-weight:600">${escapeHtml(s.title)}</p>
<table style="border-collapse:collapse;font-size:14px">${s.lines
      .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#737373;vertical-align:top">${escapeHtml(k)}</td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`)
      .join('')}</table>
</div>`
  )
  .join('\n')}
<p style="margin:20px 0"><a href="${escapeHtml(params.url)}" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${escapeHtml(params.urlLabel)}</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#525252">${escapeHtml(params.note)}</p>
<p style="margin:0;font-size:12px;color:#a3a3a3">${escapeHtml(params.why)}</p>
</div></body></html>`

  return { text, html }
}

/** Base URL for links in emails: APP_URL, then NEXTAUTH_URL. */
export function appBaseUrl(override?: string): string {
  return (override ?? process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
}

/** Lower-cased de-duplication that keeps the first spelling, then splits by deliverability. */
export function splitRecipients(wanted: string[], isDeliverable: (email: string) => boolean): { recipients: string[]; undeliverable: string[] } {
  const unique = Array.from(new Map(wanted.filter(Boolean).map((e) => [e.trim().toLowerCase(), e.trim()])).values())
  return { recipients: unique.filter((e) => isDeliverable(e)), undeliverable: unique.filter((e) => !isDeliverable(e)) }
}
