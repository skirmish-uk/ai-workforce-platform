import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { canAccessTenant, hasPermission, safeErrorMessage } from '@ai-workforce/domain'
import { defaultGreeting, readVoiceConfig, spokenReply, type RunAgentResult } from '@ai-workforce/executor'
import { LLMConfigError, MAX_AUDIO_BYTES, synthesizeSpeech, transcribeAudio } from '@ai-workforce/llm'
import { enqueueAgentRun, waitForAgentRun } from '@ai-workforce/queue'
import { UserRole } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

async function loadAgent(agentId: string, session: { user: { role: string; tenantId: string } }) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } })
  if (!agent || agent.isCandidate) return { error: NextResponse.json({ error: 'Agent not found' }, { status: 404 }) }
  const role = session.user.role as UserRole
  if (!canAccessTenant(role, session.user.tenantId, agent.tenantId) || !hasPermission(role, 'agent:write')) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  const { voice, error } = readVoiceConfig(agent.config)
  if (error) return { error: NextResponse.json({ error: `Voice settings are invalid: ${error}` }, { status: 409 }) }
  if (!voice.enabled) return { error: NextResponse.json({ error: 'Voice is not enabled for this agent' }, { status: 409 }) }
  return { agent, voice }
}

async function speak(text: string, voice: ReturnType<typeof readVoiceConfig>['voice']) {
  try {
    const speech = await synthesizeSpeech(text, { voice: voice.voiceId, provider: voice.provider })
    return { audio: speech.audio.toString('base64'), mimeType: speech.mimeType, ttsModel: speech.model, characters: speech.characters }
  } catch (error) {
    // The text answer is still useful when speech fails; the page shows it and says why.
    return { audio: null, mimeType: null, ttsError: safeErrorMessage(error), characters: 0 }
  }
}

/** GET /api/agents/[id]/voice — whether voice is on and the spoken greeting (text + audio). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const loaded = await loadAgent(id, session)
  if (loaded.error) return loaded.error
  const greeting = loaded.voice.greeting ?? defaultGreeting(loaded.agent.name)
  return NextResponse.json({ greeting, ...(await speak(greeting, loaded.voice)) })
}

/**
 * POST /api/agents/[id]/voice (multipart form, field "audio": one recorded utterance)
 *
 * One voice turn: speech-to-text → agent run in the worker (same policy, approvals,
 * kill switches and audit as any run) → spoken reply → text-to-speech. Returns the
 * transcript, the reply text, the run id and the reply audio (base64 mp3).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const started = Date.now()
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
    const audio = Buffer.from(await file.arrayBuffer())

    let transcript: string
    try {
      transcript = (await transcribeAudio(audio, { mimeType: file.type || 'audio/webm', language: 'en' })).text
    } catch (error) {
      const status = error instanceof LLMConfigError ? 503 : 502
      return NextResponse.json({ error: `Could not transcribe the recording: ${safeErrorMessage(error)}` }, { status })
    }

    let reply: string
    let runId: string | null = null
    let status: string = 'no_speech'
    if (!transcript) {
      reply = 'Sorry, I didn’t catch that. Could you say it again?'
    } else {
      const job = await enqueueAgentRun({ agentId: agent.id, input: transcript, userId: session.user.id, trigger: 'voice' })
      runId = job.id ?? null
      const outcome = job.id ? await waitForAgentRun<RunAgentResult>(job.id) : null
      if (!outcome) {
        status = 'timeout'
        reply = 'That’s taking longer than usual. I’ve noted your question and the team will follow up.'
      } else if (outcome.state === 'failed') {
        status = 'failed'
        reply = spokenReply({ status: 'failed', output: null })
      } else {
        status = outcome.result.status
        reply = spokenReply(outcome.result)
      }
    }

    const speech = await speak(reply, voice)
    await prisma.auditLog.create({
      data: {
        action: 'VOICE_TURN',
        entityType: 'Agent',
        entityId: agent.id,
        tenantId: agent.tenantId,
        userId: session.user.id,
        // Usage for per-minute pricing: audio received and characters spoken.
        newData: { runId, status, audioBytes: audio.length, ttsCharacters: speech.characters, ttsModel: speech.ttsModel ?? null, ttsError: speech.ttsError ?? null, durationMs: Date.now() - started },
      },
    })

    return NextResponse.json({ transcript, reply, status, runId, ...speech })
  } catch (error) {
    console.error('Voice turn failed:', error)
    return NextResponse.json({ error: 'Voice turn failed' }, { status: 500 })
  }
}
