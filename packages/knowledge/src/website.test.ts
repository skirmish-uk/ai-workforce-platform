import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkUrl, crawlWebsite, htmlToText, isBlockedAddress, parseRobots, safeLookup, type FetchedDocument } from './website'

test('private, loopback, link-local and metadata addresses are blocked; public ones are not', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) {
    assert.equal(isBlockedAddress(ip), true, ip)
  }
  for (const ip of ['1.1.1.1', '142.250.70.78', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isBlockedAddress(ip), false, ip)
})

test('only public http(s) web addresses are accepted', () => {
  assert.equal(checkUrl('example.com').toString(), 'https://example.com/')
  for (const bad of ['http://localhost:3000', 'http://127.0.0.1', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd', 'http://user:pw@example.com', 'http://example.com:8080', 'http://intranet', 'http://printer.local', 'http://[::1]/']) {
    assert.throws(() => checkUrl(bad), Error, bad)
  }
})

test('a name that resolves to a private address is refused at connect time', async () => {
  const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => safeLookup('localhost', {}, (e) => resolve(e)))
  assert.equal(err?.code, 'EBLOCKED')
})

test('page text keeps what a person reads and drops scripts, styles and menus', () => {
  const page = htmlToText(`<html><head><title>Harbour &amp; Co | Dentists</title><meta name="description" content="Family dentists in Manly"><style>body{}</style></head>
    <body><nav><a href="/about">About</a></nav><script>track()</script><h1>Welcome</h1><p>Open Mon&ndash;Fri, 8am to 6pm.</p><ul><li>Check-ups $95</li><li>Whitening</li></ul>
    <footer>© 2026</footer></body></html>`)
  assert.equal(page.title, 'Harbour & Co | Dentists')
  assert.equal(page.description, 'Family dentists in Manly')
  assert.match(page.text, /Welcome\nOpen Mon–Fri, 8am to 6pm\.\n- Check-ups \$95\n- Whitening/)
  assert.doesNotMatch(page.text, /track\(\)|body\{\}|©/)
  assert.deepEqual(page.links, ['/about'])
})

test('robots.txt rules for every crawler are read', () => {
  assert.deepEqual(parseRobots('User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /private\nAllow: /\n# x\nDisallow: /admin'), ['/private', '/admin'])
})

test('crawl: home page first, then the most informative same-site pages; robots, other sites and files are skipped', async () => {
  const site: Record<string, string> = {
    'https://harbour.example/robots.txt': 'User-agent: *\nDisallow: /secret',
    'https://harbour.example/': '<title>Home</title><a href="/services">Services</a><a href="/blog/post-1">Post</a><a href="/contact-us">Contact</a><a href="/secret/x">S</a><a href="https://other.example/x">O</a><a href="/brochure.pdf">B</a><p>We are a family dental practice in Manly with three dentists and late opening.</p>',
    'https://harbour.example/services': '<title>Services</title><p>Check-ups and cleans, whitening, Invisalign and emergency appointments every day.</p>',
    'https://harbour.example/contact-us': '<title>Contact</title><p>Call 02 5550 1234 or visit 12 The Corso, Manly NSW. Open Monday to Saturday.</p>',
    'https://harbour.example/blog/post-1': '<title>Post</title><p>Five tips for healthy teeth this summer, from our hygienist team at the practice.</p>',
  }
  const fetched: string[] = []
  const fetcher = async (u: URL): Promise<FetchedDocument> => {
    fetched.push(u.toString())
    const body = site[u.toString()]
    return { url: u.toString(), status: body ? 200 : 404, contentType: u.pathname === '/robots.txt' ? 'text/plain' : 'text/html', body: body ?? '' }
  }
  const out = await crawlWebsite('harbour.example', { fetcher, maxPages: 3 })
  assert.deepEqual(out.pages.map((p) => p.title), ['Home', 'Services', 'Contact'], 'services and contact outrank the blog')
  assert.ok(!fetched.some((u) => u.includes('other.example') || u.endsWith('.pdf') || u.includes('/secret')))
})
