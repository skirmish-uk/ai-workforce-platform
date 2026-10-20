import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { canAccessTenant, hasPermission, safeErrorMessage } from '@ai-workforce/domain'
import { randomUUID } from 'node:crypto'
import { defaultGreeting, isConversationId, readVoiceConfig, resolveAgentContract, spokenReply, type RunAgentResult } from '@ai-workforce/executor'
import { LLMConfigError, MAX_AUDIO_BYTES, MIN_TRANSCRIPT_CONFIDENCE, synthesizeSpeech, transcribeAudio } from '@ai-workforce/llm'
import { enqueueAgentRun, getRedisConnection, waitForAgentRun } from '@ai-workforce/queue'
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

/**
 * A call is a conversation: each turn's run gets the recent exchanges (sent by the browser as
 * form field "history": [{who: 'caller'|'agent', text}]) so "what about Saturdays?" makes sense.
 * Bounded: the last 8 exchanges, 400 characters each.
 */
function withConversation(transcript: string, rawHistory: FormDataEntryValue | null, agentName: string): string {
  let history: Array<{ who?: unknown; text?: unknown }> = []
  try {
    history = typeof rawHistory === 'string' ? JSON.parse(rawHistory) : []
  } catch { /* ignore a malformed history: the turn still works on its own */ }
  const first = agentName.split(/\s+[-–]\s+|\s+/)[0] || 'You'
  const lines = (Array.isArray(history) ? history : [])
    .filter((h) => (h.who === 'caller' || h.who === 'agent') && typeof h.text === 'string' && h.text.trim())
    .slice(-8)
    .map((h) => `${h.who === 'caller' ? 'Caller' : first}: ${String(h.text).replace(/\s+/g, ' ').trim().slice(0, 400)}`)
  if (!lines.length) return transcript
  return `This is a live voice call. The conversation so far, most recent last:\n${lines.join('\n')}\n\nThe caller now says: "${transcript}"\n\nReply to what the caller just said, in the context of the call. Don't greet them again.`
}

/** VOICE_TURN usage row (per-minute pricing data and timings), written without holding up the reply. */
function recordTurn(agent: { id: string; tenantId: string }, userId: string, data: Record<string, unknown> & { timings: Record<string, number> }) {
  void prisma.auditLog
    .create({ data: { action: 'VOICE_TURN', entityType: 'Agent', entityId: agent.id, tenantId: agent.tenantId, userId, newData: { ...data, durationMs: data.timings.totalMs } as never } })
    .catch((error) => console.error('Failed to record voice turn:', safeErrorMessage(error)))
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

/** Short acknowledgements the call plays if the answer hasn't started ~0.6 s after the caller stops. */
const FILLERS = ['Mm-hm.', 'Okay.', 'Right.', 'Sure.']

/**
 * GET /api/agents/[id]/voice — whether voice is on, the spoken greeting (text + audio), and the
 * agent's acknowledgement clips ("Mm-hm.", "Okay."…) in its own voice, made once per call.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const loaded = await loadAgent(id, session)
  if (loaded.error) return loaded.error
  const greeting = loaded.voice.greeting ?? defaultGreeting(loaded.agent.name)
  const [spoken, ...fillers] = await Promise.all([speak(greeting, loaded.voice), ...FILLERS.map((f) => speak(f, loaded.voice))])
  return NextResponse.json({
    greeting,
    ...spoken,
    fillers: fillers.filter((f) => f.audio).map((f) => ({ audio: f.audio, mimeType: f.mimeType })),
  })
}

/**
 * POST /api/agents/[id]/voice (multipart form, field "audio": one recorded utterance; "history":
 * the call so far). Streams NDJSON events: heard → audio (one per sentence, in order) → done.
 * A turn with nothing usable heard is answered with plain JSON instead.
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
    const callId = form.get('conversationId')
    const file = form.get('audio')
    if (!(file instanceof Blob)) return NextResponse.json({ error: 'Send the recording as form field "audio"' }, { status: 400 })
    if (file.size > MAX_AUDIO_BYTES) return NextResponse.json({ error: 'Recording is too long' }, { status: 413 })
    const audio = Buffer.from(await file.arrayBuffer())
    // Where each turn's time goes (returned to the browser and kept on the VOICE_TURN row).
    const timings: Record<string, number> = { receivedMs: Date.now() - started }
    let mark = Date.now()
    const lap = (name: string) => { const now = Date.now(); timings[name] = now - mark; mark = now }

    let transcript: string
    let confidence: number | null = null
    try {
      // No transcription prompt: on silence or noise it makes the model invent sentences.
      const heard = await transcribeAudio(audio, { mimeType: file.type || 'audio/webm', language: 'en' })
      transcript = heard.text
      confidence = heard.confidence
      lap('transcribeMs')
    } catch (error) {
      const status = error instanceof LLMConfigError ? 503 : 502
      return NextResponse.json({ error: `Could not transcribe the recording: ${safeErrorMessage(error)}` }, { status })
    }

    // Nothing usable was heard: answer at once, without running the agent.
    if (!transcript || (confidence !== null && confidence < MIN_TRANSCRIPT_CONFIDENCE)) {
      const status = transcript ? 'unclear' : 'no_speech'
      // Garbled audio comes back as confident-looking words in a random language; don't act on it.
      const reply = transcript ? 'Sorry, I didn’t catch that clearly. Could you say it again, a little closer to the microphone?' : 'Sorry, I didn’t catch that. Could you say it again?'
      // The browser drops a turn with no speech, so don't spend time or money speaking it.
      const speech = status === 'no_speech' ? { audio: null, mimeType: null, characters: 0 } : await speak(reply, voice)
      timings.totalMs = Date.now() - started
      recordTurn(agent, session.user.id, { runId: null, status, confidence, audioBytes: audio.length, ttsCharacters: speech.characters, timings })
      return NextResponse.json({ transcript, confidence, reply, status, runId: null, timings, ...speech })
    }

    // Streamed answer (NDJSON): what was heard, then each sentence's audio as soon as it's
    // spoken, then the outcome. The agent's text arrives over Redis while the model writes it,
    // so the caller hears the first sentence while the rest is still being generated.
    const forbidden = resolveAgentContract(agent).contract.definitionOfDone.checks
      .filter((c): c is Extract<typeof c, { type: 'output_not_contains' }> => c.type === 'output_not_contains')
      .map((c) => c.value.toLowerCase())
    const channel = `voice-stream-${randomUUID()}`
    const subscriber = getRedisConnection().duplicate()
    await subscriber.subscribe(channel)
    const job = await enqueueAgentRun({ agentId: agent.id, input: withConversation(transcript, form.get('history'), agent.name), userId: session.user.id, trigger: 'voice', streamChannel: channel, conversation: isConversationId(callId) ? { id: callId, message: transcript } : undefined })
    const runId = job.id ?? null
    const encoder = new TextEncoder()

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        send({ type: 'heard', transcript, confidence, runId })

        let spokenText = ''
        let seq = 0
        let characters = 0
        let ttsModel: string | null = null
        let ttsError: string | null = null
        let ordered: Promise<void> = Promise.resolve()
        const say = (sentence: string) => {
          const text = sentence.trim()
          // Spoken before the run's result checks: never say a phrase the agent's checks forbid.
          if (!text || forbidden.some((f) => text.toLowerCase().includes(f))) return
          spokenText = spokenText ? `${spokenText} ${text}` : text
          const n = seq++
          const pending = speak(text, voice) // starts now; sentences are synthesised in parallel
          ordered = ordered.then(async () => {
            const speech = await pending
            characters += speech.characters
            ttsModel = speech.ttsModel ?? ttsModel
            ttsError = speech.ttsError ?? ttsError
            if (timings.firstAudioMs === undefined && speech.audio) timings.firstAudioMs = Date.now() - started
            send({ type: 'audio', seq: n, text, audio: speech.audio, mimeType: speech.mimeType, ttsError: speech.ttsError })
          })
        }

        // Split the streamed text into sentences as they complete.
        let buffer = ''
        let step = -1
        const flush = (final: boolean) => {
          // The answer's first words matter most: if its opening sentence is long, speak up to its
          // first comma on its own, so that short clip is ready while the rest is synthesised.
          if (seq === 0) {
            const end = buffer.search(/[.!?…]["'”’)\]]*(\s|$)/)
            const sentenceLength = end >= 0 ? end + 1 : buffer.length
            const comma = buffer.indexOf(', ', 18)
            if (comma > 0 && comma < sentenceLength && sentenceLength > 45) {
              say(buffer.slice(0, comma + 1))
              buffer = buffer.slice(comma + 2)
            }
          }
          for (;;) {
            const match = /[.!?…]["'”’)\]]*\s+/.exec(buffer)
            if (!match) break
            const cut = match.index + match[0].length
            say(buffer.slice(0, cut))
            buffer = buffer.slice(cut)
          }
          // A long opening sentence: start speaking at its first clause instead of waiting for
          // the full stop, so the caller hears something sooner. Later sentences stay whole.
          if (!final && seq === 0 && buffer.length > 60) {
            const comma = buffer.indexOf(', ', 25)
            if (comma > 0) {
              say(buffer.slice(0, comma + 1))
              buffer = buffer.slice(comma + 2)
            }
          }
          if (final) {
            say(buffer)
            buffer = ''
          }
        }
        subscriber.on('message', (_channel: string, message: string) => {
          try {
            const event = JSON.parse(message) as { step: number; delta: string }
            if (event.step !== step) {
              flush(true) // text before a tool call is a complete thought
              step = event.step
              if (timings.firstTextMs === undefined) timings.firstTextMs = Date.now() - started
            }
            buffer += event.delta
            flush(false)
          } catch { /* ignore a malformed event */ }
        })

        let status = 'timeout'
        let result: RunAgentResult | null = null
        try {
          const outcome = runId ? await waitForAgentRun<RunAgentResult>(runId, 45_000, 100) : null
          // The last published deltas can land just after the job completes.
          await new Promise((resolve) => setTimeout(resolve, 80))
          if (outcome?.state === 'completed') {
            result = outcome.result
            status = result.status
            timings.agentRunMs = result.durationMs
          } else if (outcome?.state === 'failed') {
            status = 'failed'
          }
        } finally {
          await subscriber.unsubscribe(channel).catch(() => undefined)
          subscriber.disconnect()
        }
        flush(true)
        lap('agentMs')

        // What still needs saying: the full answer if nothing streamed (e.g. a provider without
        // streaming), or how the turn ended when it wasn't a plain answer.
        if (status === 'timeout') say('That’s taking longer than usual. I’ve noted your question and the team will follow up.')
        else if (!result || status === 'failed') say(spokenReply({ status: 'failed', output: null }))
        else if (status === 'completed' || status === 'partial') { if (!spokenText) say(spokenReply(result)) }
        else say(spokenReply(result))

        await ordered
        lap('speakMs')
        timings.totalMs = Date.now() - started
        send({ type: 'done', status, runId, reply: spokenText, timings })
        recordTurn(agent, session.user.id, { runId, status, confidence, audioBytes: audio.length, ttsCharacters: characters, ttsModel, ttsError, timings })
        controller.close()
      },
    })
    return new Response(body, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        // Don't let nginx (or anything that honours this) hold the stream back.
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (error) {
    console.error('Voice turn failed:', error)
    return NextResponse.json({ error: 'Voice turn failed' }, { status: 500 })
  }
}
