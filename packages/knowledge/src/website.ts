import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import zlib from 'node:zlib'

/**
 * Reads a business's public website for onboarding (docs/ONBOARDING_WEBSITE.md): the home page
 * and the pages most likely to describe the business (about, services, pricing, contact, FAQ),
 * as plain text. Runs on the server, so it only ever talks to public addresses: every DNS
 * answer is checked (no loopback, private, link-local, metadata or other reserved ranges, on
 * every redirect), only http(s) on the default ports, with size, page-count and time limits.
 * robots.txt "Disallow" rules for all agents are respected.
 */

export interface CrawledPage {
  url: string
  title: string
  description: string
  text: string
}

export interface CrawlResult {
  origin: string
  pages: CrawledPage[]
  skipped: Array<{ url: string; reason: string }>
}

export class WebsiteFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebsiteFetchError'
  }
}

const USER_AGENT = 'AIWorkforceOnboarding/1.0 (+reads public pages once, when a customer asks)'
const MAX_PAGES = 10
const MAX_BYTES = 1_500_000
const MAX_TEXT_PER_PAGE = 12_000
const TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 4

/** Paths that usually say what a business does, best first. */
const PRIORITY = [/about|who-we-are|our-story|company/i, /services?|what-we-do|solutions|offer/i, /pric|packages|plans|rates|fees/i, /contact|location|find-us|visit|hours/i, /faq|questions|help/i, /team|people|staff/i, /products?|menu|shop/i, /testimonials|reviews|clients|work|case-stud/i]
const SKIP = /\.(pdf|jpe?g|png|gif|svg|webp|mp4|mp3|zip|docx?|xlsx?|pptx?|ics|xml|json|css|js)(\?|$)|\/(wp-admin|wp-login|cart|checkout|account|login|signin|signup|register|privacy|terms|cookie|feed|tag|category|author)(\/|$)|#/i

// ------------------------------------------------------------------------------ address checks

function ipv4Parts(ip: string): number[] {
  return ip.split('.').map(Number)
}

/** True for any address a server-side fetch must never reach. */
export function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ipv4Parts(ip)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase()
    if (v6 === '::' || v6 === '::1') return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
    if (mapped) return isBlockedAddress(mapped[1])
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6) || v6.startsWith('64:ff9b:') || v6.startsWith('2001:db8')
  }
  return true
}

type LookupFn = typeof dnsLookup

/** DNS lookup that refuses names resolving to a blocked address (checked on the address actually used). */
export const safeLookup: LookupFn = ((hostname: string, options: unknown, callback: unknown) => {
  const cb = (typeof options === 'function' ? options : callback) as (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void
  const opts = (typeof options === 'object' && options ? options : {}) as { all?: boolean }
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return cb(err)
    const list = addresses as LookupAddress[]
    if (!list.length || list.some((a) => isBlockedAddress(a.address))) {
      return cb(Object.assign(new Error(`${hostname} resolves to a private or reserved address`), { code: 'EBLOCKED' }))
    }
    if (opts.all) return cb(null, list)
    cb(null, list[0].address, list[0].family)
  })
}) as LookupFn

/** Throws unless the URL is a public http(s) address this crawler may fetch. */
export function checkUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`)
  } catch {
    throw new WebsiteFetchError('That isn’t a web address.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new WebsiteFetchError('Only http and https addresses can be read.')
  if (url.username || url.password) throw new WebsiteFetchError('Addresses with a username or password can’t be read.')
  if (url.port && url.port !== '80' && url.port !== '443') throw new WebsiteFetchError('Only websites on the standard ports can be read.')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) ? isBlockedAddress(host) : !host.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/i.test(host)) {
    throw new WebsiteFetchError('That address isn’t a public website.')
  }
  url.hash = ''
  return url
}

// ------------------------------------------------------------------------------ fetching

export interface FetchedDocument {
  url: string
  status: number
  contentType: string
  body: string
}

export type Fetcher = (url: URL) => Promise<FetchedDocument>

function requestOnce(url: URL): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.get(url, { lookup: safeLookup, timeout: TIMEOUT_MS, headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' } }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BYTES) { req.destroy(new WebsiteFetchError('Page too large')); return }
        chunks.push(chunk)
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new WebsiteFetchError('The website took too long to answer')))
    req.on('error', reject)
  })
}

function decode(body: Buffer, encoding: string | undefined): Buffer {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(body, { maxOutputLength: MAX_BYTES * 4 })
    if (encoding === 'deflate') return zlib.inflateSync(body, { maxOutputLength: MAX_BYTES * 4 })
    if (encoding === 'br') return zlib.brotliDecompressSync(body, { maxOutputLength: MAX_BYTES * 4 })
  } catch {
    throw new WebsiteFetchError('The page couldn’t be decoded')
  }
  return body
}

/** GET with redirects followed by hand, each hop checked like the first. */
export const fetchDocument: Fetcher = async (start) => {
  let url = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await requestOnce(url)
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      url = checkUrl(new URL(res.headers.location, url).toString())
      continue
    }
    const body = decode(res.body, String(res.headers['content-encoding'] ?? '').toLowerCase() || undefined)
    return { url: url.toString(), status: res.status, contentType: String(res.headers['content-type'] ?? ''), body: body.toString('utf8') }
  }
  throw new WebsiteFetchError('Too many redirects')
}

// ------------------------------------------------------------------------------ HTML to text

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', dollar: '$', euro: '€', pound: '£' }

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null
}

/** Page text a person would read: no scripts, styles, menus or cookie banners; headings and list items on their own lines. */
export function htmlToText(html: string): { title: string; description: string; text: string; links: string[] } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim()
  const metaTag = /<meta[^>]+name\s*=\s*["']description["'][^>]*>/i.exec(html)?.[0] ?? /<meta[^>]+property\s*=\s*["']og:description["'][^>]*>/i.exec(html)?.[0]
  const description = metaTag ? (attr(metaTag, 'content') ?? '').trim() : ''
  const links = Array.from(html.matchAll(/<a\b[^>]*>/gi)).map((m) => attr(m[0], 'href')).filter((h): h is string => Boolean(h))

  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, (block) => (block.length < 4000 ? ' ' : block))
    .replace(/<[^>]*(cookie|consent|gdpr)[^>]*>[\s\S]{0,2000}?<\/(div|section|aside)>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|table|header|main|aside|blockquote|dd|dt)>/gi, '\n')
    .replace(/<h[1-6]\b[^>]*>/gi, '\n\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
  const text = decodeEntities(body)
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((l, i, all) => l && l !== '-' && !(l.length < 3 && /^[|•\-–]+$/.test(l)) && all.indexOf(l) === i)
    .join('\n')
  return { title, description, text, links }
}

// ------------------------------------------------------------------------------ robots.txt

/** "Disallow" prefixes that apply to every crawler ("User-agent: *"). */
export function parseRobots(text: string): string[] {
  const disallow: string[] = []
  let applies = false
  let sawRule = false
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    const m = /^(user-agent|disallow|allow)\s*:\s*(.*)$/i.exec(line)
    if (!m) continue
    const [key, value] = [m[1].toLowerCase(), m[2].trim()]
    if (key === 'user-agent') {
      if (sawRule) { applies = false; sawRule = false }
      applies = applies || value === '*'
    } else {
      sawRule = true
      if (applies && key === 'disallow' && value) disallow.push(value)
    }
  }
  return disallow
}

// ------------------------------------------------------------------------------ crawl

function rank(url: URL): number {
  const path = url.pathname
  const i = PRIORITY.findIndex((re) => re.test(path))
  return (i === -1 ? PRIORITY.length : i) * 10 + path.split('/').filter(Boolean).length
}

/** The home page plus the most informative same-site pages, as text. */
export async function crawlWebsite(raw: string, options: { maxPages?: number; fetcher?: Fetcher } = {}): Promise<CrawlResult> {
  const start = checkUrl(raw)
  const fetcher = options.fetcher ?? fetchDocument
  const maxPages = Math.min(options.maxPages ?? MAX_PAGES, MAX_PAGES)
  const skipped: CrawlResult['skipped'] = []

  let disallow: string[] = []
  try {
    const robots = await fetcher(new URL('/robots.txt', start))
    if (robots.status === 200 && !/html/i.test(robots.contentType)) disallow = parseRobots(robots.body)
  } catch { /* no robots.txt */ }
  const allowed = (u: URL) => !disallow.some((prefix) => prefix === '/' ? true : u.pathname.startsWith(prefix))
  if (!allowed(start)) throw new WebsiteFetchError('This website asks not to be read by automated tools (robots.txt).')

  let home: FetchedDocument
  try {
    home = await fetcher(start)
  } catch (error) {
    throw new WebsiteFetchError(error instanceof WebsiteFetchError ? error.message : `Couldn’t reach ${start.hostname}: ${(error as Error).message}`)
  }
  if (home.status >= 400) throw new WebsiteFetchError(`${start.hostname} answered with an error (${home.status}).`)
  if (!/html|text\/plain/i.test(home.contentType)) throw new WebsiteFetchError('That address isn’t a web page.')
  const origin = new URL(home.url).origin
  const site = new URL(home.url).hostname.replace(/^www\./, '')

  const pages: CrawledPage[] = []
  const seen = new Set<string>()
  const key = (u: URL) => `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '') || '/'}`
  const add = (doc: FetchedDocument) => {
    const parsed = htmlToText(doc.body)
    seen.add(key(new URL(doc.url)))
    if (parsed.text.length > 80) pages.push({ url: doc.url, title: parsed.title, description: parsed.description, text: parsed.text.slice(0, MAX_TEXT_PER_PAGE) })
    return parsed.links
  }

  const candidates = new Map<string, URL>()
  for (const href of add(home)) {
    let u: URL
    try { u = new URL(href, home.url) } catch { continue }
    u.hash = ''
    u.search = ''
    if (u.hostname.replace(/^www\./, '') !== site || !/^https?:$/.test(u.protocol) || SKIP.test(u.pathname)) continue
    if (!seen.has(key(u)) && !candidates.has(key(u))) candidates.set(key(u), u)
  }
  const queue = Array.from(candidates.values()).sort((a, b) => rank(a) - rank(b))
  for (const u of queue) {
    if (pages.length >= maxPages) break
    if (!allowed(u)) { skipped.push({ url: u.toString(), reason: 'robots.txt' }); continue }
    try {
      const doc = await fetcher(checkUrl(u.toString()))
      if (doc.status >= 400 || !/html/i.test(doc.contentType)) { skipped.push({ url: u.toString(), reason: `status ${doc.status}` }); continue }
      if (seen.has(key(new URL(doc.url)))) continue
      add(doc)
    } catch (error) {
      skipped.push({ url: u.toString(), reason: (error as Error).message.slice(0, 120) })
    }
  }
  if (!pages.length) throw new WebsiteFetchError('No readable text was found on that website (it may need JavaScript to show anything).')
  return { origin, pages, skipped }
}
