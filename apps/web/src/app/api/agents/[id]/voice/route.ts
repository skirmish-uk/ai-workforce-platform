import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { safeErrorMessage } from '@ai-workforce/domain'
import { randomUUID } from 'node:crypto'
import { callerWantsToEnd, defaultGreeting, isConversationId, readVoiceConfig, resolveAgentContract, spokenReply, type RunAgentResult } from '@ai-workforce/executor'
import { LLMConfigError, MAX_AUDIO_BYTES, MIN_TRANSCRIPT_CONFIDENCE, SPEECH_PCM_RATE, echoesHint, hedged, notEnglishSpeech, soundsLikeEcho, streamSpeech, transcribeAudio, transcriptionHint, ttsProvider } from '@ai-workforce/llm'
import { draftDecision, enqueueAgentRun, getRedisConnection, requestAgentRunCancel, setDraftDecision, waitForAgentRun } from '@ai-workforce/queue'
import { callVocabulary, draftKeys, loadAgent } from './shared'
import { cachedSpeech, type ReserveSpeech } from './speech-cache'
import { VoiceLimitError, callBlockedBy, reserveSpeech, voiceUsage } from './tts-budget'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** What an earlier turn of the call did, after its words: the agent can't otherwise tell a hand-off it made from one it only mentioned. */
const OUTCOME_NOTES: Record<string, string> = {
  escalated: ' [Done: this was handed over to the team on this call.]',
  approval_required: ' [Done: this was passed to the team for approval on this call.]',
}

/**
 * A call is a conversation: each turn's run gets the recent exchanges (sent by the browser as
 * form field "history": [{who: 'caller'|'agent', text, outcome?}]) so "what about Saturdays?"
 * makes sense. Bounded: the last 8 lines, 400 characters each. What older turns did is kept
 * even when their words aren't: a hand-off 5 exchanges back dropped out of the window, and Ava
 * handed it over again on "Okay, that's all" (26 Oct).
 */
function withConversation(transcript: string, rawHistory: FormDataEntryValue | null, agentName: string): string {
  let history: Array<{ who?: unknown; text?: unknown; outcome?: unknown }> = []
  try {
    history = typeof rawHistory === 'string' ? JSON.parse(rawHistory) : []
  } catch { /* ignore a malformed history: the turn still works on its own */ }
  const first = agentName.split(/\s+[-–]\s+|\s+/)[0] || 'You'
  const said = (Array.isArray(history) ? history : []).filter((h) => (h.who === 'caller' || h.who === 'agent') && typeof h.text === 'string' && h.text.trim())
  const earlier = [...new Set(said.slice(0, -8).flatMap((h) => (h.who === 'agent' && OUTCOME_NOTES[String(h.outcome)] ? [OUTCOME_NOTES[String(h.outcome)].trim()] : [])))]
  const lines = said
    .slice(-8)
    .map((h) => `${h.who === 'caller' ? 'Caller' : first}: ${String(h.text).replace(/\s+/g, ' ').trim().slice(0, 400)}${h.who === 'agent' ? OUTCOME_NOTES[String(h.outcome)] ?? '' : ''}`)
  // How to talk on a call (length, tone, wrapping up) is in the agent's prompt for voice turns
  // (VOICE_STYLE); here only what has been said.
  if (!lines.length) return transcript
  const before = earlier.length ? `Earlier in the call (not shown): ${earlier.join(' ')}\n` : ''
  return `The call so far, most recent last:\n${before}${lines.join('\n')}\n\nThe caller just said: "${transcript}"`
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

/** Reserves this tenant's speech against the monthly voice limits (tts-budget.ts). */
function reserverFor(tenantId: string, settings: unknown, voice: Voice): ReserveSpeech {
  return (characters) => reserveSpeech(tenantId, settings, characters, voice.provider)
}

/** A fixed line, spoken whole (from the cache after the first time). The text still shows when speech fails. */
async function speakLine(text: string, voice: Voice, reserve: ReserveSpeech) {
  try {
    const { pcm, words, characters } = await cachedSpeech(text, { voiceId: voice.voiceId, provider: voice.provider }, reserve)
    return { speech: { pcm, words }, characters }
  } catch (error) {
    return { speech: null, ttsError: safeErrorMessage(error), characters: 0 }
  }
}

/** Short acknowledgements the call plays if the answer hasn't started ~0.6 s after the caller stops. */
const FILLERS = ['Mm-hm.', 'Okay.', 'Right.', 'Sure.']
/** Said quietly while the caller is talking at length (live transcription only), the way a listener does. */
const BACKCHANNELS = ['Mm-hm.', 'Yeah.', 'Right.', 'Uh-huh.']

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
  const { agent, voice } = loaded
  const tenant = await prisma.tenant.findUnique({ where: { id: agent.tenantId }, select: { settings: true } })
  // A call can't start once this month's voice limit is used up (the agent would be silent).
  try {
    if ((voice.provider ?? ttsProvider()) === 'cartesia') {
      const usage = await voiceUsage(agent.tenantId, tenant?.settings)
      const over = callBlockedBy(usage)
      if (over) return NextResponse.json({ error: `${new VoiceLimitError(over).message}. Typed tasks still work; voice comes back next month, or an admin can raise the limit.`, limit: over }, { status: 429 })
    }
  } catch (error) {
    console.error('Voice usage check failed:', safeErrorMessage(error))
  }
  const reserve = reserverFor(agent.tenantId, tenant?.settings, voice)
  const greeting = voice.greeting ?? defaultGreeting(agent.name)
  const backchannelLines = voice.backchannels === false ? [] : BACKCHANNELS
  const [spoken, ...clips] = await Promise.all([speakLine(greeting, voice, reserve), ...[...FILLERS, ...backchannelLines].map((f) => speakLine(f, voice, reserve))])
  const fillers = clips.slice(0, FILLERS.length)
  const backchannels = clips.slice(FILLERS.length)
  // What starting the call cost (greeting and acknowledgements are cached, so usually nothing):
  // counted with the turns when rebuilding the monthly usage.
  const ttsCharacters = [spoken, ...clips].reduce((sum, s) => sum + s.characters, 0)
  void prisma.auditLog
    .create({ data: { action: 'VOICE_CALL_STARTED', entityType: 'Agent', entityId: agent.id, tenantId: agent.tenantId, userId: session.user.id, newData: { ttsCharacters, ttsProvider: voice.provider ?? ttsProvider() } } })
    .catch((error) => console.error('Failed to record call start:', safeErrorMessage(error)))
  return NextResponse.json({
    greeting,
    rate: SPEECH_PCM_RATE,
    speech: spoken.speech,
    ttsError: spoken.ttsError,
    fillers: fillers.flatMap((f) => (f.speech ? [{ pcm: f.speech.pcm }] : [])),
    backchannels: backchannels.flatMap((f) => (f.speech ? [{ pcm: f.speech.pcm }] : [])),
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
 *
 * A draft (form field "draft", a UUID; docs/VOICE.md, "Answering while the caller speaks"): sent
 * at a pause in the caller's speech with the words so far. The answer is written straight away
 * and its first sentence voiced, but the rest of the speech, any tool call and every record wait
 * for POST ./draft: "go" when the caller finished without saying more (the page then plays this
 * stream), "drop" when they carried on (nothing is done or recorded but the model's cost).
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

    const tenantRow = await prisma.tenant.findUnique({ where: { id: agent.tenantId }, select: { name: true, settings: true } })
    const reserve = reserverFor(agent.tenantId, tenantRow?.settings, voice)
    const form = await request.formData()
    const callId = form.get('conversationId')
    const draftField = form.get('draft')
    const draft = typeof draftField === 'string' && isConversationId(draftField) ? draftKeys(draftField) : null
    // Either the caller's words, already transcribed live in the page (field "transcript"), or
    // the recording to transcribe here (field "audio").
    const liveText = form.get('transcript')
    const file = form.get('audio')
    if (typeof liveText !== 'string' && !(file instanceof Blob)) return NextResponse.json({ error: 'Send the recording as form field "audio"' }, { status: 400 })
    if (file instanceof Blob && file.size > MAX_AUDIO_BYTES) return NextResponse.json({ error: 'Recording is too long' }, { status: 413 })
    const audio = typeof liveText !== 'string' && file instanceof Blob ? Buffer.from(await file.arrayBuffer()) : null
    // Where each turn's time goes (returned to the browser and kept on the VOICE_TURN row).
    const timings: Record<string, number> = { receivedMs: Date.now() - started }
    let mark = Date.now()
    const lap = (name: string) => { const now = Date.now(); timings[name] = now - mark; mark = now }
    // A names-only hint (never what the agent said: on noise that came back as the transcript).
    const vocabulary = callVocabulary(agent.name, tenantRow?.name, voice.vocabulary, form.get('history'))

    let transcript: string
    let confidence: number | null = null
    let hintRetried = false
    // Live turns: how long the page waited for the final text after the caller stopped, and the
    // seconds of audio streamed (what live transcription bills).
    const live = typeof liveText === 'string'
      ? { waitMs: Math.max(0, Math.round(Number(form.get('liveWaitMs')) || 0)), seconds: Math.max(0, Number(form.get('liveSeconds')) || 0) }
      : null
    if (live) {
      transcript = String(liveText).replace(/\s+/g, ' ').trim().slice(0, 2000)
      timings.liveWaitMs = live.waitMs
      // On noise a transcriber sometimes reads its hint back; that is nobody speaking.
      const hint = transcriptionHint(vocabulary)
      if (hint && echoesHint(transcript, hint)) transcript = ''
    } else {
      try {
        const heard = await hedged(
          () => transcribeAudio(audio!, { mimeType: (file as Blob).type || 'audio/webm', language: 'en', vocabulary, provider: voice.sttProvider }),
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
    }
    const sttUsage = live ? { stt: 'live', liveSeconds: live.seconds } : { stt: 'upload', audioBytes: audio!.length }

    // Noise transcribed into another script, or an interruption that was only the agent's own
    // voice from the speakers (or a "mm-hm"): ignored like silence, so the agent never answers itself.
    const interrupted = form.get('interrupted') === '1'
    const ignored = notEnglishSpeech(transcript) ? 'not_english' : interrupted && soundsLikeEcho(transcript, agentLines(form.get('history'))) ? 'echo' : null
    // Nothing worth drafting an answer to: the page waits for the end of the turn instead.
    if (draft && (ignored || !transcript)) return NextResponse.json({ transcript, status: 'no_speech', draft: 'unusable' })
    if (ignored) {
      timings.totalMs = Date.now() - started
      recordTurn(agent, session.user.id, { runId: null, status: 'no_speech', ignored, transcript, confidence, hintRetried, ...sttUsage, ttsCharacters: 0, timings })
      return NextResponse.json({ transcript, confidence, reply: '', status: 'no_speech', ignored, runId: null, timings, speech: null })
    }

    // Nothing usable was heard: answer at once, without running the agent.
    if (!transcript || (confidence !== null && confidence < MIN_TRANSCRIPT_CONFIDENCE)) {
      const status = transcript ? 'unclear' : 'no_speech'
      // Garbled audio comes back as confident-looking words in a random language; don't act on it.
      const reply = transcript ? 'Sorry, I didn’t catch that clearly. Could you say it again, a little closer to the microphone?' : 'Sorry, I didn’t catch that. Could you say it again?'
      // The browser drops a turn with no speech, so don't spend time or money speaking it.
      const spoken = status === 'no_speech' ? { speech: null, characters: 0 } : await speakLine(reply, voice, reserve)
      timings.totalMs = Date.now() - started
      recordTurn(agent, session.user.id, { runId: null, status, confidence, hintRetried, ...sttUsage, ttsCharacters: spoken.characters, timings })
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
    if (draft) await getRedisConnection().set(draft.owner, `${session.user.id}:${agent.id}`, 'EX', 300)
    const job = await enqueueAgentRun(
      { agentId: agent.id, input: withConversation(transcript, form.get('history'), agent.name), userId: session.user.id, trigger: 'voice', streamChannel: channel, conversation: isConversationId(callId) ? { id: callId, message: transcript } : undefined, holdKey: draft?.hold },
      { jobId: draft?.jobId }
    )
    const runId = job.id ?? null
    // A draft goes ahead once the caller has finished without saying more; anything else is final now.
    const go = draft ? draftDecision(draft.hold) : Promise.resolve(true)
    if (draft) void go.then((ok) => { if (ok) timings.draftHeldMs = Date.now() - started })
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
              // A draft voices only its first sentence before the caller has finished (what makes
              // it instant); the rest waits, so a dropped draft costs a sentence of speech at most.
              if (n > 0 && !(await go)) return
              if (fixed) {
                const line = await cachedSpeech(text, { voiceId: voice.voiceId, provider: voice.provider }, reserve)
                characters += line.characters
                push({ type: 'pcm', seq: n, data: line.pcm })
                if (line.words) push({ type: 'words', seq: n, ...line.words })
                return
              }
              const stream = streamSpeech(text, { voice: voice.voiceId, provider: voice.provider })
              // Within this month's voice limit, or this sentence is shown, not spoken.
              const giveBack = await reserve(stream.characters)
              characters += stream.characters
              let received = false
              ttsModel = stream.model
              try {
                for await (const event of stream.events) {
                  received = true
                  if (event.type === 'pcm') push({ type: 'pcm', seq: n, data: event.data.toString('base64') })
                  else push({ type: 'words', seq: n, words: event.words, start: event.start, end: event.end })
                }
              } catch (e) {
                // Nothing came back, so nothing was billed: give the characters back.
                if (!received) { characters -= stream.characters; await giveBack() }
                throw e
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
        // A dropped draft ends here: the run discards itself at its next step (the cancel stops it sooner).
        const dropped = go.then((ok) => (ok ? new Promise<never>(() => undefined) : ('dropped' as const)))
        try {
          const outcome = runId ? await Promise.race([waitForAgentRun<RunAgentResult>(runId, 45_000, 100), dropped]) : null
          if (outcome === 'dropped') {
            if (runId) void requestAgentRunCancel(runId).catch(() => undefined)
            if (!closed) controller.close()
            return
          }
          // The last published deltas can land just after the job completes.
          await new Promise((resolve) => setTimeout(resolve, 80))
          if (outcome?.state === 'completed' && outcome.result) {
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
        else if (status === 'completed' || status === 'partial') { if (!spokenText) say(spokenReply(result), result.endCall) }
        // A hand-off the agent already explained in its own words isn't repeated with a stock line.
        else if (status === 'escalated') { if (!spokenText) say(spokenReply(result), true) }
        // Approvals always get the stock line: it never claims a gated action was done. Stock
        // lines are cached; clarifying questions are the agent's own words, so they aren't.
        else say(spokenReply(result), status !== 'needs_clarification')
        // The caller said they're done ("Okay, that's all") but the agent handed something over or
        // asked for approval instead of saying goodbye (those end its turn, so it can't also end the
        // call): say goodbye and end the call anyway, as asked.
        const closing = result?.endCall !== true && (status === 'escalated' || status === 'approval_required') && callerWantsToEnd(transcript)
        if (closing) say('Thanks for calling. Have a great day!', true)
        const endCall = result?.endCall === true || closing

        await ordered
        lap('speakMs')
        timings.totalMs = Date.now() - started
        // endCall: the agent said goodbye; the page hangs up about a second after it finishes speaking.
        send({ type: 'done', status, runId, reply: spokenText, endCall, timings })
        recordTurn(agent, session.user.id, { runId, status, endCall: endCall || undefined, closedAfterHandOff: closing || undefined, confidence, hintRetried, ...sttUsage, ttsCharacters: characters, ttsModel, ttsError, timings })
        if (!closed) controller.close()
      },
      // The page stopped listening (a dropped draft, or the caller hung up).
      cancel() {
        if (draft) void setDraftDecision(draft.hold, false).catch(() => undefined)
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
