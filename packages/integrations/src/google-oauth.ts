import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { google } from 'googleapis'
import { fromGoogleTokens, type OAuthCredentials } from './base'
import { gmailAdapter } from './gmail'
import { calendarAdapter } from './calendar'

/**
 * "Connect Google": one consent screen for the Google services a tenant wants its agents to
 * use. The web routes (apps/web/src/app/api/integrations/google/*) call these; everything
 * here is free of Next.js so it can be unit-tested.
 *
 * Each service maps to the Integration row its adapter's tools look up by name
 * (packages/tools getIntegrationForAdapter), so connecting "gmail" makes gmail__* tools use
 * the real mailbox.
 */
export const GOOGLE_SERVICES = {
  gmail: { integrationName: gmailAdapter.name, scopes: gmailAdapter.requiredScopes },
  calendar: { integrationName: calendarAdapter.name, scopes: calendarAdapter.requiredScopes },
} as const
export type GoogleService = keyof typeof GOOGLE_SERVICES

/** Identity scopes, so the page can say which account is connected. */
const IDENTITY_SCOPES = ['openid', 'email']

/** How long a user has to finish the Google consent screen. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

export function parseGoogleServices(value: string | null | undefined): GoogleService[] {
  const wanted = (value ?? 'gmail,calendar').split(',').map((s) => s.trim()).filter(Boolean)
  const services = wanted.filter((s): s is GoogleService => s in GOOGLE_SERVICES)
  return Array.from(new Set(services))
}

export function googleOAuthConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim())
}

// ---------------------------------------------------------------------------------------------
// Signed state: binds the callback to the tenant and user who started the flow (CSRF), and to
// a nonce kept in an httpOnly cookie, so a callback link from someone else's flow is refused.
// ---------------------------------------------------------------------------------------------

export interface OAuthStatePayload {
  tenantId: string
  userId: string
  services: GoogleService[]
  nonce: string
  /** Epoch ms after which the state is refused. */
  exp: number
}

const b64url = (buf: Buffer) => buf.toString('base64url')
const sign = (data: string, secret: string) => b64url(createHmac('sha256', secret).update(data).digest())

export function newOAuthNonce(): string {
  return b64url(randomBytes(18))
}

export function createOAuthState(payload: OAuthStatePayload, secret: string): string {
  if (!secret) throw new Error('A signing secret (NEXTAUTH_SECRET) is required for OAuth state')
  const data = b64url(Buffer.from(JSON.stringify(payload)))
  return `${data}.${sign(data, secret)}`
}

/** Returns the payload when the signature, expiry and nonce all check out; otherwise the reason it was refused. */
export function verifyOAuthState(
  state: string | null | undefined,
  secret: string,
  expectedNonce: string | null | undefined,
  now = Date.now()
): { ok: true; payload: OAuthStatePayload } | { ok: false; reason: string } {
  if (!state || !secret) return { ok: false, reason: 'missing state' }
  const [data, signature] = state.split('.')
  if (!data || !signature) return { ok: false, reason: 'malformed state' }
  const expected = Buffer.from(sign(data, secret))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad signature' }
  let payload: OAuthStatePayload
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed state' }
  }
  if (typeof payload.exp !== 'number' || payload.exp < now) return { ok: false, reason: 'expired' }
  if (!expectedNonce || payload.nonce !== expectedNonce) return { ok: false, reason: 'nonce mismatch (started in another browser?)' }
  return { ok: true, payload }
}

// ---------------------------------------------------------------------------------------------

function oauthClient(redirectUri: string, env: Record<string, string | undefined>) {
  return new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, redirectUri)
}

export function googleConnectUrl(redirectUri: string, state: string, services: GoogleService[], env: Record<string, string | undefined> = process.env): string {
  const scopes = Array.from(new Set([...IDENTITY_SCOPES, ...services.flatMap((s) => GOOGLE_SERVICES[s].scopes)]))
  return oauthClient(redirectUri, env).generateAuthUrl({
    access_type: 'offline', // a refresh token, so agents keep working after the hour-long access token expires
    prompt: 'consent', // Google only returns a refresh token on consent
    include_granted_scopes: true,
    scope: scopes,
    state,
  })
}

/** Which of the requested services the user actually granted (Google lets users untick scopes). */
export function grantedServices(grantedScope: string | undefined, requested: GoogleService[]): { granted: GoogleService[]; missing: GoogleService[] } {
  const scopes = new Set((grantedScope ?? '').split(/\s+/).filter(Boolean))
  const granted = requested.filter((s) => GOOGLE_SERVICES[s].scopes.every((scope) => scopes.has(scope)))
  return { granted, missing: requested.filter((s) => !granted.includes(s)) }
}

/** The account's email from the ID token. It came straight from Google's token endpoint over TLS, so it is not re-verified. */
export function emailFromIdToken(idToken: string | null | undefined): string | null {
  if (!idToken) return null
  try {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'))
    return typeof claims.email === 'string' ? claims.email : null
  } catch {
    return null
  }
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  env: Record<string, string | undefined> = process.env
): Promise<{ credentials: OAuthCredentials; email: string | null }> {
  const { tokens } = await oauthClient(redirectUri, env).getToken(code)
  return { credentials: fromGoogleTokens(tokens), email: emailFromIdToken(tokens.id_token) }
}

/** Best effort: revokes the grant at Google so the app loses access, not just forgets the token. */
export async function revokeGoogleToken(token: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  try {
    await oauthClient('', env).revokeToken(token)
    return true
  } catch {
    return false
  }
}
