import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { canApprove, safeErrorMessage } from '@ai-workforce/domain'
import { ImportError, applyWebsiteImport, undoWebsiteImport } from '@ai-workforce/executor'
import { enqueueEmbedDocument } from '@ai-workforce/queue'
import type { UserRole } from '@prisma/client'
import { z } from 'zod'
import { tenantFor } from '../../../../../lib/tenant'

export const dynamic = 'force-dynamic'

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('apply'),
    profile: z.unknown(),
    choices: z.object({ profile: z.boolean(), documents: z.boolean(), facts: z.array(z.number().int().min(0)).max(50) }),
  }),
  z.object({ action: z.literal('undo') }),
])

const STATUS = { NOT_FOUND: 404, CONFLICT: 409, INVALID: 400 } as const

/**
 * PUT /api/onboarding/website/[id]
 *   { action: "apply", profile, choices: { profile, documents, facts: [index] } } — uses the
 *   reviewed profile: business profile, knowledge documents (embedded in the worker), team notes.
 *   { action: "undo" } — takes all of that back.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!canApprove(session.user.role as UserRole, 'CUSTOMER_APPROVAL')) return NextResponse.json({ error: 'Only an admin can apply a website import' }, { status: 403 })
    const { id } = await params
    const parsed = bodySchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 })
    const tenantId = tenantFor(session, request)
    if (parsed.data.action === 'undo') {
      await undoWebsiteImport({ tenantId, importId: id, userId: session.user.id })
      return NextResponse.json({ undone: true })
    }
    const applied = await applyWebsiteImport({ tenantId, importId: id, profile: parsed.data.profile, choices: parsed.data.choices, userId: session.user.id })
    for (const documentId of applied.documentIds) await enqueueEmbedDocument({ documentId }).catch(() => undefined)
    return NextResponse.json(applied)
  } catch (error) {
    if (error instanceof ImportError) return NextResponse.json({ error: error.message }, { status: STATUS[error.code] })
    console.error('Website import failed:', safeErrorMessage(error))
    return NextResponse.json({ error: `Could not apply it: ${safeErrorMessage(error)}` }, { status: 500 })
  }
}
