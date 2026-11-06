import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { canApprove } from '@ai-workforce/domain'
import { STOCK_VOICES, cloneScript } from '@ai-workforce/executor'
import { CLONE_MAX_SECONDS, CLONE_MIN_SECONDS } from '@ai-workforce/llm'
import type { UserRole } from '@prisma/client'

export const dynamic = 'force-dynamic'

/**
 * GET /api/voice/clone-setup: what the new-agent form needs before the agent exists: the stock
 * voices, whether "Use your own voice" is available to this user, and the script to read.
 */
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const tenant = await prisma.tenant.findUnique({ where: { id: session.user.tenantId }, select: { name: true } })
  const cartesia = Boolean(process.env.CARTESIA_API_KEY)
  return NextResponse.json({
    available: cartesia,
    canChange: canApprove(session.user.role as UserRole, 'CUSTOMER_APPROVAL'),
    businessName: tenant?.name ?? 'your business',
    minSeconds: CLONE_MIN_SECONDS,
    maxSeconds: CLONE_MAX_SECONDS,
    script: cloneScript('{name}', tenant?.name ?? 'your business'),
    stockVoices: cartesia ? STOCK_VOICES : [],
  })
}
