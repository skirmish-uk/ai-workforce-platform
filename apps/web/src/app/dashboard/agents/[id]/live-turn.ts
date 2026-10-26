/**
 * The parts of live transcription that are plain logic (docs/VOICE.md, "Live transcription"):
 * turning microphone blocks into the 24 kHz 16-bit audio the transcriber takes, how long a
 * pause ends the caller's turn given what they've said so far, and when a listener would say
 * "mm-hm". Kept apart from the panel so they can be tested without a browser.
 */

/** Live transcription takes 16-bit mono PCM at this rate. */
export const LIVE_RATE = 24_000

/**
 * Converts float samples at the microphone's rate (usually 48 kHz, sometimes 44.1 kHz) to
 * 16-bit samples at `to`, block by block: linear interpolation that carries its position and
 * last sample over, so block edges don't click.
 */
export class Resampler {
  private pos = 0
  private last = 0
  constructor(readonly from: number, readonly to = LIVE_RATE) {}

  process(input: Float32Array): Int16Array {
    const step = this.from / this.to
    const out: number[] = []
    // pos is where the next output sample falls, counted from the sample before this block (-1 = last).
    while (this.pos < input.length) {
      const i = Math.floor(this.pos)
      const frac = this.pos - i
      const a = i - 1 < 0 ? this.last : input[i - 1]
      const b = input[i] ?? a
      const v = a + (b - a) * frac
      out.push(Math.max(-32768, Math.min(32767, Math.round(v * 32767))))
      this.pos += step
    }
    this.pos -= input.length
    if (input.length) this.last = input[input.length - 1]
    return Int16Array.from(out)
  }
}

/** Base64 of 16-bit little-endian PCM, as the transcriber's append event wants it. */
export function pcm16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Words a sentence can't end on: a pause after one is the caller thinking, not finishing. */
const UNFINISHED = new Set(['and', 'but', 'or', 'so', 'because', 'if', 'then', 'the', 'a', 'an', 'to', 'of', 'for', 'with', 'um', 'uh', 'er', 'erm', 'like', 'my', 'our', 'your', 'is', 'are', 'was', 'i', "i'm", 'we', 'about', 'in', 'on', 'at'])

/**
 * How long a pause ends the turn. The usual `base`; longer when what was said stops mid-thought
 * ("…and", "…um", a trailing comma), so a caller gathering their words isn't answered half-way
 * through. Judge it on the finished text of the turn: the live words run ~0.5 s behind the
 * voice, so at a pause they often end mid-phrase only because the last words haven't arrived
 * (that made every turn wait longer, 26 Oct).
 */
export function endSilenceMs(partial: string, base: number, extra = 450): number {
  const text = partial.trim()
  if (!text) return base
  if (/[,;:–-]$/.test(text)) return base + extra
  const lastWord = text.toLowerCase().match(/([\p{L}']+)[^\p{L}']*$/u)?.[1]
  return lastWord && UNFINISHED.has(lastWord) ? base + extra : base
}

export interface BackchannelState {
  /** How long the caller has been talking this turn. */
  speakingMs: number
  /** Since the last backchannel in this turn (or since the turn started). */
  sinceLastMs: number
  /** Words heard since then. */
  wordsSince: number
  /** The current pause. */
  pauseMs: number
  /** What has been heard so far this turn. */
  partial: string
}

/** A pause this long mid-turn is where a listener says "mm-hm" (the turn itself ends at ~650 ms). */
export const BACKCHANNEL_PAUSE_MS = 350

/** A sentence that asks for something: it wants an answer, not a nod. */
const ASKING = /^(what|how|why|when|where|which|who|can|could|would|will|do|does|did|is|are|should)\b|\b(can you|could you|would you|do you|tell me|i wanted to ask|wanted to ask|i want to know|wondering|suggest|recommend|let me know)\b/i

/** Whether the sentence being said (the text since the last full stop) is a question or a request. */
export function asking(partial: string): boolean {
  const text = partial.trim()
  if (/\?$/.test(text)) return true
  const sentence = text.split(/[.!?]\s+/).pop()?.replace(/^(so|and|but|ok|okay|well|um|uh|yeah)[, ]+/i, '').trim() ?? ''
  return ASKING.test(sentence)
}

/**
 * Whether to say a quiet "mm-hm" now: the caller has been talking a while (a long explanation,
 * not a quick question), has paused, and isn't asking something (that wants an answer, not a
 * nod). At most one every few seconds, so it encourages rather than interrupts.
 */
export function shouldBackchannel(s: BackchannelState): boolean {
  if (s.pauseMs < BACKCHANNEL_PAUSE_MS) return false
  if (s.speakingMs < 3000 || s.sinceLastMs < 4500 || s.wordsSince < 8) return false
  return !asking(s.partial)
}

/**
 * A pause this long sends what has been said so far to be finished off by the transcriber,
 * before the turn has ended (END_SILENCE_MS): usually its text is back by the time the turn ends,
 * instead of being asked for only then. If the caller carries on, their next words are a new part.
 */
export const EARLY_COMMIT_MS = 400

/**
 * The transcript without our own backchannel picked up by the microphone ("Mm-hm."), when one
 * was played this turn. Only the sounds people rarely say mid-question are taken out.
 */
export function withoutBackchannels(text: string, played: boolean): string {
  if (!played) return text
  return text.replace(/(^|[\s,.!?])(mm+-?hm+|uh-?huh)[.,!?]?(?=\s|$)/gi, '$1').replace(/\s{2,}/g, ' ').trim()
}

export const wordCount = (text: string) => (text.match(/[\p{L}\p{N}']+/gu) ?? []).length
