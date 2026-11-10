import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, safeErrorMessage } from '@ai-workforce/domain'
import { GOOGLE_SERVICES, exchangeGoogleCode, grantedServices, verifyOAuthState } from '@ai-workforce/integrations'
import { storeOAuthConnection } from '@ai-workforce/tools'
import { UserRole } from '@prisma/client'
import { GOOGLE_NONCE_COOKIE, backToIntegrations, googleRedirectUri } from '../shared'

export const dynamic = 'force-dynamic'

/**
 * GET /api/integrations/google/callback?code=…&state=…
 * Google sends the admin back here. Verifies the signed state against the signed-in user and
 * the nonce cookie, exchanges the code, and stores the tokens encrypted on the Gmail /
 * Google Calendar connections (leaving sandbox mode). Tokens never reach the browser or logs.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const done = (outcome: string, extra: Record<string, string> = {}) => {
    const response = backToIntegrations(outcome, extra)
    response.cookies.set(GOOGLE_NONCE_COOKIE, '', { path: '/api/integrations/google', maxAge: 0 })
    return response
  }

  // The user pressed "Cancel" on Google's screen, or Google refused the request.
  if (params.get('error')) return done('error', { reason: params.get('error') === 'access_denied' ? 'cancelled' : 'google_error' })

  const session = await getServerSession(authOptions)
  if (!session?.user) return done('error', { reason: 'signed_out' })

  const verified = verifyOAuthState(params.get('state'), process.env.NEXTAUTH_SECRET ?? '', request.cookies.get(GOOGLE_NONCE_COOKIE)?.value)
  if (!verified.ok) return done('error', { reason: 'invalid_state' })
  const { payload } = verified
  // The flow must finish as the same person, in the same tenant, who started it.
  if (payload.userId !== session.user.id || payload.tenantId !== session.user.tenantId || !hasPermission(session.user.role as UserRole, 'integration:write')) {
    return done('error', { reason: 'invalid_state' })
  }

  const code = params.get('code')
  if (!code) return done('error', { reason: 'no_code' })

  let exchanged: Awaited<ReturnType<typeof exchangeGoogleCode>>
  try {
    exchanged = await exchangeGoogleCode(code, googleRedirectUri())
  } catch (error) {
    console.error('Google code exchange failed:', safeErrorMessage(error))
    return done('error', { reason: 'exchange_failed' })
  }
  const { credentials, email } = exchanged
  if (!credentials.refresh_token) {
    // Without a refresh token the connection dies after an hour; don't store a connection that will silently break.
    return done('error', { reason: 'no_refresh_token' })
  }

  const { granted, missing } = grantedServices(credentials.scope, payload.services)
  if (!granted.length) return done('error', { reason: 'scopes_not_granted' })

  for (const service of granted) {
    const { integrationName, scopes } = GOOGLE_SERVICES[service]
    const stored = await storeOAuthConnection({
      tenantId: payload.tenantId,
      name: integrationName,
      provider: 'google',
      scopes,
      credentials: credentials as Record<string, unknown>,
      account: email,
      connectedByUserId: session.user.id,
    })
    await prisma.auditLog.create({
      data: {
        action: 'INTEGRATION_CONNECTED',
        entityType: 'Integration',
        entityId: stored.id,
        tenantId: payload.tenantId,
        userId: session.user.id,
        newData: { name: integrationName, provider: 'google', account: email, scopes: [...scopes], created: stored.created },
      },
    })
  }

  return done('connected', { services: granted.join(','), ...(missing.length ? { missing: missing.join(',') } : {}) })
}
