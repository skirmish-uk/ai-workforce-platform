import OpenAI, { toFile } from 'openai'
import { LLMConfigError } from './types'

/**
 * Speech-to-text and text-to-speech for voice agents (docs/VOICE.md).
 *
 * Providers:
 * - speech-to-text: "openai" (gpt-4o-mini-transcribe)
 * - text-to-speech: "openai" (gpt-4o-mini-tts) or "cartesia" (Sonic, lower latency, custom voices)
 *
 * Selected with SPEECH_STT_PROVIDER / SPEECH_TTS_PROVIDER (default "openai", so one
 * OPENAI_API_KEY covers transcription, speech and knowledge embeddings). Turn-based:
 * one recorded utterance in, one audio reply out. Real-time streaming (phone calls)
 * is a separate service; see docs/VOICE.md.
 */

export type SttProvider = 'openai'
export type TtsProvider = 'openai' | 'cartesia'

export const OPENAI_STT_MODEL = 'gpt-4o-mini-transcribe'
export const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts'
export const OPENAI_DEFAULT_VOICE = 'coral'
export const CARTESIA_TTS_MODEL = 'sonic-3.6'
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
  if (value !== 'openai') throw new LLMConfigError(`Unsupported SPEECH_STT_PROVIDER "${value}". Supported: openai.`)
  return value
}

export function ttsProvider(env: Record<string, string | undefined> = process.env): TtsProvider {
  const value = (env.SPEECH_TTS_PROVIDER || 'openai').toLowerCase()
  if (value !== 'openai' && value !== 'cartesia') throw new LLMConfigError(`Unsupported SPEECH_TTS_PROVIDER "${value}". Supported: openai, cartesia.`)
  return value
}

export async function transcribeAudio(
  audio: Buffer,
  options: { mimeType: string; language?: string; prompt?: string },
  deps: SpeechDeps = {}
): Promise<TranscriptionResult> {
  if (!audio.length) throw new Error('No audio received')
  if (audio.length > MAX_AUDIO_BYTES) throw new Error(`Audio is larger than ${MAX_AUDIO_BYTES / 1024 / 1024} MB`)
  const provider = sttProvider(deps.env)
  const extension = options.mimeType.includes('ogg') ? 'ogg' : options.mimeType.includes('mp4') || options.mimeType.includes('m4a') ? 'm4a' : options.mimeType.includes('wav') ? 'wav' : options.mimeType.includes('mpeg') ? 'mp3' : 'webm'
  const file = await toFile(audio, `utterance.${extension}`, { type: options.mimeType })
  const result = (await openaiClient(deps).audio.transcriptions.create({
    file,
    model: OPENAI_STT_MODEL,
    include: ['logprobs'],
    ...(options.language ? { language: options.language } : {}),
    ...(options.prompt ? { prompt: options.prompt } : {}),
  })) as { text: string; logprobs?: Array<{ logprob?: number }> }
  const probs = (result.logprobs ?? []).map((l) => (typeof l.logprob === 'number' ? Math.exp(l.logprob) : null)).filter((p): p is number => p !== null)
  const confidence = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : null
  return { text: result.text.trim(), provider, model: OPENAI_STT_MODEL, audioBytes: audio.length, confidence }
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
