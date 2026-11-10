// Audio helpers shared by the voice call and the transcriber comparison.

/** Sample rate sent for transcription: plenty for speech, a third of a 48 kHz upload. */
export const WAV_RATE = 16_000
/** Quiet microphones are raised to a normal level, by at most this much (more only lifts noise). */
const MAX_BOOST = 8

/**
 * One turn as 16-bit mono WAV at WAV_RATE: trailing silence trimmed, resampled (block average),
 * and a quiet microphone brought up to a normal level.
 */
export function encodeWav(blocks: Float32Array[], rate: number, trimEndMs: number): Blob {
  const total = blocks.reduce((n, b) => n + b.length, 0)
  const all = new Float32Array(total)
  let offset = 0
  for (const b of blocks) { all.set(b, offset); offset += b.length }
  const keep = Math.max(0, total - Math.floor((trimEndMs / 1000) * rate))
  const ratio = rate / WAV_RATE
  const out = new Float32Array(Math.floor(keep / ratio))
  let peak = 0
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * ratio)
    const to = Math.min(keep, Math.max(from + 1, Math.floor((i + 1) * ratio)))
    let sum = 0
    for (let j = from; j < to; j++) sum += all[j]
    out[i] = sum / (to - from)
    peak = Math.max(peak, Math.abs(out[i]))
  }
  const gain = peak > 0 ? Math.min(MAX_BOOST, 0.9 / peak) : 1
  const view = new DataView(new ArrayBuffer(44 + out.length * 2))
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)) }
  text(0, 'RIFF'); view.setUint32(4, 36 + out.length * 2, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, WAV_RATE, true); view.setUint32(28, WAV_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, out.length * 2, true)
  for (let i = 0; i < out.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, out[i] * gain)) * 0x7fff, true)
  return new Blob([view.buffer], { type: 'audio/wav' })
}

/** Any recording the browser can play (WebM/Opus, MP4…) as the same 16 kHz WAV a call sends. */
export async function toWav(recording: Blob): Promise<Blob> {
  if (recording.type === 'audio/wav') return recording
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new AC()
  try {
    const decoded = await ctx.decodeAudioData(await recording.arrayBuffer())
    return encodeWav([decoded.getChannelData(0)], decoded.sampleRate, 0)
  } finally {
    void ctx.close()
  }
}
