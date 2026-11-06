import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { canAccessTenant, hasPermission } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'

/** GET /api/revisions/[id] — full revision: proposed spec, previous spec, risk assessment and pipeline results. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const role = session.user.role as UserRole
    const { id } = await params
    const revision = await prisma.agentRevision.findUnique({ where: { id } })
    if (!revision || !canAccessTenant(role, session.user.tenantId, revision.tenantId)) {
      return NextResponse.json({ error: 'Revision not found' }, { status: 404 })
    }
    if (!hasPermission(role, 'agent:read')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    return NextResponse.json(revision)
  } catch (error) {
    console.error('Error fetching revision:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
