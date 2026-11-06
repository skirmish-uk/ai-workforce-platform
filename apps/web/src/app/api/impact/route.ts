import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { hasPermission } from '@ai-workforce/domain'
import { getImpact } from '@ai-workforce/executor'
import type { UserRole } from '@prisma/client'
import { tenantFor } from '../../../lib/tenant'

export const dynamic = 'force-dynamic'

/** GET /api/impact?days=7|30|90 — what the team did and what it was worth (docs/IMPACT.md). */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(session.user.role as UserRole, 'agent:read')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const asked = Number(request.nextUrl.searchParams.get('days'))
  const days = [1, 7, 30, 90].includes(asked) ? asked : 7
  return NextResponse.json(await getImpact({ tenantId: tenantFor(session, request), days }))
}
