import { LIVE_RATE, Resampler, pcm16ToBase64 } from './live-turn'

/**
 * Live transcription for a voice call (docs/VOICE.md, "Live transcription"): the caller's audio
 * goes to OpenAI's realtime transcription while they speak, and their words come back as they
 * say them. One connection per call, opened with a short-lived key from
 * POST /api/agents/[id]/voice/live. The page decides when a turn starts and ends (its own voice
 * detection): begin() at the start, push() each block of microphone audio, commit() at the end
 * for the whole turn's text. Audio is only sent during a turn, which is what is billed.
 */
export class LiveTranscriber {
  /** What has been heard so far this turn, as it arrives. */
  onPartial: ((text: string) => void) | null = null
  private ws: WebSocket
  private resampler: Resampler | null = null
  private pending: Int16Array[] = []
  private pendingSamples = 0
  /** 24 kHz samples sent this turn (what's billed, and whether there's anything to commit). */
  private sentSamples = 0
  private partial = ''
  /** The turn's item at OpenAI, known from its first words (or the commit). */
  private item: string | null = null
  /** Items already committed: their late words belong to a turn that has finished. */
  private committed = new Set<string>()
  private finals = new Map<string, string>()
  /** A commit was sent and not yet acknowledged: new words of unknown turn may still be the old turn's. */
  private acking = false
  private waiting = new Map<string, (text: string) => void>()
  /** Commits waiting for OpenAI to acknowledge them, oldest first (it acknowledges in order). */
  private acks: Array<(item: string | null) => void> = []

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.onmessage = (e) => this.handle(JSON.parse(String(e.data)))
  }

  /** Opens live transcription for this agent's call, or null when it's off or unavailable (turns are then uploaded). */
  static async connect(agentId: string, timeoutMs = 5000): Promise<LiveTranscriber | null> {
    try {
      const res = await fetch(`/api/agents/${agentId}/voice/live`, { method: 'POST' })
      if (!res.ok) return null
      const session = (await res.json()) as { key: string; url: string }
      const ws = new WebSocket(session.url, ['realtime', `openai-insecure-api-key.${session.key}`])
      const live = new LiveTranscriber(ws)
      const ready = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs)
        ws.onopen = () => { clearTimeout(timer); resolve(true) }
        ws.onerror = () => { clearTimeout(timer); resolve(false) }
      })
      if (!ready) { ws.close(); return null }
      ws.onclose = () => live.fail()
      return live
    } catch {
      return null
    }
  }

  get ready(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }

  /** A new turn: forget the last one's words and start counting audio afresh. */
  begin(): void {
    this.resetTurn()
    this.resampler = null
  }

  private resetTurn(): void {
    this.partial = ''
    this.item = null
    this.sentSamples = 0
    this.pending = []
    this.pendingSamples = 0
  }

  /** One block of microphone audio (float samples at `rate`), sent about every 100 ms. */
  push(block: Float32Array, rate: number): void {
    if (!this.ready) return
    if (!this.resampler || this.resampler.from !== rate) this.resampler = new Resampler(rate, LIVE_RATE)
    const samples = this.resampler.process(block)
    this.pending.push(samples)
    this.pendingSamples += samples.length
    if (this.pendingSamples >= LIVE_RATE / 10) this.flush()
  }

  private flush(): void {
    if (!this.pendingSamples || !this.ready) return
    const joined = new Int16Array(this.pendingSamples)
    let at = 0
    for (const p of this.pending) { joined.set(p, at); at += p.length }
    this.pending = []
    this.pendingSamples = 0
    this.sentSamples += joined.length
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm16ToBase64(joined) }))
  }

  /**
   * Ends this part of the turn and waits for its text. Null if it didn't come in time or the
   * connection failed (the page then uploads the recording instead); "" when nothing was sent.
   * Audio pushed after it starts the next part, so a turn can be committed in pieces (the page
   * commits at a pause, before it knows the caller has finished).
   */
  async commit(timeoutMs = 2500): Promise<{ text: string; seconds: number } | null> {
    this.flush()
    const seconds = this.sentSamples / LIVE_RATE
    // Under 0.1 s of audio can't be committed (and isn't a turn).
    if (this.sentSamples < LIVE_RATE / 10) { this.resetTurn(); return { text: '', seconds: 0 } }
    if (!this.ready) return null
    // From here the next turn may start while this one's text is still coming: its words, and
    // words of a turn not yet identified before the commit is acknowledged, aren't the new turn's.
    if (this.item) this.committed.add(this.item)
    this.acking = true
    const done = new Promise<string | null>((resolve) => {
      let settled = false
      const settle = (text: string | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(text) } }
      // Timed out: stays in the queue (its acknowledgement may still come) but resolves nothing.
      const timer = setTimeout(() => settle(null), timeoutMs)
      this.acks.push((item) => {
        if (!item) return settle(null)
        const final = this.finals.get(item)
        if (final !== undefined) { this.finals.delete(item); return settle(final) }
        this.waiting.set(item, settle)
      })
    })
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
    this.resetTurn()
    const text = await done
    return text === null ? null : { text, seconds }
  }

  /** Drops the turn's audio without transcribing it (a cough, or muted part-way). */
  discard(): void {
    if (this.ready && this.sentSamples) this.ws.send(JSON.stringify({ type: 'input_audio_buffer.clear' }))
    this.begin()
  }

  close(): void {
    this.ws.onclose = null
    this.ws.close()
    this.fail()
  }

  private fail(): void {
    for (const ack of this.acks.splice(0)) ack(null)
    for (const resolve of this.waiting.values()) resolve('')
    this.waiting.clear()
  }

  private handle(m: { type: string; item_id?: string; delta?: string; transcript?: string; error?: { code?: string; message?: string } }): void {
    switch (m.type) {
      case 'conversation.item.input_audio_transcription.delta': {
        if (!m.item_id || this.committed.has(m.item_id)) return
        if (!this.item && this.acking) return
        this.item ??= m.item_id
        if (m.item_id !== this.item) return
        this.partial += m.delta ?? ''
        this.onPartial?.(this.partial.trim())
        return
      }
      case 'input_audio_buffer.committed':
        if (m.item_id) this.committed.add(m.item_id)
        this.acking = this.acks.length > 1
        this.acks.shift()?.(m.item_id ?? null)
        return
      case 'conversation.item.input_audio_transcription.completed':
      case 'conversation.item.input_audio_transcription.failed': {
        if (!m.item_id) return
        // Failed comes back empty: the page uploads the recording instead.
        const text = m.type.endsWith('completed') ? (m.transcript ?? '').trim() : ''
        const resolve = this.waiting.get(m.item_id)
        if (resolve) { this.waiting.delete(m.item_id); resolve(text) } else this.finals.set(m.item_id, text)
        return
      }
      case 'error':
        // A commit refused (e.g. the buffer was too short): that part falls back to uploading.
        // Other errors leave the queue alone; a commit they affect times out instead.
        if (!/commit|buffer/i.test(`${m.error?.code ?? ''} ${m.error?.message ?? ''}`)) return
        this.acking = this.acks.length > 1
        this.acks.shift()?.(null)
        return
    }
  }
}
