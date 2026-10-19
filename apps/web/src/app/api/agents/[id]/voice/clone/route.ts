import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { canAccessTenant, canApprove, hasPermission, safeErrorMessage } from '@ai-workforce/domain'
import { cloneScript, readVoiceConfig, voiceConfigSchema, defaultGreeting, type VoiceConfig } from '@ai-workforce/executor'
import { CLONE_MAX_BYTES, CLONE_MAX_SECONDS, CLONE_MIN_SECONDS, cloneCartesiaVoice, deleteCartesiaVoice, synthesizeSpeech, wavDurationSeconds } from '@ai-workforce/llm'
import type { Prisma, UserRole } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * "Use your own voice" (docs/VOICE.md): record the speaker reading a short script that starts
 * with a spoken consent statement, and Cartesia makes a private copy of the voice for this
 * agent. Admins only: a cloned voice is a person's likeness. The recording is sent to Cartesia
 * and not stored here; the agent records who consented, when, and who uploaded it.
 *
 * GET    status, the script to read, and whether cloning is available
 * POST   multipart: audio (WAV, 10-120 s), speakerName, consent=yes -> clones and switches
 * DELETE removes the cloned voice: restores the previous voice and deletes the copy at Cartesia
 */

type Session = { user: { id: string; email?: string | null; role: string; tenantId: string } }

async function load(agentId: string, session: Session, forWrite: boolean) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, include: { tenant: { select: { name: true, settings: true } } } })
  if (!agent || agent.isCandidate) return { error: NextResponse.json({ error: 'Agent not found' }, { status: 404 }) }
  const role = session.user.role as UserRole
  if (!canAccessTenant(role, session.user.tenantId, agent.tenantId) || !hasPermission(role, forWrite ? 'agent:write' : 'agent:read')) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  if (forWrite && !canApprove(role, 'CUSTOMER_APPROVAL')) {
    return { error: NextResponse.json({ error: 'Only an admin can change an agent’s voice' }, { status: 403 }) }
  }
  const { voice, error } = readVoiceConfig(agent.config)
  if (error) return { error: NextResponse.json({ error: `Voice settings are invalid: ${error}` }, { status: 409 }) }
  if (!voice.enabled) return { error: NextResponse.json({ error: 'Voice is not enabled for this agent' }, { status: 409 }) }
  return { agent, voice, role }
}

function today(settings: unknown): string {
  const zone = settings && typeof settings === 'object' && typeof (settings as Record<string, unknown>).timeZone === 'string' ? ((settings as Record<string, unknown>).timeZone as string) : 'UTC'
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

async function saveVoice(agentId: string, config: Prisma.JsonValue, voice: VoiceConfig) {
  const parsed = voiceConfigSchema.parse(voice)
  const base = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {}
  await prisma.agent.update({ where: { id: agentId }, data: { config: { ...base, voice: parsed } as Prisma.InputJsonValue } })
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) as Session | null
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const loaded = await load(id, session, false)
  if (loaded.error) return loaded.error
  return NextResponse.json({
    available: Boolean(process.env.CARTESIA_API_KEY),
    canChange: canApprove(loaded.role, 'CUSTOMER_APPROVAL'),
    businessName: loaded.agent.tenant.name,
    minSeconds: CLONE_MIN_SECONDS,
    maxSeconds: CLONE_MAX_SECONDS,
    voice: { provider: loaded.voice.provider ?? null, voiceId: loaded.voice.voiceId ?? null, clonedVoice: loaded.voice.clonedVoice ?? null },
    script: cloneScript('{name}', loaded.agent.tenant.name),
  })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = (await getServerSession(authOptions)) as Session | null
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    const loaded = await load(id, session, true)
    if (loaded.error) return loaded.error
    const { agent, voice } = loaded
    if (!process.env.CARTESIA_API_KEY) return NextResponse.json({ error: 'Voice cloning needs CARTESIA_API_KEY on the server' }, { status: 503 })

    const form = await request.formData()
    const file = form.get('audio')
    const speakerName = String(form.get('speakerName') ?? '').trim()
    if (form.get('consent') !== 'yes') return NextResponse.json({ error: 'The speaker’s consent is required' }, { status: 400 })
    if (speakerName.length < 2 || speakerName.length > 200) return NextResponse.json({ error: 'Enter the speaker’s name' }, { status: 400 })
    if (!(file instanceof Blob)) return NextResponse.json({ error: 'Send the recording as form field "audio"' }, { status: 400 })
    if (file.size > CLONE_MAX_BYTES) return NextResponse.json({ error: 'The recording is too large (16 MB at most)' }, { status: 413 })
    const audio = Buffer.from(await file.arrayBuffer())
    const seconds = wavDurationSeconds(audio)
    if (seconds === null) return NextResponse.json({ error: 'Send the recording as a WAV file' }, { status: 400 })
    if (seconds < CLONE_MIN_SECONDS) return NextResponse.json({ error: `The recording is ${Math.round(seconds)} seconds; at least ${CLONE_MIN_SECONDS} are needed. Read the whole script.` }, { status: 400 })
    if (seconds > CLONE_MAX_SECONDS) return NextResponse.json({ error: `Keep the recording under ${CLONE_MAX_SECONDS / 60} minutes` }, { status: 400 })

    const consentDate = today(agent.tenant.settings)
    const cloned = await cloneCartesiaVoice(audio, {
      mimeType: 'audio/wav',
      name: `${agent.name.split(/\s+[-–]\s+/)[0]} - ${speakerName}`.slice(0, 100),
      description: `Cloned with ${speakerName}'s consent on ${consentDate} for ${agent.tenant.name} (AI Workforce dashboard).`,
    })

    // A clone being replaced keeps the original "previous" voice; the old copy is deleted below.
    const previous = voice.clonedVoice ? voice.previous : { provider: voice.provider, voiceId: voice.voiceId }
    const next: VoiceConfig = {
      ...voice,
      provider: 'cartesia',
      voiceId: cloned.voiceId,
      clonedVoice: {
        consentFrom: speakerName,
        consentDate,
        consentReference: `Spoken consent at the start of a ${Math.round(seconds)} s recording made in the dashboard by ${session.user.email ?? session.user.id}`.slice(0, 300),
      },
      previous,
    }
    try {
      await saveVoice(agent.id, agent.config, next)
    } catch (error) {
      await deleteCartesiaVoice(cloned.voiceId).catch(() => undefined)
      throw error
    }
    if (voice.clonedVoice && voice.voiceId) await deleteCartesiaVoice(voice.voiceId).catch((e) => console.error('Could not delete the replaced cloned voice:', safeErrorMessage(e)))

    await prisma.auditLog.create({
      data: {
        action: 'VOICE_CLONED',
        entityType: 'Agent',
        entityId: agent.id,
        tenantId: agent.tenantId,
        userId: session.user.id,
        newData: { voiceId: cloned.voiceId, consentFrom: speakerName, consentDate, recordingSeconds: Math.round(seconds), replacedVoiceId: voice.voiceId ?? null },
      },
    })

    // Let the admin hear the new voice straight away.
    let sample: { audio: string; mimeType: string } | null = null
    try {
      const greeting = next.greeting ?? defaultGreeting(agent.name)
      const speech = await synthesizeSpeech(greeting, { provider: 'cartesia', voice: cloned.voiceId })
      sample = { audio: speech.audio.toString('base64'), mimeType: speech.mimeType }
    } catch { /* the voice exists; a sample is a convenience */ }

    return NextResponse.json({ voiceId: cloned.voiceId, consentFrom: speakerName, consentDate, recordingSeconds: Math.round(seconds), sample })
  } catch (error) {
    console.error('Voice cloning failed:', safeErrorMessage(error))
    return NextResponse.json({ error: `Voice cloning failed: ${safeErrorMessage(error)}` }, { status: 502 })
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = (await getServerSession(authOptions)) as Session | null
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    const loaded = await load(id, session, true)
    if (loaded.error) return loaded.error
    const { agent, voice } = loaded
    if (!voice.clonedVoice || !voice.voiceId) return NextResponse.json({ error: 'This agent isn’t using a cloned voice' }, { status: 409 })

    const restored: VoiceConfig = { ...voice, provider: voice.previous?.provider, voiceId: voice.previous?.voiceId, clonedVoice: undefined, previous: undefined }
    await saveVoice(agent.id, agent.config, restored)
    let deletedAtCartesia = true
    await deleteCartesiaVoice(voice.voiceId).catch((e) => {
      deletedAtCartesia = false
      console.error('Could not delete the cloned voice at Cartesia:', safeErrorMessage(e))
    })
    await prisma.auditLog.create({
      data: {
        action: 'VOICE_CLONE_REMOVED',
        entityType: 'Agent',
        entityId: agent.id,
        tenantId: agent.tenantId,
        userId: session.user.id,
        newData: { voiceId: voice.voiceId, consentFrom: voice.clonedVoice.consentFrom, deletedAtCartesia, restoredVoiceId: restored.voiceId ?? null },
      },
    })
    return NextResponse.json({ removed: true, deletedAtCartesia, voice: { provider: restored.provider ?? null, voiceId: restored.voiceId ?? null } })
  } catch (error) {
    console.error('Removing the cloned voice failed:', safeErrorMessage(error))
    return NextResponse.json({ error: `Could not remove the cloned voice: ${safeErrorMessage(error)}` }, { status: 500 })
  }
}
