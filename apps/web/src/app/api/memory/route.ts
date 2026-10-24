import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, redactString } from '@ai-workforce/domain'
import { MEMORY_CATEGORIES, MEMORY_MAX_CHARS, MAX_MEMORIES_PER_TENANT } from '@ai-workforce/executor'
import type { Prisma, UserRole } from '@prisma/client'
import { z } from 'zod'
import { tenantFor } from '../../../lib/tenant'

export const dynamic = 'force-dynamic'

/**
 * GET  /api/memory?status=&q=&category= — what the team knows (docs/MEMORY.md), newest first,
 *      with where each memory came from and how often agents have used it.
 * POST { content, category, subject?, agentId? } — a person adds one (trusted, used at once).
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(session.user.role as UserRole, 'agent:read')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const tenantId = tenantFor(session, request)
  const params = request.nextUrl.searchParams
  const status = params.get('status')
  const category = params.get('category')
  const q = params.get('q')?.trim()
  const where: Prisma.MemoryWhereInput = {
    tenantId,
    status: status && ['ACTIVE', 'PENDING', 'ARCHIVED'].includes(status) ? status : { not: 'ARCHIVED' },
    ...(category && (MEMORY_CATEGORIES as readonly string[]).includes(category) ? { category } : {}),
    ...(q ? { OR: [{ content: { contains: q, mode: 'insensitive' } }, { subject: { contains: q, mode: 'insensitive' } }] } : {}),
  }
  const [memories, counts, agents] = await Promise.all([
    prisma.memory.findMany({ where, orderBy: [{ status: 'desc' }, { updatedAt: 'desc' }], take: 300 }),
    prisma.memory.groupBy({ by: ['status'], where: { tenantId }, _count: true }),
    prisma.agent.findMany({ where: { tenantId, isCandidate: false }, select: { id: true, name: true } }),
  ])
  const names = new Map(agents.map((a) => [a.id, a.name]))
  const userIds = Array.from(new Set(memories.flatMap((m) => [m.createdById, m.reviewedById]).filter((id): id is string => Boolean(id))))
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : []
  const person = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? users.find((u) => u.id === id)?.email ?? 'a person') : null)
  return NextResponse.json({
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    agents: agents.map((a) => ({ id: a.id, name: a.name })),
    memories: memories.map((m) => ({
      id: m.id,
      content: m.content,
      category: m.category,
      subject: m.subject,
      status: m.status,
      trust: m.trust,
      forAgent: m.agentId ? { id: m.agentId, name: names.get(m.agentId) ?? 'an agent' } : null,
      learnedBy: m.learnedById ? names.get(m.learnedById) ?? 'an agent' : null,
      addedBy: person(m.createdById),
      reviewedBy: person(m.reviewedById),
      source: m.source,
      useCount: m.useCount,
      lastUsedAt: m.lastUsedAt,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    })),
  })
}

const addSchema = z.object({
  content: z.string().trim().min(3).max(MEMORY_MAX_CHARS),
  category: z.enum(MEMORY_CATEGORIES),
  subject: z.string().trim().max(120).optional().nullable(),
  agentId: z.string().optional().nullable(),
})

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(session.user.role as UserRole, 'agent:write')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const tenantId = tenantFor(session, request)
  const parsed = addSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid memory' }, { status: 400 })
  const { content, category, subject, agentId } = parsed.data
  if (agentId && !(await prisma.agent.findFirst({ where: { id: agentId, tenantId } }))) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  if ((await prisma.memory.count({ where: { tenantId, status: { not: 'ARCHIVED' } } })) >= MAX_MEMORIES_PER_TENANT) {
    return NextResponse.json({ error: 'Memory is full: archive old memories first.' }, { status: 409 })
  }
  const memory = await prisma.memory.create({
    data: {
      tenantId, content: redactString(content, MEMORY_MAX_CHARS), category, subject: subject || null, agentId: agentId || null,
      trust: 'staff', status: 'ACTIVE', source: { kind: 'staff' }, createdById: session.user.id, reviewedById: session.user.id, reviewedAt: new Date(),
    },
  })
  await prisma.auditLog.create({ data: { action: 'MEMORY_SAVED', entityType: 'Memory', entityId: memory.id, tenantId, userId: session.user.id, newData: { category, by: 'staff' } } })
  return NextResponse.json({ id: memory.id }, { status: 201 })
}
