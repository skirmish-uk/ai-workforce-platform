import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { safeErrorMessage } from '@ai-workforce/domain'
import { randomUUID } from 'node:crypto'
import { defaultGreeting, isConversationId, readVoiceConfig, resolveAgentContract, spokenReply, type RunAgentResult } from '@ai-workforce/executor'
import { LLMConfigError, MAX_AUDIO_BYTES, MIN_TRANSCRIPT_CONFIDENCE, SPEECH_PCM_RATE, hedged, notEnglishSpeech, soundsLikeEcho, streamSpeech, transcribeAudio } from '@ai-workforce/llm'
import { enqueueAgentRun, getRedisConnection, waitForAgentRun } from '@ai-workforce/queue'
import { callVocabulary, loadAgent } from './shared'
import { cachedSpeech } from './speech-cache'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Answers are heard, not read: a full package description typed was about 100 words (35 s
 * spoken). On a call the agent gives the main points and offers the rest.
 */
const SPOKEN_LENGTH = '(Spoken answer: two or three short sentences with the main points, about 60 words at most; offer more detail instead of listing everything.)'

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
  if (!lines.length) return `${transcript}\n\n${SPOKEN_LENGTH}`
  return `This is a live voice call. The conversation so far, most recent last:\n${lines.join('\n')}\n\nThe caller now says: "${transcript}"\n\nReply to what the caller just said, in the context of the call. Don't greet them again. ${SPOKEN_LENGTH}`
}

/** The agent's last two lines in the call (from "history"), to recognise its own echo. */
function agentLines(rawHistory: FormDataEntryValue | null): string[] {
  try {
    const history = typeof rawHistory === 'string' ? JSON.parse(rawHistory) : []
    return (Array.isArray(history) ? history : []).filter((h) => h?.who === 'agent' && typeof h.text === 'string').slice(-2).map((h) => String(h.text).slice(0, 1000))
  } catch {
    return []
  }
}

/** VOICE_TURN usage row (per-minute pricing data and timings), written without holding up the reply. */
function recordTurn(agent: { id: string; tenantId: string }, userId: string, data: Record<string, unknown> & { timings: Record<string, number> }) {
  void prisma.auditLog
    .create({ data: { action: 'VOICE_TURN', entityType: 'Agent', entityId: agent.id, tenantId: agent.tenantId, userId, newData: { ...data, durationMs: data.timings.totalMs } as never } })
    .catch((error) => console.error('Failed to record voice turn:', safeErrorMessage(error)))
}

type Voice = ReturnType<typeof readVoiceConfig>['voice']

/** A fixed line, spoken whole (from the cache after the first time). The text still shows when speech fails. */
async function speakLine(text: string, voice: Voice) {
  try {
    const { pcm, words, characters } = await cachedSpeech(text, { voiceId: voice.voiceId, provider: voice.provider })
    return { speech: { pcm, words }, characters }
  } catch (error) {
    return { speech: null, ttsError: safeErrorMessage(error), characters: 0 }
  }
}

/** Short acknowledgements the call plays if the answer hasn't started ~0.6 s after the caller stops. */
const FILLERS = ['Mm-hm.', 'Okay.', 'Right.', 'Sure.']

/**
 * A second transcription request when the first hasn't answered by then (see hedged()):
 * the usual 0.55–1 s answer is untouched, the occasional 2 s one is cut to about 1.6 s.
 */
const TRANSCRIBE_HEDGE_MS = 1000

/**
 * GET /api/agents/[id]/voice — whether voice is on, the spoken greeting (text + audio), and the
 * agent's acknowledgement clips ("Mm-hm.", "Okay."…) in its own voice. Audio is raw PCM at
 * `rate` (base64), cached after the first call (speech-cache.ts).
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const loaded = await loadAgent(id, session)
  if (loaded.error) return loaded.error
  const greeting = loaded.voice.greeting ?? defaultGreeting(loaded.agent.name)
  const [spoken, ...fillers] = await Promise.all([speakLine(greeting, loaded.voice), ...FILLERS.map((f) => speakLine(f, loaded.voice))])
  return NextResponse.json({
    greeting,
    rate: SPEECH_PCM_RATE,
    speech: spoken.speech,
    ttsError: spoken.ttsError,
    fillers: fillers.flatMap((f) => (f.speech ? [{ pcm: f.speech.pcm }] : [])),
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
    let hintRetried = false
    try {
      // A names-only hint (never what the agent said: on noise that came back as the transcript).
      const tenant = await prisma.tenant.findUnique({ where: { id: agent.tenantId }, select: { name: true } })
      const vocabulary = callVocabulary(agent.name, tenant?.name, voice.vocabulary, form.get('history'))
      const heard = await hedged(
        () => transcribeAudio(audio, { mimeType: file.type || 'audio/webm', language: 'en', vocabulary, provider: voice.sttProvider }),
        TRANSCRIBE_HEDGE_MS,
        () => { timings.transcribeHedged = 1 }
      )
      transcript = heard.text
      confidence = heard.confidence
      hintRetried = heard.hintRetried ?? false
      lap('transcribeMs')
    } catch (error) {
      const status = error instanceof LLMConfigError ? 503 : 502
      return NextResponse.json({ error: `Could not transcribe the recording: ${safeErrorMessage(error)}` }, { status })
    }

    // Noise transcribed into another script, or an interruption that was only the agent's own
    // voice from the speakers (or a "mm-hm"): ignored like silence, so the agent never answers itself.
    const interrupted = form.get('interrupted') === '1'
    const ignored = notEnglishSpeech(transcript) ? 'not_english' : interrupted && soundsLikeEcho(transcript, agentLines(form.get('history'))) ? 'echo' : null
    if (ignored) {
      timings.totalMs = Date.now() - started
      recordTurn(agent, session.user.id, { runId: null, status: 'no_speech', ignored, transcript, confidence, hintRetried, audioBytes: audio.length, ttsCharacters: 0, timings })
      return NextResponse.json({ transcript, confidence, reply: '', status: 'no_speech', ignored, runId: null, timings, speech: null })
    }

    // Nothing usable was heard: answer at once, without running the agent.
    if (!transcript || (confidence !== null && confidence < MIN_TRANSCRIPT_CONFIDENCE)) {
      const status = transcript ? 'unclear' : 'no_speech'
      // Garbled audio comes back as confident-looking words in a random language; don't act on it.
      const reply = transcript ? 'Sorry, I didn’t catch that clearly. Could you say it again, a little closer to the microphone?' : 'Sorry, I didn’t catch that. Could you say it again?'
      // The browser drops a turn with no speech, so don't spend time or money speaking it.
      const spoken = status === 'no_speech' ? { speech: null, characters: 0 } : await speakLine(reply, voice)
      timings.totalMs = Date.now() - started
      recordTurn(agent, session.user.id, { runId: null, status, confidence, hintRetried, audioBytes: audio.length, ttsCharacters: spoken.characters, timings })
      return NextResponse.json({ transcript, confidence, reply, status, runId: null, timings, rate: SPEECH_PCM_RATE, ...spoken })
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
        let closed = false
        const send = (event: Record<string, unknown>) => {
          if (closed) return
          try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)) } catch { closed = true /* the caller hung up */ }
        }
        send({ type: 'heard', transcript, confidence, runId, rate: SPEECH_PCM_RATE })

        let spokenText = ''
        let seq = 0
        let characters = 0
        let ttsModel: string | null = null
        let ttsError: string | null = null
        let ordered: Promise<void> = Promise.resolve()
        /**
         * Speaks one sentence: say → pcm… (+ words, when each is spoken) → said. Every sentence
         * starts synthesising at once, but they are sent in order, each one's audio streamed
         * as it arrives, so playback starts ~0.1 s after the sentence instead of ~0.6 s.
         * Fixed lines (`fixed`) come whole from the cache.
         */
        const say = (sentence: string, fixed = false) => {
          const text = sentence.trim()
          // Spoken before the run's result checks: never say a phrase the agent's checks forbid.
          if (!text || forbidden.some((f) => text.toLowerCase().includes(f))) return
          spokenText = spokenText ? `${spokenText} ${text}` : text
          const n = seq++
          const buffered: Record<string, unknown>[] = []
          let finished = false
          let error: string | undefined
          const waiting: { wake: (() => void) | null } = { wake: null }
          const push = (event: Record<string, unknown>) => { buffered.push(event); waiting.wake?.() }
          void (async () => {
            try {
              if (fixed) {
                const line = await cachedSpeech(text, { voiceId: voice.voiceId, provider: voice.provider })
                characters += line.characters
                push({ type: 'pcm', seq: n, data: line.pcm })
                if (line.words) push({ type: 'words', seq: n, ...line.words })
                return
              }
              const stream = streamSpeech(text, { voice: voice.voiceId, provider: voice.provider })
              characters += stream.characters
              ttsModel = stream.model
              for await (const event of stream.events) {
                if (event.type === 'pcm') push({ type: 'pcm', seq: n, data: event.data.toString('base64') })
                else push({ type: 'words', seq: n, words: event.words, start: event.start, end: event.end })
              }
            } catch (e) {
              // The text answer is still useful when speech fails; the page shows it and says why.
              error = safeErrorMessage(e)
              ttsError = error
            } finally {
              finished = true
              waiting.wake?.()
            }
          })()
          ordered = ordered.then(async () => {
            send({ type: 'say', seq: n, text })
            for (;;) {
              for (const event of buffered.splice(0)) {
                if (timings.firstAudioMs === undefined && event.type === 'pcm') timings.firstAudioMs = Date.now() - started
                send(event)
              }
              if (finished) break
              await new Promise<void>((resolve) => { waiting.wake = resolve })
              waiting.wake = null
            }
            send({ type: 'said', seq: n, ttsError: error })
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
        if (status === 'timeout') say('That’s taking longer than usual. I’ve noted your question and the team will follow up.', true)
        else if (!result || status === 'failed') say(spokenReply({ status: 'failed', output: null }), true)
        else if (status === 'completed' || status === 'partial') { if (!spokenText) say(spokenReply(result)) }
        else say(spokenReply(result))

        await ordered
        lap('speakMs')
        timings.totalMs = Date.now() - started
        send({ type: 'done', status, runId, reply: spokenText, timings })
        recordTurn(agent, session.user.id, { runId, status, confidence, hintRetried, audioBytes: audio.length, ttsCharacters: characters, ttsModel, ttsError, timings })
        if (!closed) controller.close()
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
