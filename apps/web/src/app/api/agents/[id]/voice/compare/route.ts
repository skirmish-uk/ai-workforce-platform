import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { safeErrorMessage } from '@ai-workforce/domain'
import { MAX_AUDIO_BYTES, compareTranscription, configuredSttProviders, sttProvider } from '@ai-workforce/llm'
import { callVocabulary, loadAgent } from '../shared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/agents/[id]/voice/compare: which speech-to-text providers have keys, and which one
 * this agent's calls use.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const loaded = await loadAgent(id, session)
  if (loaded.error) return loaded.error
  let inUse: string | null = null
  try { inUse = loaded.voice.sttProvider ?? sttProvider() } catch { /* misconfigured: shown as none */ }
  return NextResponse.json({ configured: configuredSttProviders(), inUse })
}

/**
 * POST /api/agents/[id]/voice/compare (multipart "audio"): the same recording through every
 * configured speech-to-text provider, with the agent's vocabulary, to choose one on real
 * voices and microphones. Doesn't run the agent. Transcripts (not audio) are kept on a
 * SPEECH_COMPARISON audit row so comparisons can be reviewed later.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    const loaded = await loadAgent(id, session)
    if (loaded.error) return loaded.error
    const { agent, voice } = loaded

    const form = await request.formData()
    const file = form.get('audio')
    if (!(file instanceof Blob)) return NextResponse.json({ error: 'Send the recording as form field "audio"' }, { status: 400 })
    if (file.size > MAX_AUDIO_BYTES) return NextResponse.json({ error: 'Recording is too long' }, { status: 413 })
    if (!configuredSttProviders().length) return NextResponse.json({ error: 'No speech-to-text provider has an API key' }, { status: 503 })

    const tenant = await prisma.tenant.findUnique({ where: { id: agent.tenantId }, select: { name: true } })
    const results = await compareTranscription(Buffer.from(await file.arrayBuffer()), {
      mimeType: file.type || 'audio/webm',
      language: 'en',
      vocabulary: callVocabulary(agent.name, tenant?.name, voice.vocabulary, null),
    })
    void prisma.auditLog
      .create({ data: { action: 'SPEECH_COMPARISON', entityType: 'Agent', entityId: agent.id, tenantId: agent.tenantId, userId: session.user.id, newData: { audioBytes: file.size, results } as never } })
      .catch((error) => console.error('Failed to record speech comparison:', safeErrorMessage(error)))
    return NextResponse.json({ results })
  } catch (error) {
    console.error('Speech comparison failed:', error)
    return NextResponse.json({ error: 'Speech comparison failed' }, { status: 500 })
  }
}
