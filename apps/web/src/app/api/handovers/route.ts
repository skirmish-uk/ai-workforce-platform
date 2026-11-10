import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission } from '@ai-workforce/domain'
import { UserRole } from '@prisma/client'

export const dynamic = 'force-dynamic'

/**
 * GET /api/handovers?status=open|resolved|all — work agents handed to a person (platform__escalate),
 * newest first, with the agent's name and who resolved it. Platform roles may pass ?tenantId=.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const role = session.user.role as UserRole
    if (!hasPermission(role, 'agent:read')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const params = new URL(request.url).searchParams
    const isPlatform = role === 'PLATFORM_ADMIN' || role === 'PLATFORM_OPERATOR'
    const tenantId = isPlatform && params.get('tenantId') ? params.get('tenantId')! : session.user.tenantId
    const status = (params.get('status') ?? 'open').toLowerCase()
    if (!['open', 'resolved', 'all'].includes(status)) return NextResponse.json({ error: 'status must be open, resolved or all' }, { status: 400 })

    const handovers = await prisma.handover.findMany({
      where: { tenantId, ...(status === 'all' ? {} : { status: status === 'open' ? 'OPEN' : 'RESOLVED' }) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    const agentIds = Array.from(new Set(handovers.map((h) => h.agentId)))
    const userIds = Array.from(new Set(handovers.map((h) => h.resolvedById).filter((x): x is string => Boolean(x))))
    const [agents, users] = await Promise.all([
      prisma.agent.findMany({ where: { id: { in: agentIds }, tenantId }, select: { id: true, name: true } }),
      prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }),
    ])
    const agentName = new Map(agents.map((a) => [a.id, a.name]))
    const userName = new Map(users.map((u) => [u.id, u.name ?? u.email]))
    const open = await prisma.handover.count({ where: { tenantId, status: 'OPEN' } })
    return NextResponse.json({
      open,
      data: handovers.map((h) => ({ ...h, agentName: agentName.get(h.agentId) ?? null, resolvedBy: h.resolvedById ? userName.get(h.resolvedById) ?? null : null })),
    })
  } catch (error) {
    console.error('Error listing handovers:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
