import { NextResponse } from 'next/server'

/** Cookie holding the nonce that the signed OAuth state must match (set on connect, cleared on callback). */
export const GOOGLE_NONCE_COOKIE = 'google_oauth_nonce'

/**
 * Where Google sends the user back. Must be listed exactly in the Google Cloud console's
 * "Authorised redirect URIs" (including the ngrok URL when sharing a demo).
 */
export function googleRedirectUri(): string {
  if (process.env.GOOGLE_REDIRECT_URI?.trim()) return process.env.GOOGLE_REDIRECT_URI.trim()
  return `${(process.env.NEXTAUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/api/integrations/google/callback`
}

/** Back to the integrations page with an outcome the page explains (?google=connected, ?google=error&reason=…). */
export function backToIntegrations(outcome: string, extra: Record<string, string> = {}): NextResponse {
  const base = (process.env.NEXTAUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  const url = new URL('/dashboard/integrations', base)
  url.searchParams.set('google', outcome)
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v)
  return NextResponse.redirect(url)
}
