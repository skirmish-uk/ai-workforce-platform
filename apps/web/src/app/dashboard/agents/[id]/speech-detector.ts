/**
 * Tells a voice from other sounds on the microphone, so that only someone speaking (not a
 * container being opened, cutlery, a bag rustling) can interrupt the agent or start a turn.
 *
 * Silero VAD v5 (MIT, github.com/snakers4/silero-vad; public/vad/silero_vad.onnx, sha256
 * 1a153a22…788e3), run in the browser with ONNX Runtime's WebAssembly build (public/vad/, copied
 * from node_modules by scripts/copy-vad-runtime.mjs and loaded at run time, outside the bundle).
 * It gives a speech probability for every 32 ms of 16 kHz audio.
 *
 * Measured offline on 21 Oct (docs/VOICE.md): over about 3 minutes of real kitchen recordings
 * (plastic bag, plastic wrapping, cutlery, a pot and lid, cooking, tidying up) no 32 ms frame of
 * noise went above 0.5 and "0.7 or more for 3 frames in a row" never fired; real speech reached
 * it 128 ms (median) after it started, at worst 256 ms, and also through loud kitchen noise. A
 * hand-made pitch check fired 9–18 times a minute on the same recordings, so it was dropped.
 */
const BASE = '/vad/'
const SAMPLE_RATE = 16_000
const FRAME = 512
const CONTEXT = 64
const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000
/** Speech probability that counts, and how many frames in a row (about 0.1 s). */
const THRESHOLD = 0.7
const MIN_FRAMES = 3
/** Frames below this, in a row, count as "no speech" (about 0.13 s). */
const QUIET_THRESHOLD = 0.3
const QUIET_FRAMES = 4
/** A detection older than this no longer counts as "now". */
const FRESH_MS = 250

interface OrtTensor { data: ArrayLike<number> }
interface OrtModule {
  env: { wasm: { wasmPaths: string; numThreads: number } }
  Tensor: new (type: string, data: Float32Array | BigInt64Array, dims: number[]) => OrtTensor
  InferenceSession: { create(url: string, options: object): Promise<{ run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>> }> }
}
type Session = Awaited<ReturnType<OrtModule['InferenceSession']['create']>>

let loading: Promise<{ ort: OrtModule; session: Session } | null> | null = null

/** Loads the runtime and model once per page (about 3 MB compressed, then cached). Null if the browser can't. */
export function loadSpeechModel() {
  loading ??= (async () => {
    try {
      const url = `${BASE}ort.wasm.min.mjs`
      const ort = (await import(/* webpackIgnore: true */ url)) as OrtModule
      ort.env.wasm.wasmPaths = BASE
      ort.env.wasm.numThreads = 1 // threads need cross-origin isolation; one is plenty for this model
      const session = await ort.InferenceSession.create(`${BASE}silero_vad.onnx`, { executionProviders: ['wasm'] })
      return { ort, session }
    } catch (error) {
      console.warn('Voice detector unavailable; interruptions fall back to loudness only.', error)
      return null
    }
  })()
  return loading
}

export class SpeechDetector {
  private state: OrtTensor
  private readonly sr: OrtTensor
  private context = new Float32Array(CONTEXT)
  // Downsampling to 16 kHz by averaging (also a low-pass, so nothing above 8 kHz folds back).
  private acc = 0
  private count = 0
  private pos = 0
  private frame = new Float32Array(FRAME)
  private filled = 0
  private energy = 0
  private queue: Array<{ samples: Float32Array; endAt: number; rms: number }> = []
  private busy = false
  /** Bumped by reset(), so a frame still being run when it happens doesn't bring the old memory back. */
  private generation = 0
  /** Recent frames: when each ended (performance.now()), its speech probability and its level. */
  private history: Array<{ endAt: number; p: number; rms: number }> = []

  private constructor(private readonly ort: OrtModule, private readonly session: Session) {
    this.state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
    this.sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [])
  }

  static async create(): Promise<SpeechDetector | null> {
    const loaded = await loadSpeechModel()
    return loaded ? new SpeechDetector(loaded.ort, loaded.session) : null
  }

  /** Microphone samples as they are captured (any sample rate). */
  push(samples: Float32Array, rate: number) {
    const step = rate / SAMPLE_RATE
    const now = performance.now()
    for (let i = 0; i < samples.length; i++) {
      this.acc += samples[i]
      this.count++
      if (++this.pos < step) continue
      this.pos -= step
      const sample = this.acc / this.count
      this.frame[this.filled++] = sample
      this.energy += sample * sample
      this.acc = 0
      this.count = 0
      if (this.filled === FRAME) {
        // When this frame's last sample was captured, roughly: the block arrived just now.
        this.queue.push({ samples: this.frame, endAt: now - ((samples.length - 1 - i) / rate) * 1000, rms: Math.sqrt(this.energy / FRAME) })
        this.frame = new Float32Array(FRAME)
        this.filled = 0
        this.energy = 0
      }
    }
    void this.drain()
  }

  private async drain() {
    if (this.busy) return
    this.busy = true
    try {
      while (this.queue.length) {
        // Fallen behind (a busy tab): only the latest audio matters.
        if (this.queue.length > 8) this.queue.splice(0, this.queue.length - 8)
        const { samples, endAt, rms } = this.queue.shift()!
        const input = new Float32Array(CONTEXT + FRAME)
        input.set(this.context, 0)
        input.set(samples, CONTEXT)
        this.context = samples.slice(FRAME - CONTEXT)
        const generation = this.generation
        const out = await this.session.run({ input: new this.ort.Tensor('float32', input, [1, CONTEXT + FRAME]), state: this.state, sr: this.sr })
        if (generation !== this.generation) continue
        this.state = out.stateN
        this.history.push({ endAt, p: Number(out.output.data[0]), rms })
        if (this.history.length > 40) this.history.shift()
      }
    } catch (error) {
      console.warn('Voice detector failed on a frame', error)
    } finally {
      this.busy = false
    }
  }

  /**
   * Someone is speaking now: the last MIN_FRAMES frames (all captured after `since`, a
   * performance.now() time) were speech (THRESHOLD or above) and at least `minLevel` loud.
   *
   * Both on the same audio, because the model hears the agent's own voice in the microphone as
   * speech however quiet it is (its echo, even turned down to a tenth, scored 0.99), and a noise
   * is loud without being speech: neither alone passes, only the caller's voice is both. In a
   * test with the agent's output fed back at 25% and no echo cancellation, checking them
   * separately let a clatter over the echo stop the agent.
   */
  voice(since = 0, minLevel = 0): boolean {
    const recent = this.history.slice(-MIN_FRAMES)
    if (recent.length < MIN_FRAMES || performance.now() - recent[recent.length - 1].endAt > FRESH_MS) return false
    return recent.every((f) => f.p >= THRESHOLD && f.rms >= minLevel && f.endAt - FRAME_MS >= since)
  }

  /** Probably speech in the last ~0.1 s (any recent frame at 0.5 or more), however loud. */
  speechLately(): boolean {
    const recent = this.history.slice(-MIN_FRAMES)
    return recent.length > 0 && performance.now() - recent[recent.length - 1].endAt <= FRESH_MS && recent.some((f) => f.p >= 0.5)
  }

  /**
   * No speech at all lately: the last QUIET_FRAMES frames, all captured after `since`, were
   * below QUIET_THRESHOLD. Lets the agent carry on promptly after a noise.
   */
  noVoice(since: number): boolean {
    const recent = this.history.slice(-QUIET_FRAMES)
    if (recent.length < QUIET_FRAMES || performance.now() - recent[recent.length - 1].endAt > FRESH_MS) return false
    return recent.every((f) => f.p < QUIET_THRESHOLD && f.endAt - FRAME_MS >= since)
  }

  /**
   * Forgets what it has heard (the model's memory included), e.g. when the agent pauses: its own
   * voice just before would otherwise carry into the next frames as "speech".
   */
  reset() {
    this.generation++
    this.state = new this.ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
    this.context = new Float32Array(CONTEXT)
    this.history = []
    this.queue = []
  }

  /** The newest frame's speech probability (for diagnostics). */
  get probability(): number {
    return this.history[this.history.length - 1]?.p ?? 0
  }
}
