import { NextRequest, NextResponse } from 'next/server'

/**
 * Optional site-wide password for public demo deployments (docs/DEPLOY.md). The demo logins
 * are public in this repo and the app runs on real API keys, so a demo on the open internet
 * sits behind HTTP Basic auth: set SITE_PASSWORD (and optionally SITE_USERNAME, default
 * "demo"). Unset = no site password (local development).
 *
 * /api/health stays open for uptime checks; it reveals only up/down.
 */
const OPEN_PATHS = ['/api/health']

function safeEqual(a: string, b: string): boolean {
  // Constant-time comparison (the Edge runtime has no crypto.timingSafeEqual).
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

export function middleware(request: NextRequest) {
  const password = process.env.SITE_PASSWORD
  if (!password || OPEN_PATHS.includes(request.nextUrl.pathname)) return NextResponse.next()

  const username = process.env.SITE_USERNAME || 'demo'
  const header = request.headers.get('authorization') ?? ''
  if (header.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice(6))
      const split = decoded.indexOf(':')
      if (split > -1 && safeEqual(decoded.slice(0, split), username) && safeEqual(decoded.slice(split + 1), password)) {
        return NextResponse.next()
      }
    } catch {
      // Malformed header: fall through to the challenge.
    }
  }
  return new NextResponse('Password required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="AI Workforce demo", charset="UTF-8"' } })
}

export const config = {
  // Everything except Next's static assets and the icons (browsers fetch favicons without credentials).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png).*)'],
}
