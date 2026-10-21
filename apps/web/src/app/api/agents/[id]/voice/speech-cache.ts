import { createHash } from 'node:crypto'
import { safeErrorMessage } from '@ai-workforce/domain'
import { CARTESIA_TTS_MODEL, CARTESIA_VOLUME, OPENAI_TTS_MODEL, SPEECH_PCM_RATE, streamSpeech, toSpeakableText, ttsProvider, type TtsProvider } from '@ai-workforce/llm'
import { getRedisConnection } from '@ai-workforce/queue'

/** A whole clip: PCM (SPEECH_PCM_RATE, base64) and, from Cartesia, when each word is spoken. */
export interface SpokenClip {
  pcm: string
  words?: { words: string[]; start: number[]; end: number[] }
}

/**
 * Fixed lines (greeting, "Mm-hm.", "Sorry, I didn't catch that") are said on every call in the
 * same voice, so their audio is kept in Redis instead of being generated again each time: about
 * 50 KB per second of speech, a handful of lines per agent, expiring after CACHE_DAYS unused.
 * Answers are not cached: they depend on the call so far, the calendar and the time of day.
 */
const CACHE_DAYS = 30
const CACHE_VERSION = 1

type Voice = { voiceId?: string; provider?: TtsProvider }

function cacheKey(text: string, voice: Voice): string {
  const provider = voice.provider ?? ttsProvider()
  const model = provider === 'cartesia' ? `${CARTESIA_TTS_MODEL}@${CARTESIA_VOLUME}` : OPENAI_TTS_MODEL
  const id = createHash('sha256').update([CACHE_VERSION, provider, model, voice.voiceId ?? '', SPEECH_PCM_RATE, text].join('\n')).digest('hex')
  return `voice-tts:${id}`
}

/** Speaks a line in full (no streaming): PCM plus word timings merged across chunks. */
export async function collectSpeech(text: string, voice: Voice): Promise<SpokenClip & { characters: number; model: string }> {
  const stream = streamSpeech(text, { voice: voice.voiceId, provider: voice.provider })
  const audio: Buffer[] = []
  const words: NonNullable<SpokenClip['words']> = { words: [], start: [], end: [] }
  for await (const event of stream.events) {
    if (event.type === 'pcm') audio.push(event.data)
    else { words.words.push(...event.words); words.start.push(...event.start); words.end.push(...event.end) }
  }
  return { pcm: Buffer.concat(audio).toString('base64'), words: words.words.length ? words : undefined, characters: stream.characters, model: stream.model }
}

/** Reserves characters against the monthly voice limit before speech is made (tts-budget.ts). */
export type ReserveSpeech = (characters: number) => Promise<() => Promise<void>>

/**
 * A fixed line's audio, from the cache when it has been said before in this voice.
 * `characters` is 0 for a cache hit (nothing was billed, nothing reserved). Redis being down only
 * skips the cache.
 */
export async function cachedSpeech(text: string, voice: Voice, reserve?: ReserveSpeech): Promise<SpokenClip & { characters: number; cached: boolean }> {
  let key: string | null = null
  try {
    key = cacheKey(text, voice)
    const hit = await getRedisConnection().get(key)
    if (hit) {
      void getRedisConnection().expire(key, CACHE_DAYS * 86_400).catch(() => undefined)
      return { ...(JSON.parse(hit) as SpokenClip), characters: 0, cached: true }
    }
  } catch (error) {
    console.error('Speech cache read failed:', safeErrorMessage(error))
  }
  const giveBack = reserve ? await reserve(toSpeakableText(text).length) : null
  let spoken: Awaited<ReturnType<typeof collectSpeech>>
  try {
    spoken = await collectSpeech(text, voice)
  } catch (error) {
    await giveBack?.()
    throw error
  }
  if (key && spoken.pcm) {
    const clip: SpokenClip = { pcm: spoken.pcm, words: spoken.words }
    void getRedisConnection().set(key, JSON.stringify(clip), 'EX', CACHE_DAYS * 86_400).catch((error: unknown) => console.error('Speech cache write failed:', safeErrorMessage(error)))
  }
  return { pcm: spoken.pcm, words: spoken.words, characters: spoken.characters, cached: false }
}
