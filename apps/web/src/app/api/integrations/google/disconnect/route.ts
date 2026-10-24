import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission } from '@ai-workforce/domain'
import { GOOGLE_SERVICES, parseGoogleServices, revokeGoogleToken } from '@ai-workforce/integrations'
import { removeOAuthConnection } from '@ai-workforce/tools'
import { UserRole } from '@prisma/client'

export const dynamic = 'force-dynamic'

/**
 * POST /api/integrations/google/disconnect  { "services": "gmail,calendar" }
 * Clears the stored tokens, deactivates the connections, and revokes the grant at Google.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(session.user.role as UserRole, 'integration:write')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as { services?: string }
  const services = parseGoogleServices(body.services)
  const tenantId = session.user.tenantId
  const results: Array<{ service: string; removed: boolean; revoked: boolean }> = []
  for (const service of services) {
    const name = GOOGLE_SERVICES[service].integrationName
    const { removed, credentials } = await removeOAuthConnection(tenantId, name)
    const token = (credentials?.refresh_token ?? credentials?.access_token) as string | undefined
    const revoked = token ? await revokeGoogleToken(token) : false
    results.push({ service, removed, revoked })
    if (removed) {
      await prisma.auditLog.create({
        data: { action: 'INTEGRATION_DISCONNECTED', entityType: 'Integration', entityId: name, tenantId, userId: session.user.id, newData: { name, provider: 'google', revoked } },
      })
    }
  }
  return NextResponse.json({ data: results })
}
