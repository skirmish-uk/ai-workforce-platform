import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { safeErrorMessage } from '@ai-workforce/domain'
import { defaultGreeting, savedVoices } from '@ai-workforce/executor'
import { SPEECH_PCM_RATE, type TtsProvider } from '@ai-workforce/llm'
import { loadAgent } from '../shared'
import { cachedSpeech } from '../speech-cache'
import { VoiceLimitError, reserveSpeech } from '../tts-budget'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** A WAV file around 16-bit mono PCM, so the browser can play it with a plain <audio>. */
function wav(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * GET /api/agents/[id]/voice/preview?voice=stock|<saved voiceId> — the agent's greeting in that
 * voice, as WAV, without switching to it. Spoken through the speech cache, so each voice costs
 * its greeting's characters once (counted against the monthly limit) and is free after that; the
 * voice in use shares its cache entry with the call greeting.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const loaded = await loadAgent(id, session)
  if (loaded.error) return loaded.error
  const { agent, voice } = loaded

  const choice = request.nextUrl.searchParams.get('voice') ?? 'stock'
  let target: { voiceId?: string; provider?: TtsProvider }
  if (choice === 'stock') {
    const stock = voice.clonedVoice ? voice.previous ?? {} : { provider: voice.provider, voiceId: voice.voiceId }
    target = { voiceId: stock.voiceId, provider: stock.provider }
  } else {
    const saved = savedVoices(voice).find((v) => v.voiceId === choice)
    if (!saved) return NextResponse.json({ error: 'That isn’t one of this agent’s voices' }, { status: 404 })
    target = { voiceId: saved.voiceId, provider: 'cartesia' }
  }

  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: agent.tenantId }, select: { settings: true } })
    const greeting = voice.greeting ?? defaultGreeting(agent.name)
    const { pcm } = await cachedSpeech(greeting, target, (characters) => reserveSpeech(agent.tenantId, tenant?.settings, characters, target.provider))
    return new NextResponse(new Uint8Array(wav(Buffer.from(pcm, 'base64'), SPEECH_PCM_RATE)), {
      headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=3600' },
    })
  } catch (error) {
    if (error instanceof VoiceLimitError) return NextResponse.json({ error: error.message }, { status: 429 })
    console.error('Voice preview failed:', safeErrorMessage(error))
    return NextResponse.json({ error: `Couldn’t play that voice: ${safeErrorMessage(error)}` }, { status: 502 })
  }
}
