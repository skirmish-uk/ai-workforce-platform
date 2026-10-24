import OpenAI, { toFile } from 'openai'
import { LLMConfigError } from './types'

/**
 * Speech-to-text and text-to-speech for voice agents (docs/VOICE.md).
 *
 * Providers:
 * - speech-to-text: "openai" (gpt-4o-mini-transcribe), "deepgram" (Nova-3) or "speechmatics"
 *   (batch, "enhanced"); compareTranscription() runs one recording through every configured one
 * - text-to-speech: "openai" (gpt-4o-mini-tts) or "cartesia" (Sonic, lower latency, custom voices)
 *
 * Selected with SPEECH_STT_PROVIDER / SPEECH_TTS_PROVIDER (default "openai", so one
 * OPENAI_API_KEY covers transcription, speech and knowledge embeddings). Turn-based:
 * one recorded utterance in, one audio reply out. Real-time streaming (phone calls)
 * is a separate service; see docs/VOICE.md.
 */

export type SttProvider = 'openai' | 'deepgram' | 'speechmatics'
export const STT_PROVIDERS: SttProvider[] = ['openai', 'deepgram', 'speechmatics']
export type TtsProvider = 'openai' | 'cartesia'

/**
 * Compared with gpt-4o-transcribe on 21 Oct on degraded audio (quiet, band-limited, fan noise):
 * equally accurate once given a vocabulary hint, and on pure noise the mini model returns
 * nothing where the larger one invented short phrases in other languages. SPEECH_STT_MODEL overrides.
 */
export const OPENAI_STT_MODEL = 'gpt-4o-mini-transcribe'
/** Deepgram's current model (docs, 21 Oct 2026); DEEPGRAM_STT_MODEL overrides. Key terms need Nova-3. */
export const DEEPGRAM_STT_MODEL = 'nova-3'
/** Speechmatics batch `transcription_config.model` ("model" replaced "operating_point", July 2026); SPEECHMATICS_STT_MODEL overrides ("standard" is faster). */
export const SPEECHMATICS_STT_MODEL = 'enhanced'
/** A Speechmatics batch job for one utterance is polled this often, and given up on after STT_TIMEOUT_MS. */
const SPEECHMATICS_POLL_MS = 250
const STT_TIMEOUT_MS = 30_000
export const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts'
export const OPENAI_DEFAULT_VOICE = 'coral'
export const CARTESIA_TTS_MODEL = 'sonic-3.6'
/** generation_config.volume: 0.5–2.0, default 1 (sonic-3 and newer). */
export const CARTESIA_VOLUME = 1.6
/** Cartesia API version, checked against docs.cartesia.ai on 2026-10-13. */
export const CARTESIA_API_VERSION = '2026-08-14'

/** Upper bound on one utterance; longer audio is refused before it costs anything. */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024
/** Upper bound on text sent to text-to-speech in one reply (characters are what TTS bills). */
export const MAX_TTS_CHARS = 1500
/**
 * Below this mean token probability a transcript is treated as "didn't catch that".
 * Calibrated on real gpt-4o-mini-transcribe calls (2026-10-13): clear speech 0.97–0.99,
 * heavily distorted but correct speech 0.82, unintelligible audio that came back as
 * foreign-sounding gibberish 0.23. (Silence and noise come back empty.)
 */
export const MIN_TRANSCRIPT_CONFIDENCE = 0.5

export interface SpeechDeps {
  openai?: Pick<OpenAI, 'audio'>
  fetch?: typeof fetch
  env?: Record<string, string | undefined>
}

export interface TranscriptionResult {
  text: string
  provider: SttProvider
  model: string
  /** Bytes of audio received, for usage records. */
  audioBytes: number
  /** The vocabulary hint came back as the transcript (noise), so it was transcribed again without it. */
  hintRetried?: boolean
  /**
   * Mean per-token probability from the transcriber (0–1), or null when not reported.
   * Near-silent or noisy audio produces confident-sounding gibberish in a random
   * language with a low score; callers should treat a low score as "didn't catch that".
   */
  confidence: number | null
}

export interface SpeechResult {
  audio: Buffer
  mimeType: string
  provider: TtsProvider
  model: string
  voice: string
  /** Characters synthesised: the unit TTS vendors bill by. */
  characters: number
}

function openaiClient(deps: SpeechDeps): Pick<OpenAI, 'audio'> {
  if (deps.openai) return deps.openai
  const apiKey = (deps.env ?? process.env).OPENAI_API_KEY
  if (!apiKey) throw new LLMConfigError('OPENAI_API_KEY is not configured. Voice agents use OpenAI for speech-to-text; set it in .env.')
  return new OpenAI({ apiKey })
}

export function sttProvider(env: Record<string, string | undefined> = process.env): SttProvider {
  const value = (env.SPEECH_STT_PROVIDER || 'openai').toLowerCase()
  if (!STT_PROVIDERS.includes(value as SttProvider)) throw new LLMConfigError(`Unsupported SPEECH_STT_PROVIDER "${value}". Supported: ${STT_PROVIDERS.join(', ')}.`)
  return value as SttProvider
}

const STT_KEYS: Record<SttProvider, string> = { openai: 'OPENAI_API_KEY', deepgram: 'DEEPGRAM_API_KEY', speechmatics: 'SPEECHMATICS_API_KEY' }

/** The speech-to-text providers that have an API key set, in a fixed order. */
export function configuredSttProviders(env: Record<string, string | undefined> = process.env): SttProvider[] {
  return STT_PROVIDERS.filter((p) => Boolean(env[STT_KEYS[p]]))
}

function sttKey(provider: SttProvider, env: Record<string, string | undefined>): string {
  const key = env[STT_KEYS[provider]]
  if (!key) throw new LLMConfigError(`${STT_KEYS[provider]} is not configured: speech-to-text provider "${provider}" needs it.`)
  return key
}

export function ttsProvider(env: Record<string, string | undefined> = process.env): TtsProvider {
  const value = (env.SPEECH_TTS_PROVIDER || 'openai').toLowerCase()
  if (value !== 'openai' && value !== 'cartesia') throw new LLMConfigError(`Unsupported SPEECH_TTS_PROVIDER "${value}". Supported: openai, cartesia.`)
  return value
}

/** At most this many hint terms; the transcription prompt is short context, not a dictionary. */
const MAX_HINT_TERMS = 30

/**
 * A transcription hint from names and terms the caller is likely to say (business, people,
 * places). Names are what speech-to-text gets wrong on poor microphones ("Cloud 9" for
 * CloudNine, "you here" for Maria); a hint fixes them. Only a term list: quoting what the
 * agent last said made the model return that line for background noise.
 */
export function transcriptionHint(terms: Array<string | null | undefined>): string | undefined {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const raw of terms) {
    const term = (raw ?? '').replace(/[\s"]+/g, ' ').trim().slice(0, 60)
    if (!term || seen.has(term.toLowerCase())) continue
    seen.add(term.toLowerCase())
    kept.push(term)
    if (kept.length >= MAX_HINT_TERMS) break
  }
  return kept.length ? kept.join(', ') + '.' : undefined
}

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []

/**
 * Whether a transcript is the hint read back: on noise with a hint, the model sometimes returns
 * the hint itself (measured 21 Oct: 5 of 9 noise clips). Real speech made only of hint terms
 * is rare; when it happens the retry without the hint still hears it.
 */
export function echoesHint(transcript: string, hint: string): boolean {
  const said = words(transcript)
  if (said.length < 3) return false
  const vocabulary = new Set([...words(hint), 'vocabulary', 'context', 'names'])
  return said.filter((w) => vocabulary.has(w)).length / said.length >= 0.8
}

/** Words that only acknowledge ("mm-hm", "okay"): not something to stop the agent for. */
const BACKCHANNEL = new Set(['mm', 'mmm', 'hm', 'hmm', 'mhm', 'mm-hm', 'uh', 'huh', 'uh-huh', 'uhum', 'um', 'ok', 'okay', 'sure', 'right', 'yeah', 'yep', 'yes', 'alright', 'all', 'great', 'thanks', 'cool'])

/**
 * Whether a turn that cut the agent off is really the agent's own voice, or just a
 * backchannel, rather than the caller saying something. On laptop speakers with weak echo
 * cancellation, the agent's voice from the speakers interrupted it and was transcribed as the
 * caller ("Sure.", "Great! Growth is our..."), and the agent then answered itself in a loop.
 * Only used for interruptions: the same words said when the agent is quiet are a real turn.
 */
export function soundsLikeEcho(transcript: string, agentLines: string[]): boolean {
  const said = words(transcript)
  if (!said.length) return true
  if (said.every((w) => BACKCHANNEL.has(w))) return true
  const agent = new Set(agentLines.flatMap(words))
  return said.length >= 2 && said.filter((w) => agent.has(w)).length / said.length >= 0.75
}

/** No English letters at all: noise transcribed as another script ("Угу", "誰だ?"), not a caller speaking English. */
export function notEnglishSpeech(transcript: string): boolean {
  return Boolean(transcript) && !/[a-z]/i.test(transcript)
}

export async function transcribeAudio(
  audio: Buffer,
  options: { mimeType: string; language?: string; prompt?: string; vocabulary?: Array<string | null | undefined>; provider?: SttProvider },
  deps: SpeechDeps = {}
): Promise<TranscriptionResult> {
  if (!audio.length) throw new Error('No audio received')
  if (audio.length > MAX_AUDIO_BYTES) throw new Error(`Audio is larger than ${MAX_AUDIO_BYTES / 1024 / 1024} MB`)
  const env = deps.env ?? process.env
  const provider = options.provider ?? sttProvider(env)
  if (provider === 'deepgram') return transcribeDeepgram(audio, options, env, deps)
  if (provider === 'speechmatics') return transcribeSpeechmatics(audio, options, env, deps)
  const model = env.SPEECH_STT_MODEL || OPENAI_STT_MODEL
  const extension = options.mimeType.includes('ogg') ? 'ogg' : options.mimeType.includes('mp4') || options.mimeType.includes('m4a') ? 'm4a' : options.mimeType.includes('wav') ? 'wav' : options.mimeType.includes('mpeg') ? 'mp3' : 'webm'
  const hint = options.prompt ?? (options.vocabulary ? transcriptionHint(options.vocabulary) : undefined)
  const transcribe = async (prompt: string | undefined) => {
    const file = await toFile(audio, `utterance.${extension}`, { type: options.mimeType })
    const result = (await openaiClient(deps).audio.transcriptions.create({
      file,
      model,
      include: ['logprobs'],
      ...(options.language ? { language: options.language } : {}),
      ...(prompt ? { prompt } : {}),
    })) as { text: string; logprobs?: Array<{ logprob?: number }> }
    const probs = (result.logprobs ?? []).map((l) => (typeof l.logprob === 'number' ? Math.exp(l.logprob) : null)).filter((p): p is number => p !== null)
    return { text: result.text.trim(), confidence: probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : null }
  }
  let heard = await transcribe(hint)
  let hintRetried = false
  if (hint && echoesHint(heard.text, hint)) {
    heard = await transcribe(undefined)
    hintRetried = true
  }
  return { text: heard.text, provider, model, audioBytes: audio.length, confidence: heard.confidence, ...(hintRetried ? { hintRetried } : {}) }
}

/** Hint terms as separate words or short phrases (the providers' custom vocabulary takes a list). */
function hintTerms(vocabulary: Array<string | null | undefined> | undefined, maxWords: number): string[] {
  const hint = vocabulary ? transcriptionHint(vocabulary) : undefined
  return hint ? hint.slice(0, -1).split(', ').filter((t) => t.split(/\s+/).length <= maxWords) : []
}

async function failed(name: string, response: Response): Promise<Error> {
  const detail = (await response.text().catch(() => '')).slice(0, 300)
  return new Error(`${name} speech-to-text failed (${response.status})${detail ? `: ${detail}` : ''}`)
}

/**
 * Deepgram pre-recorded: POST /v1/listen with the raw audio. The vocabulary goes in as Nova-3
 * key terms (one `keyterm` parameter each), which bias recognition without being returned
 * as text on noise. Confidence is Deepgram's own 0–1 score for the transcript.
 */
async function transcribeDeepgram(
  audio: Buffer,
  options: { mimeType: string; language?: string; vocabulary?: Array<string | null | undefined> },
  env: Record<string, string | undefined>,
  deps: SpeechDeps
): Promise<TranscriptionResult> {
  const model = env.DEEPGRAM_STT_MODEL || DEEPGRAM_STT_MODEL
  const params = new URLSearchParams({ model, smart_format: 'true', language: env.DEEPGRAM_LANGUAGE || options.language || 'en' })
  for (const term of hintTerms(options.vocabulary, 6)) params.append('keyterm', term)
  const response = await (deps.fetch ?? fetch)(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${sttKey('deepgram', env)}`, 'Content-Type': options.mimeType.split(';')[0] || 'audio/wav' },
    body: new Uint8Array(audio),
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  })
  if (!response.ok) throw await failed('Deepgram', response)
  const body = (await response.json()) as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string; confidence?: number }> }> } }
  const best = body.results?.channels?.[0]?.alternatives?.[0]
  const text = (best?.transcript ?? '').trim()
  return { text, provider: 'deepgram', model, audioBytes: audio.length, confidence: text && typeof best?.confidence === 'number' ? best.confidence : null }
}

interface SpeechmaticsItem { type?: string; attaches_to?: string; alternatives?: Array<{ content?: string; confidence?: number }> }

/**
 * Speechmatics batch: submit a job (multipart "config" + "data_file"), poll it until "done",
 * then read the json-v2 transcript. Batch jobs queue, so this is slower per utterance than the
 * other two; their real-time API (a websocket) would be the one to use for live calls.
 * The vocabulary goes in as additional_vocab (custom dictionary).
 */
async function transcribeSpeechmatics(
  audio: Buffer,
  options: { mimeType: string; language?: string; vocabulary?: Array<string | null | undefined> },
  env: Record<string, string | undefined>,
  deps: SpeechDeps
): Promise<TranscriptionResult> {
  const doFetch = deps.fetch ?? fetch
  const base = env.SPEECHMATICS_API_URL || 'https://asr.api.speechmatics.com'
  const auth = { Authorization: `Bearer ${sttKey('speechmatics', env)}` }
  const model = env.SPEECHMATICS_STT_MODEL || SPEECHMATICS_STT_MODEL
  const vocab = hintTerms(options.vocabulary, 6).map((content) => ({ content }))
  const config = { type: 'transcription', transcription_config: { language: env.SPEECHMATICS_LANGUAGE || options.language || 'en', model, ...(vocab.length ? { additional_vocab: vocab } : {}) } }
  const form = new FormData()
  form.append('config', JSON.stringify(config))
  form.append('data_file', new Blob([new Uint8Array(audio)], { type: options.mimeType }), options.mimeType.includes('wav') ? 'utterance.wav' : 'utterance')
  const deadline = Date.now() + STT_TIMEOUT_MS
  const created = await doFetch(`${base}/v2/jobs`, { method: 'POST', headers: auth, body: form, signal: AbortSignal.timeout(STT_TIMEOUT_MS) })
  if (!created.ok) throw await failed('Speechmatics', created)
  const { id } = (await created.json()) as { id?: string }
  if (!id) throw new Error('Speechmatics did not return a job id')
  for (;;) {
    const status = await doFetch(`${base}/v2/jobs/${encodeURIComponent(id)}`, { headers: auth })
    if (!status.ok) throw await failed('Speechmatics', status)
    const { job } = (await status.json()) as { job?: { status?: string; errors?: unknown } }
    if (job?.status === 'done') break
    if (job?.status === 'rejected' || job?.status === 'deleted') throw new Error(`Speechmatics job ${job.status}: ${JSON.stringify(job.errors ?? '').slice(0, 200)}`)
    if (Date.now() > deadline) throw new Error('Speechmatics did not finish within 30 s')
    await new Promise((resolve) => setTimeout(resolve, SPEECHMATICS_POLL_MS))
  }
  const result = await doFetch(`${base}/v2/jobs/${encodeURIComponent(id)}/transcript?format=json-v2`, { headers: auth })
  if (!result.ok) throw await failed('Speechmatics', result)
  const items = ((await result.json()) as { results?: SpeechmaticsItem[] }).results ?? []
  let text = ''
  const confidences: number[] = []
  for (const item of items) {
    const best = item.alternatives?.[0]
    if (!best?.content) continue
    const joined = item.type === 'punctuation' || item.attaches_to === 'previous'
    text += joined || !text ? best.content : ` ${best.content}`
    if (item.type === 'word' && typeof best.confidence === 'number') confidences.push(best.confidence)
  }
  return { text: text.trim(), provider: 'speechmatics', model, audioBytes: audio.length, confidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null }
}

export interface TranscriptionComparison {
  provider: SttProvider
  model?: string
  text?: string
  confidence?: number | null
  /** Wall-clock time for this provider, request to transcript. */
  ms: number
  error?: string
}

/**
 * One recording through every configured speech-to-text provider at once, with the same
 * vocabulary, for choosing between them on real voices and microphones.
 */
export async function compareTranscription(
  audio: Buffer,
  options: { mimeType: string; language?: string; vocabulary?: Array<string | null | undefined>; providers?: SttProvider[] },
  deps: SpeechDeps = {}
): Promise<TranscriptionComparison[]> {
  const providers = options.providers ?? configuredSttProviders(deps.env ?? process.env)
  return Promise.all(providers.map(async (provider) => {
    const started = Date.now()
    try {
      const heard = await transcribeAudio(audio, { ...options, provider }, deps)
      return { provider, model: heard.model, text: heard.text, confidence: heard.confidence, ms: Date.now() - started }
    } catch (error) {
      return { provider, ms: Date.now() - started, error: error instanceof Error ? error.message.slice(0, 300) : 'failed' }
    }
  }))
}

/** Removes markdown and other things that read badly aloud, and caps the length. */
export function toSpeakableText(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length <= MAX_TTS_CHARS) return cleaned
  const cut = cleaned.slice(0, MAX_TTS_CHARS)
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  return (lastStop > MAX_TTS_CHARS / 2 ? cut.slice(0, lastStop + 1) : cut).trim()
}

export async function synthesizeSpeech(
  text: string,
  options: { voice?: string; provider?: TtsProvider; instructions?: string } = {},
  deps: SpeechDeps = {}
): Promise<SpeechResult> {
  const env = deps.env ?? process.env
  const speakable = toSpeakableText(text)
  if (!speakable) throw new Error('Nothing to say')
  const provider = options.provider ?? ttsProvider(env)

  if (provider === 'cartesia') {
    const apiKey = env.CARTESIA_API_KEY
    if (!apiKey) throw new LLMConfigError('CARTESIA_API_KEY is not configured. Set it in .env or use SPEECH_TTS_PROVIDER=openai.')
    const voice = options.voice ?? env.CARTESIA_VOICE_ID
    if (!voice) throw new LLMConfigError('No Cartesia voice id: set the agent\'s voice.voiceId or CARTESIA_VOICE_ID.')
    const response = await (deps.fetch ?? fetch)('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Cartesia-Version': CARTESIA_API_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: CARTESIA_TTS_MODEL,
        transcript: speakable,
        voice: { id: voice },
        language: 'en',
        // Cartesia's default level sounded quiet on laptop speakers next to the OpenAI voices.
        generation_config: { volume: CARTESIA_VOLUME },
        output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
      }),
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      throw new Error(`Cartesia text-to-speech failed (${response.status})${detail ? `: ${detail}` : ''}`)
    }
    return { audio: Buffer.from(await response.arrayBuffer()), mimeType: 'audio/mpeg', provider, model: CARTESIA_TTS_MODEL, voice, characters: speakable.length }
  }

  const voice = options.voice ?? OPENAI_DEFAULT_VOICE
  const response = await openaiClient(deps).audio.speech.create({
    model: OPENAI_TTS_MODEL,
    voice,
    input: speakable,
    response_format: 'mp3',
    ...(options.instructions ? { instructions: options.instructions } : {}),
  })
  return { audio: Buffer.from(await response.arrayBuffer()), mimeType: 'audio/mpeg', provider, model: OPENAI_TTS_MODEL, voice, characters: speakable.length }
}

/**
 * Runs a request and, if it hasn't answered within `afterMs`, the same request again; the
 * first answer wins. Transcribing one utterance usually takes 0.55–1 s, but about one in five
 * took 1.7–2.3 s (live, 21 Oct) for no reason in the audio: a second try cuts that tail.
 * Fails only when every attempt has failed. `onHedge` says a second attempt was started.
 */
export function hedged<T>(run: () => Promise<T>, afterMs: number, onHedge?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    let started = 0
    let failures = 0
    const attempt = () => {
      started++
      run().then(
        (value) => { if (!settled) { settled = true; resolve(value) } },
        (error) => { if (++failures === started && !settled) { settled = true; reject(error) } }
      )
    }
    attempt()
    setTimeout(() => { if (!settled) { onHedge?.(); attempt() } }, afterMs)
  })
}

/** Streamed speech is raw 16-bit little-endian mono PCM at this rate (both providers' native streaming format). */
export const SPEECH_PCM_RATE = 24_000

export type SpeechStreamEvent =
  | { type: 'pcm'; data: Buffer }
  /** When each word is spoken, in seconds from the start of the clip (Cartesia only). */
  | { type: 'words'; words: string[]; start: number[]; end: number[] }

export interface SpeechStream {
  provider: TtsProvider
  model: string
  voice: string
  characters: number
  /** Audio as it is generated (the first chunk ~0.1 s after the request, against ~0.6 s for a whole sentence). */
  events: AsyncGenerator<SpeechStreamEvent>
}

/** Yields whole 16-bit samples: a network chunk can end halfway through one. */
async function* wholeSamples(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let carry: Buffer | null = null
  for await (const chunk of chunks) {
    const data: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk
    const even = data.length - (data.length % 2)
    carry = even < data.length ? data.subarray(even) : null
    if (even) yield data.subarray(0, even)
  }
}

async function* bodyChunks(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Buffer> {
  if (!body) return
  const reader = body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      if (value?.length) yield Buffer.from(value)
    }
  } finally {
    reader.releaseLock()
  }
}

/** Cartesia /tts/sse: `data: {json}` frames of type chunk (base64 audio), timestamps, done or error. */
async function* cartesiaEvents(body: ReadableStream<Uint8Array> | null): AsyncGenerator<SpeechStreamEvent> {
  const decoder = new TextDecoder()
  let pending = ''
  let carry: Buffer | null = null
  for await (const chunk of bodyChunks(body)) {
    pending += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
    let end: number
    while ((end = pending.indexOf('\n\n')) >= 0) {
      const frame = pending.slice(0, end)
      pending = pending.slice(end + 2)
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('')
      if (!data) continue
      const event = JSON.parse(data) as { type?: string; data?: string; word_timestamps?: { words: string[]; start: number[]; end: number[] }; message?: string; title?: string }
      if (event.type === 'chunk' && event.data) {
        // Whole 16-bit samples only: keep a stray last byte for the next chunk.
        const audio: Buffer = carry ? Buffer.concat([carry, Buffer.from(event.data, 'base64')]) : Buffer.from(event.data, 'base64')
        const even = audio.length - (audio.length % 2)
        carry = even < audio.length ? audio.subarray(even) : null
        if (even) yield { type: 'pcm', data: audio.subarray(0, even) }
      } else if (event.type === 'timestamps' && event.word_timestamps) {
        yield { type: 'words', words: event.word_timestamps.words, start: event.word_timestamps.start, end: event.word_timestamps.end }
      } else if (event.type === 'error') {
        throw new Error(`Cartesia text-to-speech failed: ${event.message ?? event.title ?? 'stream error'}`)
      } else if (event.type === 'done') {
        return
      }
    }
  }
}

/**
 * Speaks text as a stream of PCM chunks (SPEECH_PCM_RATE), so playback can start as soon as
 * the first ~0.1 s is generated. Cartesia also reports when each word is spoken, which the
 * call page uses to show the words as they are said.
 */
export function streamSpeech(
  text: string,
  options: { voice?: string; provider?: TtsProvider; instructions?: string; signal?: AbortSignal } = {},
  deps: SpeechDeps = {}
): SpeechStream {
  const env = deps.env ?? process.env
  const speakable = toSpeakableText(text)
  if (!speakable) throw new Error('Nothing to say')
  const provider = options.provider ?? ttsProvider(env)

  if (provider === 'cartesia') {
    const apiKey = env.CARTESIA_API_KEY
    if (!apiKey) throw new LLMConfigError('CARTESIA_API_KEY is not configured. Set it in .env or use SPEECH_TTS_PROVIDER=openai.')
    const voice = options.voice ?? env.CARTESIA_VOICE_ID
    if (!voice) throw new LLMConfigError('No Cartesia voice id: set the agent\'s voice.voiceId or CARTESIA_VOICE_ID.')
    const events = (async function* () {
      const response = await (deps.fetch ?? fetch)('https://api.cartesia.ai/tts/sse', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Cartesia-Version': CARTESIA_API_VERSION, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_id: CARTESIA_TTS_MODEL,
          transcript: speakable,
          voice: { id: voice },
          language: 'en',
          add_timestamps: true,
          generation_config: { volume: CARTESIA_VOLUME },
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: SPEECH_PCM_RATE },
        }),
        signal: options.signal,
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300)
        throw new Error(`Cartesia text-to-speech failed (${response.status})${detail ? `: ${detail}` : ''}`)
      }
      yield* cartesiaEvents(response.body)
    })()
    return { provider, model: CARTESIA_TTS_MODEL, voice, characters: speakable.length, events }
  }

  const voice = options.voice ?? OPENAI_DEFAULT_VOICE
  const client = openaiClient(deps)
  const events = (async function* () {
    // "pcm" is 24 kHz 16-bit little-endian mono, streamed as it is generated.
    const response = await client.audio.speech.create(
      { model: OPENAI_TTS_MODEL, voice, input: speakable, response_format: 'pcm', ...(options.instructions ? { instructions: options.instructions } : {}) },
      { signal: options.signal }
    )
    for await (const data of wholeSamples(bodyChunks(response.body))) yield { type: 'pcm' as const, data }
  })()
  return { provider, model: OPENAI_TTS_MODEL, voice, characters: speakable.length, events }
}

// ---------------------------------------------------------------------------------------------
// Voice cloning (Cartesia instant clone). Used by the dashboard's "Use your own voice": the
// caller must already hold the speaker's consent (Agent.config.voice.clonedVoice records it).
// ---------------------------------------------------------------------------------------------

/** Cartesia accepts clips up to 16 MB; about 10 s is the minimum, and up to 60 s keeps the accent better. */
export const CLONE_MAX_BYTES = 16 * 1024 * 1024
export const CLONE_MIN_SECONDS = 10
export const CLONE_MAX_SECONDS = 120

function cartesiaKey(env: Record<string, string | undefined>): string {
  const apiKey = env.CARTESIA_API_KEY
  if (!apiKey) throw new LLMConfigError('CARTESIA_API_KEY is not configured: voice cloning uses Cartesia.')
  return apiKey
}

/** Creates a private Cartesia voice from one recording and returns its id. Nothing else is stored. */
export async function cloneCartesiaVoice(
  clip: Buffer,
  options: { mimeType: string; name: string; description?: string; language?: string },
  deps: SpeechDeps = {}
): Promise<{ voiceId: string; name: string }> {
  const env = deps.env ?? process.env
  if (clip.length > CLONE_MAX_BYTES) throw new Error('The recording is larger than the 16 MB Cartesia accepts')
  const form = new FormData()
  form.append('clip', new Blob([new Uint8Array(clip)], { type: options.mimeType }), options.mimeType.includes('wav') ? 'voice.wav' : 'voice')
  form.append('name', options.name.slice(0, 100))
  form.append('language', options.language ?? 'en')
  if (options.description) form.append('description', options.description.slice(0, 500))
  form.append('access', 'private')
  const response = await (deps.fetch ?? fetch)('https://api.cartesia.ai/voices/clone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cartesiaKey(env)}`, 'Cartesia-Version': CARTESIA_API_VERSION },
    body: form,
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw new Error(`Cartesia voice cloning failed (${response.status})${detail ? `: ${detail}` : ''}`)
  }
  const body = (await response.json()) as { id?: unknown; name?: unknown }
  if (typeof body.id !== 'string' || !body.id) throw new Error('Cartesia did not return a voice id')
  return { voiceId: body.id, name: typeof body.name === 'string' ? body.name : options.name }
}

/** Deletes a cloned voice at Cartesia. A voice that is already gone counts as deleted. */
export async function deleteCartesiaVoice(voiceId: string, deps: SpeechDeps = {}): Promise<void> {
  const env = deps.env ?? process.env
  const response = await (deps.fetch ?? fetch)(`https://api.cartesia.ai/voices/${encodeURIComponent(voiceId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${cartesiaKey(env)}`, 'Cartesia-Version': CARTESIA_API_VERSION },
  })
  if (!response.ok && response.status !== 404) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw new Error(`Cartesia voice deletion failed (${response.status})${detail ? `: ${detail}` : ''}`)
  }
}

/** Seconds of audio in a PCM WAV file (from its header), or null when it isn't one. */
export function wavDurationSeconds(wav: Buffer): number | null {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let byteRate = 0
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'fmt ' && offset + 16 <= wav.length) byteRate = wav.readUInt32LE(offset + 16)
    if (id === 'data') return byteRate ? Math.min(size, wav.length - offset - 8) / byteRate : null
    offset += 8 + size + (size % 2)
  }
  return null
}
