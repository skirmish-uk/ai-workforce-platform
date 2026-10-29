import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { hasPermission, safeErrorMessage } from '@ai-workforce/domain'
import { switchMailboxTools } from '@ai-workforce/executor'
import { UserRole } from '@prisma/client'
import { z } from 'zod'
import { tenantFor } from '../../../../../lib/tenant'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ to: z.enum(['email', 'gmail']), apply: z.boolean().default(false) })

/**
 * POST /api/integrations/email/agents { to: "email" | "gmail", apply }
 * Which agents would move to that mailbox (apply: false), or moves them (packages/executor/src/mailbox-switch.ts).
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(session.user.role as UserRole, 'integration:write') || !hasPermission(session.user.role as UserRole, 'agent:write')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'to must be "email" or "gmail"' }, { status: 400 })
  try {
    const result = await switchMailboxTools({ tenantId: tenantFor(session, request), to: parsed.data.to, apply: parsed.data.apply, actorUserId: session.user.id })
    return NextResponse.json({ data: result })
  } catch (error) {
    return NextResponse.json({ error: safeErrorMessage(error) }, { status: 400 })
  }
}
