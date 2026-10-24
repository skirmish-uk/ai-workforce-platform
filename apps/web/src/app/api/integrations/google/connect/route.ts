import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { hasPermission } from '@ai-workforce/domain'
import { OAUTH_STATE_TTL_MS, createOAuthState, googleConnectUrl, googleOAuthConfigured, newOAuthNonce, parseGoogleServices } from '@ai-workforce/integrations'
import { encryptionConfigured } from '@ai-workforce/tools'
import { UserRole } from '@prisma/client'
import { NextResponse } from 'next/server'
import { GOOGLE_NONCE_COOKIE, backToIntegrations, googleRedirectUri } from '../shared'

export const dynamic = 'force-dynamic'

/**
 * GET /api/integrations/google/connect?services=gmail,calendar
 * Starts "Connect Google": sends the admin to Google's consent screen with a signed state.
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.redirect(new URL('/auth/signin', request.url))
  if (!hasPermission(session.user.role as UserRole, 'integration:write')) return backToIntegrations('error', { reason: 'forbidden' })
  if (!googleOAuthConfigured()) return backToIntegrations('not_configured')
  // Tokens are only ever stored encrypted; refuse before sending anyone to Google.
  if (!encryptionConfigured()) return backToIntegrations('error', { reason: 'no_encryption_key' })

  const services = parseGoogleServices(request.nextUrl.searchParams.get('services'))
  if (!services.length) return backToIntegrations('error', { reason: 'no_services' })

  const nonce = newOAuthNonce()
  const state = createOAuthState(
    { tenantId: session.user.tenantId, userId: session.user.id, services, nonce, exp: Date.now() + OAUTH_STATE_TTL_MS },
    process.env.NEXTAUTH_SECRET ?? ''
  )
  const response = NextResponse.redirect(googleConnectUrl(googleRedirectUri(), state, services))
  response.cookies.set(GOOGLE_NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: 'lax', // sent on Google's top-level redirect back to us
    secure: request.nextUrl.protocol === 'https:',
    path: '/api/integrations/google',
    maxAge: OAUTH_STATE_TTL_MS / 1000,
  })
  return response
}
