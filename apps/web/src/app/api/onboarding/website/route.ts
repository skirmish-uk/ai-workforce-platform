import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { canApprove, hasPermission, safeErrorMessage } from '@ai-workforce/domain'
import { checkUrl, WebsiteFetchError } from '@ai-workforce/knowledge'
import { enqueueWebsiteImport } from '@ai-workforce/queue'
import type { UserRole } from '@prisma/client'
import { tenantFor } from '../../../../lib/tenant'

export const dynamic = 'force-dynamic'

/** Website reads per tenant per day (each crawls up to 10 pages and costs a model call). */
const IMPORTS_PER_DAY = 10

/**
 * GET  /api/onboarding/website[?id=] — this business's website imports, newest first.
 * POST { url } — reads the site in the worker and drafts a profile for review (admins only).
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(session.user.role as UserRole, 'tenant:read')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const tenantId = tenantFor(session, request)
  const id = request.nextUrl.searchParams.get('id')
  const [imports, tenant] = await Promise.all([
    prisma.websiteImport.findMany({ where: { tenantId, ...(id ? { id } : {}) }, orderBy: { createdAt: 'desc' }, take: id ? 1 : 10 }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, settings: true } }),
  ])
  const settings = (tenant?.settings ?? {}) as Record<string, unknown>
  return NextResponse.json({ imports, tenantName: tenant?.name ?? null, hasBusinessProfile: Boolean(settings.businessContext) })
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!canApprove(session.user.role as UserRole, 'CUSTOMER_APPROVAL')) return NextResponse.json({ error: 'Only an admin can import a website' }, { status: 403 })
    const tenantId = tenantFor(session, request)
    const body = (await request.json().catch(() => ({}))) as { url?: unknown }
    let url: URL
    try {
      url = checkUrl(typeof body.url === 'string' ? body.url : '')
    } catch (error) {
      return NextResponse.json({ error: error instanceof WebsiteFetchError ? error.message : 'That isn’t a web address' }, { status: 400 })
    }
    const today = await prisma.websiteImport.count({ where: { tenantId, createdAt: { gte: new Date(Date.now() - 86_400_000) } } })
    if (today >= IMPORTS_PER_DAY) return NextResponse.json({ error: `${IMPORTS_PER_DAY} websites have been read in the last 24 hours; try again tomorrow.` }, { status: 429 })
    const row = await prisma.websiteImport.create({ data: { tenantId, url: url.toString(), createdById: session.user.id } })
    await enqueueWebsiteImport({ importId: row.id })
    await prisma.auditLog.create({ data: { action: 'WEBSITE_IMPORT_STARTED', entityType: 'WebsiteImport', entityId: row.id, tenantId, userId: session.user.id, newData: { url: row.url } } })
    return NextResponse.json({ id: row.id }, { status: 201 })
  } catch (error) {
    console.error('Starting a website import failed:', safeErrorMessage(error))
    return NextResponse.json({ error: `Could not start: ${safeErrorMessage(error)}` }, { status: 500 })
  }
}
