import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { safeErrorMessage } from '@ai-workforce/domain'
import { createLiveTranscription, liveTranscriptionAvailable, transcriptionHint } from '@ai-workforce/llm'
import { callVocabulary, loadAgent } from '../shared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/agents/[id]/voice/live — a short-lived key for live transcription of this agent's
 * call (docs/VOICE.md, "Live transcription"). The browser streams the caller's audio to OpenAI
 * with it while they speak; the API key never leaves the server. GET /voice includes one at
 * the start of a call; this route is for reconnecting. 409 when live transcription is off
 * (the page then sends each turn as a recording, as before).
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const loaded = await loadAgent(id, session)
  if (loaded.error) return loaded.error
  const { agent, voice } = loaded
  if (voice.liveTranscription === false || !liveTranscriptionAvailable()) return NextResponse.json({ error: 'Live transcription is off for this agent' }, { status: 409 })
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: agent.tenantId }, select: { name: true } })
    const live = await createLiveTranscription({ hint: transcriptionHint(callVocabulary(agent.name, tenant?.name, voice.vocabulary, null)) })
    return NextResponse.json(live)
  } catch (error) {
    return NextResponse.json({ error: `Live transcription unavailable: ${safeErrorMessage(error)}` }, { status: 502 })
  }
}
