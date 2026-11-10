import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission } from '@ai-workforce/domain'
import { GOOGLE_SERVICES, googleOAuthConfigured, type GoogleService } from '@ai-workforce/integrations'
import { encryptionConfigured, isPlaceholderCredentials } from '@ai-workforce/tools'
import { UserRole } from '@prisma/client'
import { googleRedirectUri } from './shared'

export const dynamic = 'force-dynamic'

/** GET /api/integrations/google: whether "Connect Google" can work here, and each service's state. */
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(session.user.role as UserRole, 'integration:read')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const names = Object.values(GOOGLE_SERVICES).map((s) => s.integrationName)
  const rows = await prisma.integration.findMany({ where: { tenantId: session.user.tenantId, name: { in: names } }, orderBy: { createdAt: 'asc' } })
  const services = (Object.keys(GOOGLE_SERVICES) as GoogleService[]).map((service) => {
    const row = rows.find((r) => r.name === GOOGLE_SERVICES[service].integrationName)
    const config = (row?.config ?? {}) as Record<string, unknown>
    const state = !row || !row.isActive ? 'not_connected' : config.sandbox === true ? 'sandbox' : isPlaceholderCredentials(row.credentials) ? 'not_connected' : 'connected'
    return { service, name: GOOGLE_SERVICES[service].integrationName, state, account: state === 'connected' ? (config.connectedAccount as string | null) ?? null : null, connectedAt: state === 'connected' ? (config.connectedAt as string | null) ?? null : null }
  })
  return NextResponse.json({
    data: {
      configured: googleOAuthConfigured(),
      encryption: encryptionConfigured(),
      canManage: hasPermission(session.user.role as UserRole, 'integration:write'),
      redirectUri: googleRedirectUri(),
      services,
    },
  })
}
