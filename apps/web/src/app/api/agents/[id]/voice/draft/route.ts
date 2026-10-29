import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { isConversationId } from '@ai-workforce/executor'
import { getRedisConnection, requestAgentRunCancel, setDraftDecision } from '@ai-workforce/queue'
import { z } from 'zod'
import { draftKeys } from '../shared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const bodySchema = z.object({ id: z.string().refine(isConversationId), go: z.boolean() })

/**
 * POST /api/agents/[id]/voice/draft {id, go} — the caller finished speaking: go ahead with the
 * draft answer started at their last pause (go: true, its words were all they said), or drop it
 * (go: false, they said more). Only the person whose call it is decides (docs/VOICE.md,
 * "Answering while the caller speaks").
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id: agentId } = await params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Send {id, go}' }, { status: 400 })
  const keys = draftKeys(parsed.data.id)
  if ((await getRedisConnection().get(keys.owner)) !== `${session.user.id}:${agentId}`) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
  await setDraftDecision(keys.hold, parsed.data.go)
  if (!parsed.data.go) await requestAgentRunCancel(keys.jobId).catch(() => undefined)
  return NextResponse.json({ ok: true })
}
