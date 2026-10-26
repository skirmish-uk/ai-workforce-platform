'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, Mic, MicOff, PhoneCall, PhoneOff, Play, Volume2 } from 'lucide-react'
import { WAV_RATE, encodeWav } from './voice-audio'
import { SpeechDetector, loadSpeechModel } from './speech-detector'
import { ComparisonResults, TranscriberCompare, compareRecording, type Comparison } from './TranscriberCompare'
import { LiveTranscriber } from './live-transcriber'
import { DRAFT_PAUSE_MS, EARLY_COMMIT_MS, WORDS_CAUGHT_UP_MS, endSilenceMs, endsSentence, sameWords, shouldBackchannel, withoutBackchannels, wordCount } from './live-turn'

interface Turn {
  /** Agent turns: which answer incoming sentences belong to (and its audio, for "Play again"). */
  id?: number
  who: 'you' | 'agent'
  text: string
  /** Words of `text` said so far, while the agent is saying it (undefined: all of it). */
  shown?: number
  /** Stopped part-way (talked over, or the call ended): the words after `shown` were never said. */
  cut?: boolean
  runId?: string | null
  status?: string
  /** Your own recording, kept in this tab only so you can hear what was sent. */
  recordingUrl?: string
  note?: string
  /** Your recording through every configured transcriber ("Compare transcribers"). */
  comparison?: Comparison[]
  comparing?: boolean
}

/** Word timings from the text-to-speech service: seconds from the start of the sentence. */
interface WordTimes { words: string[]; start: number[]; end: number[] }
/** A whole clip of speech: 16-bit PCM (base64) at the response's `rate`. */
interface SpokenClip { pcm: string; words?: WordTimes }

interface VoiceResponse {
  transcript?: string
  confidence?: number | null
  reply?: string
  greeting?: string
  status?: string
  runId?: string | null
  rate?: number
  speech?: SpokenClip | null
  ttsError?: string
  error?: string
}

/**
 * One sentence of an answer being said, for typing its words out in step with the voice.
 * `start`/`end` are AudioContext times of its scheduled audio.
 */
interface Span {
  /** Index of its first word in the turn's text. */
  from: number
  count: number
  chars: number
  /** Where each word starts as a share of the sentence, by length (when there are no timings). */
  share: number[]
  /** When each word is spoken, from the service (seconds into the sentence). */
  times: number[]
  start: number | null
  end: number
  complete: boolean
}

const splitWords = (text: string) => text.split(/\s+/).filter(Boolean)

/** Each word's starting point as a share of the sentence: by characters, with a pause after punctuation. */
function wordShares(words: string[]): number[] {
  const weights = words.map((w) => w.length + 1 + (/[,;:]$/.test(w) ? 3 : /[.!?…]$/.test(w) ? 5 : 0))
  const total = weights.reduce((a, b) => a + b, 0) || 1
  let at = 0
  return weights.map((w) => { const share = at / total; at += w; return share })
}

/** Speech is roughly this many characters a second, to pace words while a sentence's length isn't known yet. */
const CHARS_PER_SECOND = 15
/** Buffer before the first chunk of a sentence plays, so chunks arriving a little late don't leave gaps. */
const PLAYBACK_LEAD_S = 0.06

function pcmToBuffer(context: AudioContext, base64: string, rate: number): AudioBuffer | null {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const samples = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2))
  if (!samples.length) return null
  const buffer = context.createBuffer(1, samples.length, rate)
  const channel = buffer.getChannelData(0)
  for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768
  return buffer
}

/**
 * idle      no call
 * starting  connecting and playing the greeting
 * listening call open, waiting for the caller to speak
 * hearing   the caller is speaking (recording)
 * thinking  the agent is working on its answer
 * speaking  the agent is talking; speaking over it interrupts
 */
type Phase = 'idle' | 'starting' | 'listening' | 'hearing' | 'thinking' | 'speaking'

const MIC_STORAGE_KEY = 'voice-mic-device'
const VOLUME_STORAGE_KEY = 'voice-volume'
/** Agent voice level: a compressor evens it out, then this gain (1 = as generated). */
const DEFAULT_VOLUME = 1.6

// Voice activity detection (tuned by ear in a quiet office with a laptop mic and with a headset).
const TICK_MS = 50
/** Consecutive loud ticks before speech counts (150 ms). */
const START_TICKS = 3
/**
 * Interrupting the agent: after HOLD_TICKS loud ticks it pauses mid-word (held, not muted, so
 * nothing is lost) and the page listens with no echo of it in the microphone. A voice (loud from
 * HOLD_COUNT_FROM_TICKS, and speech to the detector) stops it: the caller is interrupting. A
 * noise lets it carry on from where it paused, as soon as the detector has heard a few frames of
 * no speech (about a quarter of a second), at most after HOLD_MAX_TICKS.
 *
 * Pausing, not turning it down: the detector hears the agent's own voice as speech however
 * quiet (at a tenth it still scored 0.99), and that carried into the frames of a pot clattering
 * over it, which then passed as the caller.
 */
const HOLD_TICKS = 2
/**
 * Paused, the end of the agent's voice still reaches the microphone for a moment (speaker delay,
 * the room's reverb): the detector starts afresh after HOLD_RESET_TICKS (its memory of that last
 * bit of speech otherwise carried into a clatter and let it through), and loudness counts from
 * HOLD_COUNT_FROM_TICKS. Waiting 150 ms for both, then asking for two loud ticks, decided only
 * ~0.4 s into the caller's words: a short "hang on" was over by then and had to be said again.
 */
const HOLD_RESET_TICKS = 1
const HOLD_COUNT_FROM_TICKS = 2
const CONFIRM_TICKS = 1
const HOLD_MAX_TICKS = 9
/**
 * After a pause that wasn't the caller, no new pause for this long: on laptop speakers the
 * agent's own echo set off pause after pause (hundreds in one answer, heard as the voice cutting
 * in and out) before the echo estimate caught up.
 */
const HOLD_COOLDOWN_MS = 1000
/**
 * After a pause for a noise: long enough that a long clatter doesn't stop and start the agent
 * several times a second, short enough not to miss the caller speaking just after it (1 s did).
 */
const NOISE_COOLDOWN_MS = 300
/** A pause set off by the agent's own echo raises the echo estimate this much past what set it off. */
const ECHO_MARGIN = 1.3
/** Per tick: an echo estimate nothing has topped up halves in about 1.7 s (a headset soon reaches ~0). */
const ECHO_DECAY = 0.98
/** Quietest level counted as speech: low for quiet laptop and webcam mics (speech measured at 0.01–0.03 RMS). */
const MIN_SPEECH_LEVEL = 0.006
/** Silence that ends the caller's turn. */
const END_SILENCE_MS = 650
/**
 * No answer audio this long after the caller stops: say a short acknowledgement. Not on two
 * turns in a row: with answers starting ~2 s after the caller stops, an "Mm-hm." before every
 * one sounded mechanical.
 */
const FILLER_AFTER_MS = 1000
/** After the agent's goodbye has finished playing, the call ends this much later (unless the caller speaks). */
const END_CALL_AFTER_MS = 1000
const MIN_UTTERANCE_MS = 500
const MAX_UTTERANCE_MS = 30_000
/** Audio kept from just before speech was detected, so a turn's first syllable isn't cut off. */
const PRE_ROLL_MS = 600
/**
 * An interruption keeps the audio from just before the caller was first heard over the agent
 * (it is confirmed a moment later), up to this much. Not more: before that it is only the
 * agent's own echo, which got transcribed into the caller's words.
 */
const BARGE_IN_PRE_ROLL_MS = 1500
const BARGE_IN_LEAD_MS = 300
/** Silence left on the end of a turn; the rest of the END_SILENCE_MS wait is trimmed off. */
const TAIL_MS = 250
/**
 * How much of the agent's voice the microphone picks up, as a share of what is played, before
 * anything is learned on this call: cautious, so the agent's own voice from laptop speakers
 * doesn't interrupt it. Learned while the agent talks; with a headset it falls close to 0.
 */
const INITIAL_ECHO_COUPLING = 0.3
/** Mic level over the expected echo that might be the caller (turns the agent down to check). */
const SUSPECT_OVER_ECHO = 1.3
/** Mic level over the expected echo that counts as the caller talking. */
const SPEECH_OVER_ECHO = 3

/**
 * Copies the microphone's samples to the page in blocks, so a turn can include the moments
 * before speech was detected (MediaRecorder only starts when asked) and be sent as clean WAV.
 */
const CAPTURE_WORKLET = `
class VoiceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.block = new Float32Array(2048); this.n = 0 }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) for (let i = 0; i < channel.length; i++) {
      this.block[this.n++] = channel[i]
      if (this.n === this.block.length) { this.port.postMessage(this.block.slice(0)); this.n = 0 }
    }
    return true
  }
}
registerProcessor('voice-capture', VoiceCapture)
`


/** RMS level of what an analyser is hearing (0 when there is none). */
function levelOf(analyser: AnalyserNode | null): number {
  if (!analyser) return 0
  const buf = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  return Math.sqrt(sum / buf.length)
}

/** Picks a recording format the browser supports and the transcription API accepts. */
function recorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return undefined
}

/**
 * A voice call with an agent. Once the call starts the microphone stays open: the page notices
 * when you start and stop talking, sends what you said, and plays the answer. Talking while the
 * agent is speaking interrupts it. Each turn is a normal agent run that also gets the
 * conversation so far.
 */
export function VoicePanel({ agentId, agentName, onShowRun, onTurnDone }: { agentId: string; agentName: string; onShowRun?: (runId: string) => void; onTurnDone?: () => void }) {
  const first = agentName.split(/\s+[-–]\s+|\s+/)[0]
  const [turns, setTurns] = useState<Turn[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [inCall, setInCall] = useState(false)
  /** When the call connected, for the call timer; and the seconds since, updated each second. */
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null)
  const [callSeconds, setCallSeconds] = useState(0)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [micId, setMicId] = useState<string>('')
  const [volume, setVolume] = useState(DEFAULT_VOLUME)
  const volumeRef = useRef(DEFAULT_VOLUME)
  const playerInput = useRef<AudioNode | null>(null)
  const playerGain = useRef<GainNode | null>(null)

  const canvas = useRef<HTMLCanvasElement | null>(null)
  const panel = useRef<HTMLElement | null>(null)
  const ctx = useRef<AudioContext | null>(null)
  /** The agent's voice, for the waveform while it speaks. */
  const playerAnalyser = useRef<AnalyserNode | null>(null)
  /** The caller's microphone: voice detection and the waveform while listening. */
  const micAnalyser = useRef<AnalyserNode | null>(null)
  /** Voice or noise? (speech-detector.ts). Null until loaded, or if this browser can't run it. */
  const detector = useRef<SpeechDetector | null>(null)
  const stream = useRef<MediaStream | null>(null)
  /** Fallback when the browser has no AudioWorklet: records from the moment speech is detected. */
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  /** Sample capture (CAPTURE_WORKLET): the last PRE_ROLL_MS always, and the turn while one is being recorded. */
  const capture = useRef<{ node: AudioWorkletNode; rate: number } | null>(null)
  const workletLoaded = useRef(false)
  /** The turn being recorded started by talking over the agent (the server checks it isn't the agent's own echo). */
  const interruptedTurn = useRef(false)
  const preRoll = useRef<Float32Array[]>([])
  const captured = useRef<Float32Array[] | null>(null)
  const player = useRef<HTMLAudioElement | null>(null)
  const vadTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const recordingUrls = useRef<string[]>([])
  // Mirrors for the detection loop, which runs outside React renders.
  const phaseRef = useRef<Phase>('idle')
  const inCallRef = useRef(false)
  const mutedRef = useRef(false)
  const turnsRef = useRef<Turn[]>([])
  /** Groups this call's turns into one conversation in the agent's history; a cleared conversation starts a new one. */
  const conversationId = useRef<string>(crypto.randomUUID())
  /** Live transcription for this call (live-transcriber.ts); null: each turn is uploaded as a recording. */
  const liveStt = useRef<LiveTranscriber | null>(null)
  const liveConnecting = useRef(false)
  /** What the caller has said so far this turn: times the backchannels and drafts; not shown (it distracted from talking). */
  const partialRef = useRef('')
  /** When the live words last changed. */
  const partialAt = useRef(0)
  /** After the caller stops: called with each update of their words until the turn is sent. */
  const wordsAfterTurn = useRef<((text: string) => void) | null>(null)
  /**
   * The answer being drafted to the words so far, started at the caller's last pause (docs/VOICE.md,
   * "Answering while the caller speaks"). Played if those words turn out to be the whole turn;
   * dropped as soon as the caller says anything more.
   */
  const draft = useRef<{ id: string; text: string; seconds: number; response: Promise<Response | null>; abort: AbortController } | null>(null)
  /** "Mm-hm."/"Yeah." in the agent's voice, said quietly while the caller talks at length. */
  const backchannels = useRef<AudioBuffer[]>([])
  /** Live turns sent so far; one superseded while its text was coming hands its words to the next. */
  const liveTurnSeq = useRef(0)
  const carryOver = useRef('')
  /**
   * This turn's parts: committed at each pause of EARLY_COMMIT_MS, so the text is usually back
   * by the time the turn ends. After a commit the (quiet) audio is held back, and sent on only if
   * the caller speaks again; the words of earlier parts stay on screen in front of the new ones.
   */
  const liveParts = useRef<Array<Promise<{ text: string; seconds: number } | null>>>([])
  const liveHeld = useRef(false)
  const liveStash = useRef<Float32Array[]>([])
  const backchannel = useRef({ lastAt: 0, wordsAt: 0, playedThisTurn: false, pauseFired: false, until: 0, last: -1 })
  const vad = useRef({ floor: 0.01, loudTicks: 0, silenceMs: 0, startedAt: 0, peak: 0, echoCoupling: INITIAL_ECHO_COUPLING, playerLevel: 0, held: false, holdTicks: 0, suspectAt: 0, played: [] as number[], suspectRatio: 0, voiceHeard: false, heldAt: 0, holdAgainAt: 0, suspectSpeech: false })

  const setPhaseBoth = (p: Phase) => { phaseRef.current = p; setPhase(p) }
  useEffect(() => { turnsRef.current = turns }, [turns])
  useEffect(() => { mutedRef.current = muted }, [muted])

  // ---- microphone list (labels only appear after permission is granted once)
  const loadMics = useCallback(async () => {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
      setMics(devices)
      let saved = ''
      try { saved = localStorage.getItem(MIC_STORAGE_KEY) ?? '' } catch { /* storage unavailable */ }
      setMicId((current) => current || (devices.some((d) => d.deviceId === saved) ? saved : ''))
    } catch { /* enumerateDevices unavailable */ }
  }, [])
  useEffect(() => { if (typeof navigator !== 'undefined' && navigator.mediaDevices) void loadMics() }, [loadMics])

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(VOLUME_STORAGE_KEY))
      if (saved >= 0.5 && saved <= 3) { setVolume(saved); volumeRef.current = saved }
    } catch { /* storage unavailable */ }
  }, [])
  const changeVolume = (v: number) => {
    setVolume(v)
    volumeRef.current = v
    if (playerGain.current) playerGain.current.gain.value = v
    try { localStorage.setItem(VOLUME_STORAGE_KEY, String(v)) } catch { /* storage unavailable */ }
  }

  const chooseMic = (id: string) => {
    setMicId(id)
    try { localStorage.setItem(MIC_STORAGE_KEY, id) } catch { /* storage unavailable */ }
  }

  const audioContext = () => {
    if (!ctx.current) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      ctx.current = new AC()
      playerAnalyser.current = ctx.current.createAnalyser()
      playerAnalyser.current.fftSize = 1024
      playerAnalyser.current.smoothingTimeConstant = 0.75
      playerAnalyser.current.connect(ctx.current.destination)
      // Agent voice: compressor (lifts quiet syllables, stops peaks clipping) then volume.
      const compressor = ctx.current.createDynamicsCompressor()
      compressor.threshold.value = -28
      compressor.knee.value = 24
      compressor.ratio.value = 4
      compressor.attack.value = 0.003
      compressor.release.value = 0.25
      playerGain.current = ctx.current.createGain()
      playerGain.current.gain.value = volumeRef.current
      compressor.connect(playerGain.current)
      playerGain.current.connect(playerAnalyser.current)
      playerInput.current = compressor
    }
    void ctx.current.resume()
    return ctx.current
  }

  useEffect(() => {
    if (!inCall || callStartedAt === null) return
    const timer = setInterval(() => setCallSeconds(Math.floor((Date.now() - callStartedAt) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [inCall, callStartedAt])

  // ---- the orb: a circle that swells and ripples with the caller's mic while listening/hearing
  // and with the agent's voice while speaking, breathes while thinking, rests when idle.
  useEffect(() => {
    let frame = 0
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const data = new Uint8Array(512)
    /** Smoothed overall level and four bands (low → high), so the orb moves fluidly, not per frame. */
    const smooth = { level: 0, bands: [0, 0, 0, 0] }
    const draw = (t: number) => {
      frame = requestAnimationFrame(draw)
      revealRef.current()
      const c = canvas.current
      if (!c) return
      const dpr = window.devicePixelRatio || 1
      const w = c.clientWidth, h = c.clientHeight
      if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr }
      const g = c.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)
      const style = getComputedStyle(c)
      const agentTalking = isPlaying()
      const p = agentTalking ? 'speaking' : phaseRef.current
      const you = p === 'hearing' || p === 'listening'
      const source = p === 'speaking' ? playerAnalyser.current : you ? micAnalyser.current : null
      let level = 0
      let bands = [0, 0, 0, 0]
      if (source && !(you && mutedRef.current)) {
        source.getByteFrequencyData(data)
        // Speech sits in the lower part of the spectrum; four bands across it.
        const usable = Math.floor(data.length * 0.4)
        bands = bands.map((_, b) => {
          let sum = 0
          const from = Math.floor((b / 4) * usable), to = Math.floor(((b + 1) / 4) * usable)
          for (let i = from; i < to; i++) sum += data[i]
          return sum / Math.max(1, to - from) / 255
        })
        level = Math.min(1, (bands[0] * 0.4 + bands[1] * 0.3 + bands[2] * 0.2 + bands[3] * 0.1) * 1.8)
        if (p === 'listening') level *= 0.6
      }
      // Rise quickly, fall gently.
      smooth.level += (level - smooth.level) * (level > smooth.level ? 0.35 : 0.12)
      smooth.bands = smooth.bands.map((v, i) => v + (bands[i] - v) * 0.2)
      const thinking = p === 'thinking' || p === 'starting'
      const breath = reduceMotion ? 0 : thinking ? 0.06 * (0.5 + 0.5 * Math.sin(t / 380)) : 0.015 * Math.sin(t / 1400)
      const size = Math.min(w, h)
      const base = size * 0.3
      const r = base * (1 + breath + (reduceMotion ? 0.1 : 0.32) * smooth.level)
      const cx = w / 2, cy = h / 2
      // A soft edge that ripples with the voice: a few slow waves around the rim.
      g.beginPath()
      const steps = 120
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2
        let wobble = 0
        if (!reduceMotion) {
          smooth.bands.forEach((v, k) => { wobble += v * Math.sin(a * (k + 2) + t / (600 - k * 90) + k * 1.7) })
          wobble = wobble * 0.035 + (thinking ? 0.012 * Math.sin(a * 3 - t / 300) : 0)
        }
        const rr = r * (1 + wobble)
        const x = cx + rr * Math.cos(a), y = cy + rr * Math.sin(a)
        if (i === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      g.closePath()
      const color = style.getPropertyValue(you ? '--orb-you' : '--orb-agent').trim()
      const light = style.getPropertyValue(you ? '--orb-you-light' : '--orb-agent-light').trim()
      // Light drifting across the orb, like sky in a bubble.
      const drift = reduceMotion ? 0 : t / 2600
      const fill = g.createRadialGradient(cx + r * 0.35 * Math.cos(drift), cy - r * 0.35 + r * 0.15 * Math.sin(drift), r * 0.05, cx, cy, r * 1.05)
      fill.addColorStop(0, light)
      fill.addColorStop(1, color)
      g.shadowColor = color
      g.shadowBlur = 12 + 30 * smooth.level
      g.fillStyle = fill
      g.fill()
      g.shadowBlur = 0
      // Thinking: a light circling the orb, so there's visible feedback until the answer starts.
      if (thinking && !agentTalking) {
        const spin = reduceMotion ? 0 : t / 260
        const ring = g.createConicGradient(spin, cx, cy)
        ring.addColorStop(0, light)
        ring.addColorStop(0.35, color)
        ring.addColorStop(0.36, 'transparent')
        ring.addColorStop(1, 'transparent')
        g.beginPath()
        g.arc(cx, cy, base * 1.42, 0, Math.PI * 2)
        g.strokeStyle = ring
        g.lineWidth = 3
        g.lineCap = 'round'
        g.stroke()
      }
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])

  // ---- agent speech: streamed PCM scheduled back to back through the player chain (compressor →
  // volume → analyser), so playback starts with the first chunk of each sentence.
  /** What is scheduled to play, each buffer with the AudioContext time it starts. */
  const sources = useRef<Array<{ node: AudioBufferSourceNode; buffer: AudioBuffer; startAt: number }>>([])
  /** AudioContext time the last scheduled audio ends (on the timeline as if never paused). */
  const playEnd = useRef(0)
  /** Paused while checking whether the caller is talking over it: when, and what was left to play. */
  const paused = useRef<{ at: number; queue: Array<{ buffer: AudioBuffer; startAt: number; offset: number }> } | null>(null)
  const isPlaying = () => Boolean(paused.current) || Boolean(ctx.current && ctx.current.currentTime < playEnd.current)
  const startSource = (buffer: AudioBuffer, startAt: number, offset = 0) => {
    const node = audioContext().createBufferSource()
    node.buffer = buffer
    node.connect(playerInput.current ?? playerAnalyser.current!)
    node.start(startAt + offset, offset)
    const entry = { node, buffer, startAt }
    sources.current.push(entry)
    node.onended = () => { sources.current = sources.current.filter((s) => s !== entry) }
  }
  const schedule = (buffer: AudioBuffer): number => {
    const context = audioContext()
    const now = paused.current ? paused.current.at : context.currentTime
    const startAt = Math.max(now + (isPlaying() ? 0 : PLAYBACK_LEAD_S), playEnd.current)
    playEnd.current = startAt + buffer.duration
    if (paused.current) paused.current.queue.push({ buffer, startAt, offset: 0 })
    else startSource(buffer, startAt)
    return startAt
  }
  /** Stops the agent mid-word, keeping the rest to carry on from (resumePlayback). */
  const pausePlayback = () => {
    const context = ctx.current
    if (paused.current || !context) return
    const at = context.currentTime
    const queue = sources.current
      .filter((s) => s.startAt + s.buffer.duration > at)
      .map((s) => ({ buffer: s.buffer, startAt: s.startAt, offset: Math.max(0, at - s.startAt) }))
    for (const s of sources.current) { s.node.onended = null; try { s.node.stop() } catch { /* not started */ } }
    sources.current = []
    paused.current = { at, queue }
  }
  /** Carries on from exactly where it paused; the words being typed out move with it. */
  const resumePlayback = () => {
    const p = paused.current
    const context = ctx.current
    if (!p || !context) return
    paused.current = null
    const delta = context.currentTime + 0.02 - p.at
    for (const q of p.queue) startSource(q.buffer, q.startAt + delta, q.offset)
    playEnd.current += delta
    for (const span of live.current?.spans ?? []) {
      if (span.start === null || span.end <= p.at) continue
      span.start += delta
      span.end += delta
    }
  }
  const stopPlayback = () => {
    for (const s of sources.current) { s.node.onended = null; try { s.node.stop() } catch { /* not started */ } }
    sources.current = []
    paused.current = null
    playEnd.current = 0
    player.current?.pause()
    player.current = null
  }

  /** Your own recording ("Play my recording"), through the same chain so the waveform follows it. */
  const playRecording = (src: string) => {
    stopPlayback()
    const el = new Audio(src)
    player.current = el
    try { audioContext().createMediaElementSource(el).connect(playerInput.current ?? playerAnalyser.current!) } catch { /* already connected */ }
    void el.play().catch(() => undefined)
  }

  /** Each agent turn's audio, for "Play again" (this tab only). */
  const turnAudio = useRef(new Map<number, AudioBuffer[]>())
  const replay = (turnId: number) => {
    const buffers = turnAudio.current.get(turnId)
    if (!buffers?.length) return
    stopPlayback()
    buffers.forEach((b) => schedule(b))
  }

  /**
   * The answer being streamed in. Bumping activeTurn (when the caller talks over it, or starts
   * talking while it is still coming in) stops the rest of it from playing; its text still fills in.
   */
  const activeTurn = useRef(0)
  const answerDone = useRef(true)
  const rate = useRef(24_000)
  /** "Mm-hm." / "Okay." in the agent's voice, played when an answer is slow to start. */
  const fillers = useRef<AudioBuffer[]>([])
  const lastFiller = useRef(-1)
  const fillerLastTurn = useRef(false)
  /** The agent said goodbye (platform__end_call): hang up once it has finished speaking. */
  const endAfterSpeech = useRef(false)
  const endTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [endedByAgent, setEndedByAgent] = useState(false)

  /** The turn whose words are being typed out as they are said. */
  const live = useRef<{ turn: number; spans: Span[]; words: number; done: boolean; shown: number } | null>(null)
  const patchTurn = (id: number, patch: Partial<Turn>) => setTurns((prev) => prev.map((t) => (t.who === 'agent' && t.id === id ? { ...t, ...patch } : t)))
  /** Stops typing out the live turn: all of it was said, or (cut) only what's shown so far. */
  const settleLive = (cut: boolean) => {
    const l = live.current
    if (!l) return
    live.current = null
    patchTurn(l.turn, cut && (l.shown < l.words || !l.done) ? { shown: l.shown, cut: true } : { shown: undefined })
  }
  const startLive = (turn: number) => {
    settleLive(true)
    live.current = { turn, spans: [], words: 0, done: false, shown: 0 }
  }
  const liveSay = (turn: number, text: string) => {
    const l = live.current
    if (l?.turn !== turn) return
    const words = splitWords(text)
    l.spans.push({ from: l.words, count: words.length, chars: text.length, share: wordShares(words), times: [], start: null, end: 0, complete: false })
    l.words += words.length
  }
  const livePcm = (turn: number, base64: string) => {
    const buffer = ctx.current ? pcmToBuffer(ctx.current, base64, rate.current) : null
    if (!buffer) return
    turnAudio.current.set(turn, [...(turnAudio.current.get(turn) ?? []), buffer])
    const l = live.current
    if (l?.turn !== turn || turn !== activeTurn.current || !inCallRef.current) return
    const span = l.spans[l.spans.length - 1]
    const startAt = schedule(buffer)
    if (span && span.start === null) span.start = startAt
    if (span) span.end = startAt + buffer.duration
  }
  const liveWords = (turn: number, times: WordTimes) => {
    const span = live.current?.turn === turn ? live.current.spans[live.current.spans.length - 1] : undefined
    span?.times.push(...times.start)
  }
  const liveSaid = (turn: number) => {
    const span = live.current?.turn === turn ? live.current.spans[live.current.spans.length - 1] : undefined
    if (!span) return
    span.complete = true
    // No audio (speech failed): its words appear when it would have been its turn to be said.
    if (span.start === null) span.start = span.end = Math.max(ctx.current?.currentTime ?? 0, playEnd.current)
  }
  /** A whole clip (greeting, "didn't catch that") as one sentence of a new live turn. */
  const sayClip = (turn: number, text: string, clip: SpokenClip | null | undefined) => {
    startLive(turn)
    liveSay(turn, text)
    if (clip?.pcm) livePcm(turn, clip.pcm)
    if (clip?.words) liveWords(turn, clip.words)
    liveSaid(turn)
    if (live.current) live.current.done = true
  }

  /** Every frame: how many of the live turn's words have been said, from the scheduled audio. */
  const reveal = () => {
    const l = live.current
    const context = ctx.current
    if (!l || !context || paused.current) return
    const t = context.currentTime
    let shown = 0
    for (const span of l.spans) {
      if (span.start === null || t < span.start) break
      const elapsed = t - span.start
      let said: number
      if (span.complete && t >= span.end) said = span.count
      else if (span.times.length >= span.count || (!span.complete && span.times.length)) {
        // The service's own timings (a word count that differs from ours, e.g. "$7,500", is spread evenly).
        const n = span.times.length
        said = 0
        for (let i = 0; i < span.count; i++) {
          const at = span.times[n >= span.count ? Math.floor((i * n) / span.count) : i]
          if (at === undefined || at > elapsed) break
          said = i + 1
        }
      } else {
        const duration = span.complete ? span.end - span.start : Math.max(span.end - span.start, span.chars / CHARS_PER_SECOND)
        const fraction = duration > 0 ? elapsed / duration : 1
        said = span.share.filter((s) => s <= fraction).length
      }
      shown = span.from + said
      if (said < span.count) break
    }
    const last = l.spans[l.spans.length - 1]
    if (l.done && l.spans.every((s) => s.complete) && (!last || (last.start !== null && t >= last.end))) return settleLive(false)
    // Never backwards (a sentence resumed after a pause restarts its clock from where it was).
    if (shown > l.shown) {
      l.shown = shown
      patchTurn(l.turn, { shown })
    }
  }
  const revealRef = useRef(reveal)
  revealRef.current = reveal

  const cancelAnswer = () => {
    activeTurn.current++
    answerDone.current = true // the rest of the old answer won't be played
    stopPlayback()
    settleLive(true)
  }

  // ---- live transcription: the caller's words as they say them (live-transcriber.ts)
  /** Opens (or reopens, after an hour or a dropped connection) live transcription; turns are uploaded meanwhile. */
  const connectLive = () => {
    if (liveConnecting.current || liveStt.current?.ready) return
    liveConnecting.current = true
    void LiveTranscriber.connect(agentId).then((live) => {
      liveConnecting.current = false
      if (!live) return
      if (!inCallRef.current) { live.close(); return }
      liveStt.current?.close()
      live.onPartial = (text) => {
        if (phaseRef.current !== 'hearing') return
        partialRef.current = text
        partialAt.current = Date.now()
      }
      const onWords = live.onPartial
      live.onPartial = (text) => {
        if (phaseRef.current === 'thinking' && wordsAfterTurn.current) { partialRef.current = text; partialAt.current = Date.now(); wordsAfterTurn.current(text); return }
        onWords(text)
      }
      liveStt.current = live
    })
  }
  const clearPartial = () => { partialRef.current = '' }

  /** The call so far and its ids, as every turn (and draft) sends them. */
  const turnForm = () => {
    const history = turnsRef.current
      .filter((t) => t.text && !t.text.startsWith('('))
      .slice(-24) // the server shows the last 8; older turns still say what they did (outcome)
      // What a turn did, not only what was said: without it the agent took its own "I've passed
      // it on" for a promise and handed the same request over again every turn (26 Oct).
      .map((t) => ({ who: t.who === 'you' ? 'caller' : 'agent', text: t.text, outcome: t.who === 'agent' && (t.status === 'escalated' || t.status === 'approval_required') ? t.status : undefined }))
    const form = new FormData()
    form.append('history', JSON.stringify(history))
    form.append('conversationId', conversationId.current)
    if (interruptedTurn.current) form.append('interrupted', '1')
    return form
  }

  /** Starts drafting the answer to `text` (the words so far, at a pause). */
  const startDraft = (text: string, seconds: number) => {
    const id = crypto.randomUUID()
    const abort = new AbortController()
    const form = turnForm()
    form.append('transcript', text)
    form.append('draft', id)
    form.append('liveWaitMs', '0')
    form.append('liveSeconds', seconds.toFixed(2))
    const response = fetch(`/api/agents/${agentId}/voice`, { method: 'POST', body: form, signal: abort.signal })
      .then((res) => {
        if (res.ok && (res.headers.get('content-type') ?? '').includes('ndjson')) return res
        void res.body?.cancel()
        return null
      })
      .catch(() => null)
    draft.current = { id, text, seconds, response, abort }
  }

  const decideDraft = (id: string, go: boolean) =>
    fetch(`/api/agents/${agentId}/voice/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, go }) }).then((r) => r.ok, () => false)

  /** The caller said more (or the call moved on): the draft is thrown away, having done nothing. */
  const dropDraft = () => {
    const d = draft.current
    if (!d) return
    draft.current = null
    void d.response.then((res) => { if (res) void decideDraft(d.id, false) })
    d.abort.abort()
  }

  /**
   * The draft, if it answers exactly `text` (the whole turn): it goes ahead and its stream is
   * played. null otherwise (and any draft is dropped).
   */
  const takeDraft = (text: string): Promise<Response | null> | null => {
    const d = draft.current
    if (!d || !sameWords(d.text, text)) { dropDraft(); return null }
    draft.current = null
    return d.response.then(async (res) => {
      if (!res) return null
      if (await decideDraft(d.id, true)) return res
      d.abort.abort()
      return null
    })
  }

  /** A quiet "mm-hm" while the caller talks, on its own path: it isn't an answer, so the call stays in "hearing". */
  const playBackchannel = () => {
    const context = ctx.current
    const clips = backchannels.current
    if (!context || !clips.length) return
    const b = backchannel.current
    let pick = Math.floor(Math.random() * clips.length)
    if (pick === b.last) pick = (pick + 1) % clips.length
    b.last = pick
    const node = context.createBufferSource()
    node.buffer = clips[pick]
    const gain = context.createGain()
    gain.gain.value = 0.7 // softer than an answer: a listener's murmur
    node.connect(gain).connect(playerInput.current ?? playerAnalyser.current!)
    node.start()
    b.until = context.currentTime + clips[pick].duration
    b.playedThisTurn = true
  }

  // ---- one utterance: start recording when speech begins, stop after a pause
  const beginUtterance = (interrupting = false) => {
    if (!stream.current) return
    // Still talking after the goodbye ("oh, one more thing"): stay on the call.
    endAfterSpeech.current = false
    if (endTimer.current) { clearTimeout(endTimer.current); endTimer.current = null }
    interruptedTurn.current = interrupting
    // Talking again before the answer has finished arriving: the caller has moved on.
    cancelAnswer()
    dropDraft()
    wordsAfterTurn.current = null
    vad.current.startedAt = Date.now()
    vad.current.silenceMs = 0
    vad.current.peak = 0
    if (capture.current) {
      const rate = capture.current.rate
      const ms = interrupting ? Math.min(BARGE_IN_PRE_ROLL_MS, Date.now() - vad.current.suspectAt + BARGE_IN_LEAD_MS) : PRE_ROLL_MS
      const keep = Math.ceil(((ms / 1000) * rate) / 2048)
      captured.current = preRoll.current.slice(-keep)
      preRoll.current = []
      clearPartial()
      backchannel.current = { ...backchannel.current, lastAt: Date.now(), wordsAt: 0, playedThisTurn: false, pauseFired: false }
      const live = liveStt.current
      liveTurnSeq.current++ // a turn still waiting for its text is now part of this one
      liveParts.current = []
      liveHeld.current = false
      liveStash.current = []
      if (live?.ready) {
        live.begin()
        for (const block of captured.current) live.push(block, rate)
      } else if (inCallRef.current) {
        connectLive() // for the next turn; this one is uploaded
      }
      setPhaseBoth('hearing')
      return
    }
    const mimeType = recorderMimeType()
    const rec = new MediaRecorder(stream.current, mimeType ? { mimeType } : undefined)
    chunks.current = []
    rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data) }
    rec.onstop = () => {
      const took = Date.now() - vad.current.startedAt
      const blob = new Blob(chunks.current, { type: rec.mimeType || mimeType || 'audio/webm' })
      if (took < MIN_UTTERANCE_MS || blob.size < 1000) {
        // A cough or a click, not a sentence: keep listening.
        if (inCallRef.current) setPhaseBoth('listening')
        return
      }
      void send(blob)
    }
    recorder.current = rec
    rec.start()
    vad.current.startedAt = Date.now()
    vad.current.silenceMs = 0
    vad.current.peak = 0
    setPhaseBoth('hearing')
  }

  const endUtterance = () => {
    if (captured.current && capture.current) {
      const blocks = captured.current
      captured.current = null
      const wav = encodeWav(blocks, capture.current.rate, END_SILENCE_MS - TAIL_MS)
      const live = liveStt.current
      // About 0.3 s of sound after trimming: a cough or a click, not a sentence.
      const parts = liveParts.current
      liveParts.current = []
      liveStash.current = []
      const held = liveHeld.current
      liveHeld.current = false
      if (wav.size < 44 + WAV_RATE * 0.6) { live?.discard(); clearPartial(); if (inCallRef.current) setPhaseBoth('listening'); return }
      if (live?.ready) {
        // The words are already in: wait only for the last few, then send the text instead of
        // the recording. If they don't come (or come back empty), upload the recording as before.
        setPhaseBoth('thinking')
        answerDone.current = false // an answer is coming: stay "thinking", not "listening"
        const playedBackchannel = backchannel.current.playedThisTurn
        const stoppedAt = Date.now()
        const seq = ++liveTurnSeq.current
        const seconds = (stoppedAt - vad.current.startedAt) / 1000
        // The last part, unless the turn ended while it was already committed (held).
        if (!held) parts.push(live.commit())
        let sent = false
        const sendOnce = (transcript: string, waitMs: number, liveSeconds: number) => {
          if (sent) return
          sent = true
          wordsAfterTurn.current = null
          // The answer drafted at the last pause, if it answers exactly these words, is already under way.
          void send(wav, { transcript, waitMs, seconds: liveSeconds }, takeDraft(transcript) ?? undefined)
        }
        // The live words are the final text as it arrives, so the turn can go as soon as they end
        // a sentence ("…package?"), ~0.25 s before the transcriber confirms them. Only a sentence end
        // that arrived WORDS_CAUGHT_UP_MS after the caller stopped: the words run up to ~1 s behind
        // the voice, so an earlier one ("…Newtown.") may have more words still coming after it. Not
        // after "…and"/"…um" (endSilenceMs), nor when an earlier turn's words are to be added (carryOver).
        const spokeUntil = stoppedAt - END_SILENCE_MS
        const whole = (text: string) =>
          !carryOver.current && seq === liveTurnSeq.current && wordCount(text) > 0 && endSilenceMs(text, END_SILENCE_MS) === END_SILENCE_MS && endsSentence(text)
        const sofar = withoutBackchannels(partialRef.current, playedBackchannel)
        if (partialAt.current - spokeUntil >= WORDS_CAUGHT_UP_MS && whole(sofar)) {
          sendOnce(sofar, 0, seconds)
          return
        }
        wordsAfterTurn.current = (text) => {
          const words = withoutBackchannels(text, playedBackchannel)
          if (Date.now() - spokeUntil >= WORDS_CAUGHT_UP_MS && whole(words)) sendOnce(words, Date.now() - stoppedAt, seconds)
        }
        void Promise.all(parts).then((results) => {
          const heard = results.some((r) => r === null) ? null : { text: results.map((r) => r!.text).filter(Boolean).join(' '), seconds: results.reduce((sum, r) => sum + r!.seconds, 0) }
          const text = heard ? withoutBackchannels(heard.text, playedBackchannel) : ''
          const go = () => {
            if (sent) return
            // The caller carried on talking before this was sent: it opens their next turn.
            if (seq !== liveTurnSeq.current || !inCallRef.current) { if (text) carryOver.current = `${carryOver.current} ${text}`.trim(); return }
            const said = `${carryOver.current} ${text}`.trim()
            carryOver.current = ''
            if (heard && text) sendOnce(said, Date.now() - stoppedAt, heard.seconds)
            else { sent = true; wordsAfterTurn.current = null; dropDraft(); void send(wav) }
          }
          // Stopped on "…and", "…um" or a comma: probably still thinking, so give them a moment
          // more before answering (judged on the finished text; the live words run behind the voice).
          const more = endSilenceMs(text, END_SILENCE_MS) - END_SILENCE_MS - (Date.now() - stoppedAt)
          if (more > 0) setTimeout(go, more)
          else go()
        })
        return
      }
      void send(wav)
      return
    }
    if (recorder.current?.state === 'recording') {
      setPhaseBoth('thinking')
      recorder.current.stop()
    }
  }

  /**
   * Pauses the agent while checking whether the caller is talking over it, or lets it carry on.
   */
  const hold = (on: boolean) => {
    vad.current.held = on
    vad.current.holdTicks = 0
    if (on) {
      pausePlayback()
    } else {
      resumePlayback()
    }
  }

  /** Speaking over the agent: stop it mid-sentence and listen. */
  const bargeIn = () => {
    vad.current.held = false
    cancelAnswer() // drops what was paused too
    setTurns((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (last?.who === 'agent') next[next.length - 1] = { ...last, note: last.note ?? 'Interrupted' }
      return next
    })
  }

  /**
   * Someone is speaking (not a noise in the room, nor the agent's own voice from the speakers):
   * speech at least `minLevel` loud, heard since `since` (performance.now()). Without the
   * detector (still loading, or an old browser) loudness alone decides, as before.
   */
  const heardVoice = (since = 0, minLevel = 0) => (detector.current ? detector.current.voice(since, minLevel) : true)
  // Fetch the detector's model while the page is open, so it's ready when a call starts.
  useEffect(() => { void loadSpeechModel() }, [])

  // ---- the detection loop: level against an adaptive noise floor
  const tick = () => {
    const analyser = micAnalyser.current
    if (!inCallRef.current || !analyser) return
    // Speaking while its audio plays; listening once it has finished and nothing more is coming.
    // While thinking, only the answer itself counts: an "Okay." filler leaves it thinking, so the
    // page still shows that after the filler (it showed "speaking" over silence).
    const playing = isPlaying()
    const l = live.current
    const answering = !!l && l.turn === activeTurn.current && l.spans.some((s) => s.start !== null)
    if (playing && (phaseRef.current === 'starting' || phaseRef.current === 'listening' || (phaseRef.current === 'thinking' && answering))) setPhaseBoth('speaking')
    else if (!playing && answerDone.current && (phaseRef.current === 'speaking' || phaseRef.current === 'thinking' || phaseRef.current === 'starting')) setPhaseBoth('listening')
    // Goodbye said and finished: hang up a moment later, unless the caller starts talking again.
    if (endAfterSpeech.current && !playing && answerDone.current && phaseRef.current === 'listening' && !endTimer.current) {
      endTimer.current = setTimeout(() => {
        endTimer.current = null
        if (!endAfterSpeech.current || phaseRef.current !== 'listening') return
        const turnId = activeTurn.current
        setTurns((prev) => prev.map((t) => (t.who === 'agent' && t.id === turnId ? { ...t, note: t.note ?? 'Ended the call' } : t)))
        setEndedByAgent(true)
        stopEverything()
      }, END_CALL_AFTER_MS)
    }
    const p = phaseRef.current
    if (mutedRef.current) {
      if (p === 'hearing') {
        captured.current = null
        liveParts.current = []
        liveHeld.current = false
        liveStash.current = []
        liveStt.current?.discard()
        clearPartial()
        if (recorder.current) { recorder.current.onstop = null; recorder.current.stop(); recorder.current = null }
        setPhaseBoth('listening')
      }
      preRoll.current = []
      return
    }
    const rms = levelOf(analyser)
    const v = vad.current
    // Nothing to hold any more (the answer was replaced, or the call moved on).
    if (v.held && p !== 'speaking') hold(false)

    if (p === 'listening' || p === 'speaking' || p === 'thinking') {
      // What the agent is playing, held briefly because its echo reaches the mic a little later.
      // Measured in every phase: a clip starts before the phase says "speaking", and its echo
      // carries on after it ends (those were heard as the caller saying "Right." or "So...").
      // The loudest of the last 200 ms: the echo of a loud syllable arrives a moment after it plays.
      v.played.push(levelOf(playerAnalyser.current))
      if (v.played.length > 4) v.played.shift()
      v.playerLevel = Math.max(...v.played, v.playerLevel * 0.6)
      // The mic also hears the agent from the speakers (less after the browser's echo
      // cancellation, almost nothing with a headset): compared against that expected echo,
      // learned on this call, instead of a fixed level that was too high to interrupt.
      const echo = v.echoCoupling * v.playerLevel
      // Learn the room's background level while it's quiet.
      if (p === 'listening' && v.playerLevel < 0.005 && rms < v.floor * 1.6) v.floor = Math.max(0.002, v.floor * 0.95 + rms * 0.05)
      const base = Math.max(MIN_SPEECH_LEVEL, v.floor * 3)
      const speechLevel = Math.max(base, echo * SPEECH_OVER_ECHO)
      const speech = rms > speechLevel

      if (p === 'speaking' && v.held) {
        v.holdTicks++
        // Loud enough to be the caller, and a voice (not a noise in the room) heard since the
        // agent paused, once its own voice has dropped out of the microphone.
        const settledAt = v.heldAt + HOLD_RESET_TICKS * TICK_MS
        // Its voice has (nearly) cleared the room: the detector starts afresh, hearing only the room.
        if (v.holdTicks === HOLD_RESET_TICKS) detector.current?.reset()
        if (v.holdTicks >= HOLD_COUNT_FROM_TICKS && speech) v.loudTicks++
        if (v.holdTicks > HOLD_RESET_TICKS && heardVoice(settledAt, speechLevel)) v.voiceHeard = true
        if (v.loudTicks >= CONFIRM_TICKS && v.voiceHeard) {
          v.loudTicks = 0
          bargeIn()
          beginUtterance(true)
        } else if (v.holdTicks >= HOLD_MAX_TICKS || (!v.voiceHeard && detector.current?.noVoice(settledAt))) {
          // Not the caller. If what set it off was speech and stopped when the agent paused, it was
          // the agent's own echo, louder than estimated: learn that (with a margin), so it doesn't
          // set off the next pause. A clack or a clatter (not speech; it may stop by itself too)
          // says nothing about the echo, and learning from it made interrupting take ~3 s.
          const ownEcho = v.suspectSpeech && !v.loudTicks && !v.voiceHeard
          if (ownEcho) v.echoCoupling = Math.min(1, Math.max(v.echoCoupling, v.suspectRatio * ECHO_MARGIN))
          v.holdAgainAt = performance.now() + (ownEcho ? HOLD_COOLDOWN_MS : NOISE_COOLDOWN_MS)
          hold(false)
          v.loudTicks = 0
        }
      } else if (p === 'speaking') {
        const suspect = rms > Math.max(base, echo * SUSPECT_OVER_ECHO)
        // Follows the echo's peaks, letting go slowly: an average dropped below the next loud
        // syllable's echo within a second, which set off another pause. Raised only by what
        // sounds like speech (the echo is the agent's voice): a clatter just under the pause
        // level ratcheted it up tick by tick, and interrupting then took ~3 s.
        if (!suspect && v.playerLevel > 0.01) {
          const echoLike = detector.current ? detector.current.speechLately() : true
          v.echoCoupling = Math.min(1, Math.max(echoLike ? rms / v.playerLevel : 0, v.echoCoupling * ECHO_DECAY))
        }
        // From the first time the caller seemed to talk, even if that check was dropped and retried.
        if (suspect && !v.loudTicks && Date.now() - v.suspectAt > BARGE_IN_PRE_ROLL_MS) v.suspectAt = Date.now()
        if (suspect && !v.loudTicks) { v.suspectRatio = 0; v.suspectSpeech = false }
        if (suspect && (detector.current ? detector.current.speechLately() : true)) v.suspectSpeech = true
        if (suspect && v.playerLevel > 0.01) v.suspectRatio = Math.max(v.suspectRatio, rms / v.playerLevel)
        v.loudTicks = suspect ? v.loudTicks + 1 : 0
        if (v.loudTicks >= HOLD_TICKS && performance.now() >= v.holdAgainAt) {
          // A voice still has to be heard while it's paused (see above), so a noise only pauses it.
          v.loudTicks = 0
          v.voiceHeard = false
          v.heldAt = performance.now()
          // No echo to expect while paused: the last 200 ms at full volume made a short first
          // word ("Sorry, …") too quiet to count, so it took the next one.
          v.played = []
          hold(true)
        }
      } else {
        // A turn starts on a voice: loud for START_TICKS and the detector hearing speech. A noise
        // (a container, cutlery, a bag) doesn't; the pre-roll keeps the first syllable.
        v.loudTicks = speech ? v.loudTicks + 1 : 0
        if (v.loudTicks >= START_TICKS && heardVoice(0, speechLevel)) {
          v.loudTicks = 0
          beginUtterance()
        }
      }
    } else if (p === 'hearing') {
      v.peak = Math.max(v.peak, rms)
      // While our own "mm-hm" plays (and just after), its echo isn't the caller talking.
      const b = backchannel.current
      const ownMurmur = ctx.current && ctx.current.currentTime < b.until + 0.2 ? v.echoCoupling * levelOf(playerAnalyser.current) * SPEECH_OVER_ECHO : 0
      const quiet = rms < Math.max(MIN_SPEECH_LEVEL * 0.8, v.floor * 2.2, ownMurmur)
      v.silenceMs = quiet ? v.silenceMs + TICK_MS : 0
      if (!quiet) b.pauseFired = false
      const took = Date.now() - v.startedAt
      // At a pause, have what's been said so far finished off now; speaking again starts a new part.
      const live = liveStt.current
      if (live?.ready && captured.current && capture.current) {
        if (quiet && !liveHeld.current && v.silenceMs >= EARLY_COMMIT_MS && v.silenceMs < END_SILENCE_MS) {
          liveHeld.current = true
          liveParts.current.push(live.commit())
        } else if (!quiet && liveHeld.current) {
          liveHeld.current = false
          for (const block of liveStash.current) live.push(block, capture.current.rate)
          liveStash.current = []
        }
      }
      if (
        !b.pauseFired && backchannels.current.length && liveStt.current?.ready &&
        shouldBackchannel({ speakingMs: took, sinceLastMs: Date.now() - b.lastAt, wordsSince: wordCount(partialRef.current) - b.wordsAt, pauseMs: v.silenceMs, partial: partialRef.current })
      ) {
        b.pauseFired = true
        b.lastAt = Date.now()
        b.wordsAt = wordCount(partialRef.current)
        playBackchannel()
      }
      // Draft the answer at a pause; the caller saying more drops it (a new one starts at the next pause).
      if (liveStt.current?.ready && captured.current) {
        const sofar = withoutBackchannels(partialRef.current, b.playedThisTurn)
        if (draft.current && !sameWords(draft.current.text, sofar)) dropDraft()
        if (!draft.current && quiet && v.silenceMs >= DRAFT_PAUSE_MS && wordCount(sofar) >= 2 && endsSentence(sofar)) startDraft(sofar, took / 1000)
      }
      if ((v.silenceMs >= END_SILENCE_MS && took > MIN_UTTERANCE_MS) || took > MAX_UTTERANCE_MS) endUtterance()
    }
  }

  // ---- send a turn with the conversation so far
  /** `heardLive`: the caller's words already transcribed as they spoke (sent instead of the recording, which stays in this tab). */
  /** `drafted`: the answer drafted at the last pause, already under way (falls back to a normal turn if it failed). */
  const send = async (audio: Blob, heardLive?: { transcript: string; waitMs: number; seconds: number }, drafted?: Promise<Response | null>) => {
    setPhaseBoth('thinking')
    const recordingUrl = URL.createObjectURL(audio)
    recordingUrls.current.push(recordingUrl)
    const form = turnForm()
    if (heardLive) {
      form.append('transcript', heardLive.transcript)
      form.append('liveWaitMs', String(heardLive.waitMs))
      form.append('liveSeconds', heardLive.seconds.toFixed(2))
    } else {
      form.append('audio', audio, 'utterance')
    }
    const turn = ++activeTurn.current
    answerDone.current = false
    let heard = false
    // If the answer is slow to start, acknowledge, the way a person says "mm-hm" on a call.
    const fillerAllowed = !fillerLastTurn.current && !backchannel.current.playedThisTurn
    fillerLastTurn.current = false
    setTimeout(() => {
      if (!fillerAllowed || turn !== activeTurn.current || isPlaying() || live.current?.spans.some((s) => s.start !== null) || phaseRef.current !== 'thinking' || !fillers.current.length) return
      fillerLastTurn.current = true
      let pick = Math.floor(Math.random() * fillers.current.length)
      if (pick === lastFiller.current) pick = (pick + 1) % fillers.current.length
      lastFiller.current = pick
      schedule(fillers.current[pick])
    }, FILLER_AFTER_MS)
    try {
      const res = (drafted && (await drafted)) || (await fetch(`/api/agents/${agentId}/voice`, { method: 'POST', body: form }))
      if (!res.ok) {
        const body: VoiceResponse = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      if (!(res.headers.get('content-type') ?? '').includes('ndjson')) {
        // Nothing usable was heard: a plain JSON reply.
        const body: VoiceResponse = await res.json()
        answerDone.current = true
        clearPartial()
        if (!inCallRef.current || turn !== activeTurn.current) return
        if (body.status === 'no_speech') return // don't make the agent say "sorry?" to background noise
        if (body.rate) rate.current = body.rate
        setTurns((prev) => [
          ...prev,
          { who: 'you', text: body.transcript || '(nothing heard)', recordingUrl, note: 'Not understood clearly, so it wasn’t sent to the agent.' },
          { who: 'agent', id: turn, text: body.reply ?? '', shown: 0, status: body.status },
        ])
        sayClip(turn, body.reply ?? '', body.speech)
        return
      }

      // Streamed answer: heard → for each sentence, say → pcm… (and words) → said → done.
      const update = (fn: (t: Turn) => Turn) => setTurns((prev) => prev.map((t) => (t.who === 'agent' && t.id === turn ? fn(t) : t)))
      heard = true
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).trim()
          pending = pending.slice(newline + 1)
          if (!line) continue
          const event = JSON.parse(line) as { type: string; transcript?: string; runId?: string | null; rate?: number; text?: string; data?: string; ttsError?: string; status?: string; endCall?: boolean } & Partial<WordTimes>
          if (event.type === 'heard') {
            clearPartial()
            if (event.rate) rate.current = event.rate
            // A turn already talked over (the caller started again) is shown, not typed out.
            if (turn === activeTurn.current) startLive(turn)
            setTurns((prev) => [
              ...prev,
              { who: 'you', text: event.transcript || '(nothing heard)', recordingUrl },
              { who: 'agent', id: turn, text: '', shown: turn === activeTurn.current ? 0 : undefined, cut: turn !== activeTurn.current || undefined, runId: event.runId ?? null },
            ])
          } else if (event.type === 'say') {
            liveSay(turn, event.text ?? '')
            update((t) => ({ ...t, text: t.text ? `${t.text} ${event.text ?? ''}` : event.text ?? '' }))
          } else if (event.type === 'pcm' && event.data) {
            livePcm(turn, event.data)
          } else if (event.type === 'words' && event.start) {
            liveWords(turn, { words: event.words ?? [], start: event.start, end: event.end ?? [] })
          } else if (event.type === 'said') {
            liveSaid(turn)
            if (event.ttsError) update((t) => ({ ...t, note: `Speech unavailable: ${event.ttsError}` }))
          } else if (event.type === 'done') {
            update((t) => ({ ...t, status: event.status, runId: event.runId ?? t.runId, text: t.text || '(no answer)' }))
            if (event.endCall && turn === activeTurn.current) endAfterSpeech.current = true
          }
        }
      }
      if (live.current?.turn === turn) live.current.done = true
      if (turn === activeTurn.current) answerDone.current = true
      onTurnDone?.()
    } catch (e) {
      if (live.current?.turn === turn) live.current.done = true
      if (turn === activeTurn.current) answerDone.current = true
      // The connection dropped part-way through an answer (Firefox: "Error in input stream"):
      // say so on that answer, and keep the call going.
      if (heard) setTurns((prev) => prev.map((t) => (t.who === 'agent' && t.id === turn ? { ...t, note: 'The connection dropped, so part of this answer may be missing.' } : t)))
      else setError(e instanceof Error ? e.message : 'Something went wrong')
    }
  }

  // ---- call control
  const startCall = async () => {
    setError(null)
    setEndedByAgent(false)
    audioContext() // created inside the click, so the browser lets it play sound
    chime('start') // before the microphone opens, so it isn't heard as the caller
    // The call view is taller (the orb grows): bring the panel up under the page header so all of it shows.
    panel.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('This browser cannot record audio. Try a current Chrome, Edge, Firefox or Safari.')
      return
    }
    setPhaseBoth('starting')
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { ...(micId ? { deviceId: { exact: micId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      stream.current = s
      void loadMics()
      const context = audioContext()
      // Rumble below the voice (desk knocks, fans, handling noise) removed for both detection and
      // transcription; detection also ignores hiss above the speech band.
      const source = context.createMediaStreamSource(s)
      const highpass = context.createBiquadFilter()
      highpass.type = 'highpass'
      highpass.frequency.value = 90
      source.connect(highpass)
      const speechBand = context.createBiquadFilter()
      speechBand.type = 'lowpass'
      speechBand.frequency.value = 4000
      highpass.connect(speechBand)
      micAnalyser.current = context.createAnalyser()
      micAnalyser.current.fftSize = 1024
      micAnalyser.current.smoothingTimeConstant = 0.6
      speechBand.connect(micAnalyser.current) // detection only; never to the speakers
      vad.current = { floor: 0.01, loudTicks: 0, silenceMs: 0, startedAt: 0, peak: 0, echoCoupling: INITIAL_ECHO_COUPLING, playerLevel: 0, held: false, holdTicks: 0, suspectAt: 0, played: [], suspectRatio: 0, voiceHeard: false, heldAt: 0, holdAgainAt: 0, suspectSpeech: false }
      try {
        if (!workletLoaded.current) {
          const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }))
          await context.audioWorklet.addModule(url)
          URL.revokeObjectURL(url)
          workletLoaded.current = true
        }
        const node = new AudioWorkletNode(context, 'voice-capture')
        const keepBlocks = Math.ceil(((BARGE_IN_PRE_ROLL_MS / 1000) * context.sampleRate) / 2048)
        node.port.onmessage = (e: MessageEvent<Float32Array>) => {
          detector.current?.push(e.data, context.sampleRate)
          if (captured.current) {
            captured.current.push(e.data)
            if (liveHeld.current) liveStash.current.push(e.data)
            else liveStt.current?.push(e.data, context.sampleRate)
          } else {
            preRoll.current.push(e.data)
            if (preRoll.current.length > keepBlocks) preRoll.current.shift()
          }
        }
        highpass.connect(node)
        // Silent output: a node with nowhere to send its sound may not be run at all.
        const silent = context.createGain()
        silent.gain.value = 0
        node.connect(silent).connect(context.destination)
        capture.current = { node, rate: context.sampleRate }
        // Fed by the capture above, so only with it. Doesn't hold up the call while it loads.
        void SpeechDetector.create().then((d) => { if (capture.current?.node === node) detector.current = d })
      } catch {
        capture.current = null // older browser: MediaRecorder from the moment speech is detected
      }

      inCallRef.current = true // live transcription connects while the greeting loads
      connectLive()
      const res = await fetch(`/api/agents/${agentId}/voice`)
      const body: VoiceResponse & { fillers?: Array<{ pcm: string }>; backchannels?: Array<{ pcm: string }> } = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      if (body.rate) rate.current = body.rate
      fillers.current = (body.fillers ?? []).flatMap((f) => pcmToBuffer(context, f.pcm, rate.current) ?? [])
      backchannels.current = (body.backchannels ?? []).flatMap((f) => pcmToBuffer(context, f.pcm, rate.current) ?? [])
      inCallRef.current = true
      setInCall(true)
      setCallStartedAt(Date.now())
      setCallSeconds(0)
      setMuted(false)
      answerDone.current = true
      const turn = ++activeTurn.current
      setTurns((prev) => [...prev, { who: 'agent', id: turn, text: body.greeting ?? '', shown: 0, note: body.ttsError ? `Speech unavailable: ${body.ttsError}` : undefined }])
      sayClip(turn, body.greeting ?? '', body.speech)
      vadTimer.current = setInterval(tick, TICK_MS)
    } catch (e) {
      const name = e instanceof DOMException ? e.name : ''
      setError(
        name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the browser’s site settings and try again.'
          : name === 'OverconstrainedError' || name === 'NotFoundError' ? 'That microphone isn’t available. Pick another one from the list.'
          : e instanceof Error ? e.message : 'Could not start the call.'
      )
      stopEverything()
    }
  }

  /**
   * A short two-note chime, like a phone app: rising when a call starts, falling when it ends.
   * Synthesised (no audio files) and played straight to the speakers, outside the agent's voice
   * chain, so the orb and echo checks never see it.
   */
  const chime = (kind: 'start' | 'end') => {
    const context = ctx.current
    if (!context || context.state === 'closed') return
    const notes = kind === 'start' ? [587.33, 880] : [880, 587.33] // D5 → A5, or back down
    const at = context.currentTime + 0.02
    notes.forEach((freq, i) => {
      const start = at + i * 0.16
      const osc = context.createOscillator()
      const gain = context.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.14, start + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32)
      osc.connect(gain).connect(context.destination)
      osc.start(start)
      osc.stop(start + 0.34)
    })
  }

  const stopEverything = () => {
    // Hanging up (either side), not tidying up after a call that never connected.
    if (inCallRef.current) chime('end')
    dropDraft()
    endAfterSpeech.current = false
    if (endTimer.current) { clearTimeout(endTimer.current); endTimer.current = null }
    inCallRef.current = false
    setInCall(false)
    if (vadTimer.current) clearInterval(vadTimer.current)
    vadTimer.current = null
    if (recorder.current?.state === 'recording') { recorder.current.onstop = null; recorder.current.stop() }
    recorder.current = null
    capture.current?.node.disconnect()
    capture.current = null
    detector.current = null
    captured.current = null
    preRoll.current = []
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    liveStt.current?.close()
    liveStt.current = null
    clearPartial()
    cancelAnswer()
    answerDone.current = true
    setPhaseBoth('idle')
  }

  useEffect(() => () => {
    stopEverything()
    recordingUrls.current.forEach((u) => URL.revokeObjectURL(u))
    void ctx.current?.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Runs one of your turns' recordings through every configured transcriber. */
  const compareTurn = async (turn: Turn) => {
    if (!turn.recordingUrl) return
    const patch = (p: Partial<Turn>) => setTurns((prev) => prev.map((t) => (t.recordingUrl === turn.recordingUrl ? { ...t, ...p } : t)))
    patch({ comparing: true })
    try {
      const comparison = await compareRecording(agentId, await (await fetch(turn.recordingUrl)).blob())
      patch({ comparing: false, comparison })
    } catch (e) {
      patch({ comparing: false })
      setError(e instanceof Error ? e.message : 'Comparison failed')
    }
  }

  // ---- the current exchange (latest of yours + latest of the agent's) and earlier history
  const last = turns.length - 1
  const pairStart = last > 0 && turns[last].who === 'agent' && turns[last - 1].who === 'you' ? last - 1 : last
  const current = last < 0 ? [] : turns.slice(pairStart)
  const earlier = turns.slice(0, Math.max(0, pairStart)).reverse()

  const label =
    phase === 'starting' ? 'Connecting…'
      : phase === 'listening' ? (muted ? 'Muted. Unmute to talk.' : 'Listening… just start talking')
      : phase === 'hearing' ? 'You’re speaking…'
      : phase === 'thinking' ? `${first} is thinking…`
      : phase === 'speaking' ? `${first} is speaking. Talk to interrupt.`
      : endedByAgent ? `${first} ended the call. Call again any time.`
      : `Call ${first}: talk naturally, no buttons. A headset works best.`

  return (
    <section
      ref={panel}
      aria-label={`Talk to ${first}`}
      className="scroll-mt-20 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-gradient-to-b from-primary-50/70 to-white dark:from-primary-950/30 dark:to-neutral-900 p-5 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">Talk to {first}</h2>
          <p className="text-xs text-neutral-500">Same agent, rules and knowledge as a typed task. {first} introduces itself as an AI assistant.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 min-w-0">
        <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
          <Volume2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span className="sr-only">{first}&apos;s volume</span>
          <input id="voice-volume" type="range" min={0.5} max={3} step={0.1} value={volume} onChange={(e) => changeVolume(Number(e.target.value))} className="w-24 accent-primary-600" aria-valuetext={`${Math.round(volume * 100)}%`} />
          <span className="tabular-nums w-9">{Math.round(volume * 100)}%</span>
        </label>
        {mics.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400 min-w-0">
            <Mic className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="sr-only">Microphone</span>
            <select
              id="voice-mic"
              value={micId}
              onChange={(e) => chooseMic(e.target.value)}
              disabled={inCall}
              className="max-w-[16rem] min-w-0 truncate rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-2 py-1 text-xs"
            >
              <option value="">System default microphone</option>
              {mics.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>
              ))}
            </select>
          </label>
        )}
        </div>
      </div>

      <div className="flex flex-col items-center gap-3">
        {/* A call: the agent's name and the call timer above an orb that grows to fill the panel. */}
        <div className={`text-center transition-all duration-500 ${phase !== 'idle' ? 'opacity-100 max-h-20' : 'opacity-0 max-h-0 overflow-hidden'}`} aria-hidden={phase === 'idle'}>
          <p className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">{first}</p>
          <p className="text-sm tabular-nums text-neutral-500 dark:text-neutral-400">
            {inCall ? `${Math.floor(callSeconds / 60)}:${String(callSeconds % 60).padStart(2, '0')}` : 'Calling…'}
          </p>
        </div>
        <canvas
          ref={canvas}
          aria-hidden="true"
          className={`w-full transition-[height] duration-700 ease-out ${phase !== 'idle' ? 'h-80' : 'h-40'} [--orb-agent:theme(colors.primary.600)] [--orb-agent-light:theme(colors.primary.200)] [--orb-you:theme(colors.rose.500)] [--orb-you-light:theme(colors.rose.200)] dark:[--orb-agent:theme(colors.primary.500)] dark:[--orb-agent-light:theme(colors.primary.300)] dark:[--orb-you:theme(colors.rose.400)] dark:[--orb-you-light:theme(colors.rose.200)]`}
        />
        <p className="inline-flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300 min-h-[1.25rem] text-center" role="status" aria-live="polite">
          {phase === 'thinking' && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary-600 dark:text-primary-400" aria-hidden="true" />}
          {label}
        </p>
        {!inCall ? (
          <button onClick={startCall} disabled={phase !== 'idle'} className="inline-flex items-center gap-2 rounded-full bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white px-6 py-3 text-sm font-medium shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2">
            {phase === 'starting' ? <Loader2 className="w-4 h-4 animate-spin" /> : <PhoneCall className="w-4 h-4" />}{turns.length ? 'Call again' : 'Start call'}
          </button>
        ) : (
          <div className="flex items-start justify-center gap-10 pt-1">
            <button onClick={() => setMuted((m) => !m)} aria-pressed={muted} className="group flex flex-col items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300 focus:outline-none">
              <span className={`flex items-center justify-center w-14 h-14 rounded-full border shadow-sm transition-colors group-focus-visible:ring-2 group-focus-visible:ring-primary-400 ${muted ? 'bg-amber-100 border-amber-300 text-amber-900 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-200' : 'bg-white hover:bg-neutral-50 dark:bg-neutral-800 dark:hover:bg-neutral-700 border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200'}`}>
                {muted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
              </span>
              {muted ? 'Unmute' : 'Mute'}
            </button>
            <button onClick={stopEverything} className="group flex flex-col items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300 focus:outline-none">
              <span className="flex items-center justify-center w-14 h-14 rounded-full bg-rose-600 group-hover:bg-rose-700 text-white shadow-md transition-colors group-focus-visible:ring-2 group-focus-visible:ring-rose-400 group-focus-visible:ring-offset-2">
                <PhoneOff className="w-6 h-6" />
              </span>
              End call
            </button>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400 text-center" role="alert">{error}</p>}

      {current.length > 0 && (
        <div className="space-y-2">
          {current.map((t, i) => <Bubble key={i} turn={t} agentId={agentId} onPlayRecording={playRecording} onReplay={replay} canReplay={(id) => turnAudio.current.has(id)} onShowRun={onShowRun} onCompare={compareTurn} />)}
        </div>
      )}

      {turns.length > 0 && !inCall && (
        <div className="flex justify-center">
          <button onClick={() => { setTurns([]); setError(null); conversationId.current = crypto.randomUUID() }} className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 underline">
            Clear this conversation
          </button>
        </div>
      )}

      {earlier.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300">Earlier in this conversation ({earlier.length})</summary>
          <div className="mt-2 space-y-2 max-h-72 overflow-auto pr-1">
            {earlier.map((t, i) => <Bubble key={i} turn={t} agentId={agentId} onPlayRecording={playRecording} onReplay={replay} canReplay={(id) => turnAudio.current.has(id)} onShowRun={onShowRun} onCompare={compareTurn} muted />)}
          </div>
        </details>
      )}

      {!inCall && <TranscriberCompare agentId={agentId} micId={micId || undefined} />}
    </section>
  )
}

function Bubble({ turn, agentId, onPlayRecording, onReplay, canReplay, onShowRun, onCompare, muted }: { turn: Turn; agentId: string; onPlayRecording: (src: string) => void; onReplay: (turnId: number) => void; canReplay: (turnId: number) => boolean; onShowRun?: (runId: string) => void; onCompare?: (turn: Turn) => void; muted?: boolean }) {
  const you = turn.who === 'you'
  // While it is being said: the words said so far; after it was cut off, the rest dimmed.
  const words = turn.shown === undefined ? null : splitWords(turn.text)
  const typing = words !== null && !turn.cut
  return (
    <div className={`flex flex-col ${you ? 'items-end' : 'items-start'} gap-2`}>
      <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${you ? 'bg-primary-600 text-white' : 'bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 border border-neutral-200 dark:border-neutral-700'} ${muted ? 'opacity-80' : ''}`}>
        {words === null ? (
          <p className="whitespace-pre-wrap break-words">{turn.text}</p>
        ) : (
          <p className="whitespace-pre-wrap break-words">
            {words.slice(0, turn.shown).join(' ')}
            {typing && <span className="ml-0.5 inline-block w-1.5 h-3.5 align-[-2px] rounded-sm bg-current opacity-50 motion-safe:animate-pulse" aria-hidden="true" />}
            {turn.cut && turn.shown! < words.length && (
              <span className="text-neutral-400 dark:text-neutral-500" title="Not said: the answer was stopped here">{turn.shown ? ' ' : ''}{words.slice(turn.shown).join(' ')}</span>
            )}
          </p>
        )}
        <p className={`mt-1 flex flex-wrap items-center gap-3 text-xs ${you ? 'text-primary-100' : 'text-neutral-500 dark:text-neutral-400'}`}>
          {you && turn.recordingUrl && <button onClick={() => onPlayRecording(turn.recordingUrl!)} className="inline-flex items-center gap-1 underline"><Play className="w-3 h-3" />Play my recording</button>}
          {you && turn.recordingUrl && onCompare && !turn.comparison && (
            <button onClick={() => onCompare(turn)} disabled={turn.comparing} className="inline-flex items-center gap-1 underline disabled:no-underline">
              {turn.comparing && <Loader2 className="w-3 h-3 animate-spin" />}{turn.comparing ? 'Comparing…' : 'Compare transcribers'}
            </button>
          )}
          {!you && !typing && turn.id !== undefined && canReplay(turn.id) ? <button onClick={() => onReplay(turn.id!)} className="inline-flex items-center gap-1 underline"><Volume2 className="w-3 h-3" />Play again</button> : null}
          {!you && turn.runId && (onShowRun
            ? <button onClick={() => onShowRun(turn.runId!)} className="underline">See how it answered</button>
            : <Link href={`/dashboard/agents/${agentId}?run=${encodeURIComponent(turn.runId)}`} className="underline">See how it answered</Link>)}
          {turn.note && <span>{turn.note}</span>}
        </p>
      </div>
      {turn.comparison && <div className="w-full"><ComparisonResults results={turn.comparison} /></div>}
    </div>
  )
}
