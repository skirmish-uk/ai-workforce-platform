import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { canAccessTenant, canApprove, hasPermission, safeErrorMessage } from '@ai-workforce/domain'
import { MAX_SAVED_VOICES, STOCK_VOICES, cloneScript, readVoiceConfig, savedVoices, voiceConfigSchema, defaultGreeting, type VoiceConfig } from '@ai-workforce/executor'
import { CLONE_MAX_BYTES, CLONE_MAX_SECONDS, CLONE_MIN_SECONDS, cloneCartesiaVoice, deleteCartesiaVoice, synthesizeSpeech, wavDurationSeconds } from '@ai-workforce/llm'
import type { Prisma, UserRole } from '@prisma/client'
import { clonesThisMonth, reserveSpeech, voiceLimits, voiceUsage } from '../tts-budget'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * "Use your own voice" (docs/VOICE.md): record the speaker reading a short script that starts
 * with a spoken consent statement, and Cartesia makes a private copy of the voice for this
 * agent. Admins only: a cloned voice is a person's likeness. The recording is sent to Cartesia
 * and not stored here; the agent records who consented, when, and who uploaded it. An agent keeps
 * up to MAX_SAVED_VOICES cloned voices (Agent.config.voice.voices) and switches between them.
 *
 * GET    status, the saved voices, the script to read, and whether cloning is available
 * POST   multipart: audio (WAV, 10-120 s), speakerName, consent=yes -> clones, adds it, switches to it
 * PUT    JSON { voiceId } (a saved voice) or { stock: true } -> switches the voice in use
 * DELETE ?voiceId= -> removes that saved voice and deletes the copy at Cartesia (the stock voice
 *        comes back if it was in use); without voiceId, the voice in use
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

/** The stock voice the agent uses, or goes back to from a cloned one. */
function stockVoice(voice: VoiceConfig): { provider: string | null; voiceId: string | null; name: string | null; inUse: boolean } {
  const stock = voice.clonedVoice ? voice.previous ?? {} : { provider: voice.provider, voiceId: voice.voiceId }
  const name = STOCK_VOICES.find((v) => v.id === stock.voiceId)?.name ?? (stock.provider === 'openai' || (!stock.provider && stock.voiceId) ? stock.voiceId ?? null : null)
  return { provider: stock.provider ?? null, voiceId: stock.voiceId ?? null, name, inUse: !voice.clonedVoice }
}

/** The stock voice to remember while a cloned one is in use. */
function stockOf(voice: VoiceConfig): VoiceConfig['previous'] {
  return voice.clonedVoice ? voice.previous : { provider: voice.provider, voiceId: voice.voiceId }
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
  const { voice } = loaded
  let usage = null
  try {
    const [chars, clones] = await Promise.all([voiceUsage(loaded.agent.tenantId, loaded.agent.tenant.settings), clonesThisMonth(loaded.agent.tenantId)])
    usage = { ...chars, clones: { used: clones, limit: voiceLimits(loaded.agent.tenant.settings).clonesPerMonth } }
  } catch (error) {
    console.error('Voice usage unavailable:', safeErrorMessage(error))
  }
  return NextResponse.json({
    usage,
    available: Boolean(process.env.CARTESIA_API_KEY),
    canChange: canApprove(loaded.role, 'CUSTOMER_APPROVAL'),
    businessName: loaded.agent.tenant.name,
    minSeconds: CLONE_MIN_SECONDS,
    maxSeconds: CLONE_MAX_SECONDS,
    maxVoices: MAX_SAVED_VOICES,
    voice: { provider: voice.provider ?? null, voiceId: voice.voiceId ?? null, clonedVoice: voice.clonedVoice ?? null },
    saved: savedVoices(voice).map((v) => ({ voiceId: v.voiceId, consentFrom: v.consentFrom, consentDate: v.consentDate, inUse: Boolean(voice.clonedVoice) && v.voiceId === voice.voiceId })),
    stock: stockVoice(voice),
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

    const library = savedVoices(voice)
    const cloneLimit = voiceLimits(agent.tenant.settings).clonesPerMonth
    if (cloneLimit > 0 && (await clonesThisMonth(agent.tenantId)) >= cloneLimit) {
      return NextResponse.json({ error: `${cloneLimit} voices have been recorded this month, the monthly limit. Switch between the saved ones, or record more next month.` }, { status: 429 })
    }
    if (library.length >= MAX_SAVED_VOICES) return NextResponse.json({ error: `${MAX_SAVED_VOICES} voices are saved already. Remove one before recording another.` }, { status: 409 })

    const consentDate = today(agent.tenant.settings)
    const cloned = await cloneCartesiaVoice(audio, {
      mimeType: 'audio/wav',
      name: `${agent.name.split(/\s+[-–]\s+/)[0]} - ${speakerName}`.slice(0, 100),
      description: `Cloned with ${speakerName}'s consent on ${consentDate} for ${agent.tenant.name} (AI Workforce dashboard).`,
    })

    // Added to the saved voices and switched to; the voices recorded before are kept.
    const consent = {
      consentFrom: speakerName,
      consentDate,
      consentReference: `Spoken consent at the start of a ${Math.round(seconds)} s recording made in the dashboard by ${session.user.email ?? session.user.id}`.slice(0, 300),
    }
    const next: VoiceConfig = {
      ...voice,
      provider: 'cartesia',
      voiceId: cloned.voiceId,
      clonedVoice: consent,
      voices: [...library, { voiceId: cloned.voiceId, ...consent }],
      previous: stockOf(voice),
    }
    try {
      await saveVoice(agent.id, agent.config, next)
    } catch (error) {
      await deleteCartesiaVoice(cloned.voiceId).catch(() => undefined)
      throw error
    }

    await prisma.auditLog.create({
      data: {
        action: 'VOICE_CLONED',
        entityType: 'Agent',
        entityId: agent.id,
        tenantId: agent.tenantId,
        userId: session.user.id,
        newData: { voiceId: cloned.voiceId, consentFrom: speakerName, consentDate, recordingSeconds: Math.round(seconds), previousVoiceId: voice.voiceId ?? null, savedVoices: library.length + 1 },
      },
    })

    // Let the admin hear the new voice straight away.
    let sample: { audio: string; mimeType: string } | null = null
    try {
      const greeting = next.greeting ?? defaultGreeting(agent.name)
      await reserveSpeech(agent.tenantId, agent.tenant.settings, greeting.length, 'cartesia')
      const speech = await synthesizeSpeech(greeting, { provider: 'cartesia', voice: cloned.voiceId })
      sample = { audio: speech.audio.toString('base64'), mimeType: speech.mimeType }
    } catch { /* the voice exists; a sample is a convenience */ }

    return NextResponse.json({ voiceId: cloned.voiceId, consentFrom: speakerName, consentDate, recordingSeconds: Math.round(seconds), sample })
  } catch (error) {
    console.error('Voice cloning failed:', safeErrorMessage(error))
    return NextResponse.json({ error: `Voice cloning failed: ${safeErrorMessage(error)}` }, { status: 502 })
  }
}

/** Switches the agent to one of its saved voices, or back to its stock voice. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = (await getServerSession(authOptions)) as Session | null
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    const loaded = await load(id, session, true)
    if (loaded.error) return loaded.error
    const { agent, voice } = loaded
    const body = (await request.json().catch(() => ({}))) as { voiceId?: unknown; stock?: unknown }
    const library = savedVoices(voice)
    let next: VoiceConfig
    if (body.stock === true) {
      if (!voice.clonedVoice) return NextResponse.json({ switched: false, voiceId: voice.voiceId ?? null })
      next = { ...voice, provider: voice.previous?.provider, voiceId: voice.previous?.voiceId, clonedVoice: undefined, previous: undefined, voices: library }
    } else {
      const chosen = library.find((v) => v.voiceId === body.voiceId)
      if (!chosen) return NextResponse.json({ error: 'Choose one of this agent’s saved voices' }, { status: 400 })
      const { voiceId, ...consent } = chosen
      next = { ...voice, provider: 'cartesia', voiceId, clonedVoice: consent, previous: stockOf(voice), voices: library }
    }
    await saveVoice(agent.id, agent.config, next)
    await prisma.auditLog.create({
      data: { action: 'VOICE_SWITCHED', entityType: 'Agent', entityId: agent.id, tenantId: agent.tenantId, userId: session.user.id, newData: { from: voice.voiceId ?? null, to: next.voiceId ?? null, cloned: Boolean(next.clonedVoice) } },
    })
    return NextResponse.json({ switched: true, voiceId: next.voiceId ?? null })
  } catch (error) {
    console.error('Switching voice failed:', safeErrorMessage(error))
    return NextResponse.json({ error: `Could not switch voice: ${safeErrorMessage(error)}` }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = (await getServerSession(authOptions)) as Session | null
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    const loaded = await load(id, session, true)
    if (loaded.error) return loaded.error
    const { agent, voice } = loaded
    const library = savedVoices(voice)
    const target = request.nextUrl.searchParams.get('voiceId') ?? (voice.clonedVoice ? voice.voiceId : null)
    const removing = library.find((v) => v.voiceId === target)
    if (!removing) return NextResponse.json({ error: 'That isn’t one of this agent’s saved voices' }, { status: 404 })

    // In use: the stock voice comes back. Either way the other saved voices stay.
    const inUse = Boolean(voice.clonedVoice) && voice.voiceId === removing.voiceId
    const rest = library.filter((v) => v.voiceId !== removing.voiceId)
    const restored: VoiceConfig = inUse
      ? { ...voice, provider: voice.previous?.provider, voiceId: voice.previous?.voiceId, clonedVoice: undefined, previous: undefined, voices: rest }
      : { ...voice, voices: rest }
    await saveVoice(agent.id, agent.config, restored)
    let deletedAtCartesia = true
    await deleteCartesiaVoice(removing.voiceId).catch((e) => {
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
        newData: { voiceId: removing.voiceId, consentFrom: removing.consentFrom, wasInUse: inUse, deletedAtCartesia, voiceInUse: restored.voiceId ?? null },
      },
    })
    return NextResponse.json({ removed: true, deletedAtCartesia, voice: { provider: restored.provider ?? null, voiceId: restored.voiceId ?? null } })
  } catch (error) {
    console.error('Removing the cloned voice failed:', safeErrorMessage(error))
    return NextResponse.json({ error: `Could not remove the cloned voice: ${safeErrorMessage(error)}` }, { status: 500 })
  }
}
