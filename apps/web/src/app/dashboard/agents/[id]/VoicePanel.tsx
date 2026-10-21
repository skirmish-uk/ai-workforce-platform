'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, Mic, MicOff, PhoneCall, PhoneOff, Play, Volume2 } from 'lucide-react'

interface Clip { audio: string; mimeType: string }

interface Turn {
  /** Agent turns of a streamed answer: which turn the incoming sentences belong to. */
  id?: number
  /** A streamed answer's sentences, in order ("Play again" plays them all). */
  clips?: Clip[]
  who: 'you' | 'agent'
  text: string
  runId?: string | null
  status?: string
  audio?: string | null
  mimeType?: string | null
  /** Your own recording, kept in this tab only so you can hear what was sent. */
  recordingUrl?: string
  note?: string
}

interface VoiceResponse {
  transcript?: string
  confidence?: number | null
  reply?: string
  greeting?: string
  status?: string
  runId?: string | null
  audio?: string | null
  mimeType?: string | null
  ttsError?: string
  error?: string
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
 * Interrupting the agent: after DUCK_TICKS loud ticks its voice is turned down to DUCK_LEVEL.
 * Its echo drops with it and a person talking doesn't, so CONFIRM_TICKS still-loud ticks
 * after DUCK_SETTLE_TICKS stop it (about 0.3 s in all). Otherwise it is back to full volume
 * within DUCK_MAX_TICKS (a brief dip).
 */
const DUCK_TICKS = 2
const DUCK_LEVEL = 0.25
const DUCK_SETTLE_TICKS = 2
const CONFIRM_TICKS = 2
const DUCK_MAX_TICKS = 7
/** Quietest level counted as speech: low for quiet laptop and webcam mics (speech measured at 0.01–0.03 RMS). */
const MIN_SPEECH_LEVEL = 0.006
/** Silence that ends the caller's turn. */
const END_SILENCE_MS = 650
/** No answer audio this long after the caller stops: say a short acknowledgement. */
const FILLER_AFTER_MS = 600
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
/** Sample rate sent for transcription: plenty for speech, a third of a 48 kHz upload. */
const WAV_RATE = 16_000
/** Quiet microphones are raised to a normal level, by at most this much (more only lifts noise). */
const MAX_BOOST = 8
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

/**
 * One turn as 16-bit mono WAV at WAV_RATE: trailing silence trimmed, resampled (block average),
 * and a quiet microphone brought up to a normal level.
 */
function encodeWav(blocks: Float32Array[], rate: number, trimEndMs: number): Blob {
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
export function VoicePanel({ agentId, agentName, onShowRun }: { agentId: string; agentName: string; onShowRun?: (runId: string) => void }) {
  const first = agentName.split(/\s+[-–]\s+|\s+/)[0]
  const [turns, setTurns] = useState<Turn[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [inCall, setInCall] = useState(false)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [micId, setMicId] = useState<string>('')
  const [volume, setVolume] = useState(DEFAULT_VOLUME)
  const volumeRef = useRef(DEFAULT_VOLUME)
  const playerInput = useRef<AudioNode | null>(null)
  const playerGain = useRef<GainNode | null>(null)

  const canvas = useRef<HTMLCanvasElement | null>(null)
  const ctx = useRef<AudioContext | null>(null)
  /** The agent's voice, for the waveform while it speaks. */
  const playerAnalyser = useRef<AnalyserNode | null>(null)
  /** The caller's microphone: voice detection and the waveform while listening. */
  const micAnalyser = useRef<AnalyserNode | null>(null)
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
  const vad = useRef({ floor: 0.01, loudTicks: 0, silenceMs: 0, startedAt: 0, peak: 0, echoCoupling: INITIAL_ECHO_COUPLING, playerLevel: 0, ducked: false, duckTicks: 0, suspectAt: 0, played: [] as number[], suspectRatio: 0 })

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

  // ---- waveform: the caller's mic while listening/hearing, the agent's voice while speaking
  useEffect(() => {
    let frame = 0
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const data = new Uint8Array(512)
    const draw = (t: number) => {
      frame = requestAnimationFrame(draw)
      const c = canvas.current
      if (!c) return
      const dpr = window.devicePixelRatio || 1
      const w = c.clientWidth, h = c.clientHeight
      if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr }
      const g = c.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)
      const style = getComputedStyle(c)
      const p = phaseRef.current
      const source = p === 'speaking' ? playerAnalyser.current : p === 'hearing' || p === 'listening' ? micAnalyser.current : null
      g.fillStyle = p === 'hearing' || p === 'listening' ? style.getPropertyValue('--wave-you') : style.getPropertyValue('--wave-agent')
      const bars = Math.max(24, Math.floor(w / 7))
      const bw = Math.max(2, w / bars - 3)
      let levels: number[]
      if (source && (p !== 'listening' || !mutedRef.current)) {
        source.getByteFrequencyData(data)
        const half = Math.ceil(bars / 2)
        const usable = Math.floor(data.length * 0.45)
        const side = Array.from({ length: half }, (_, i) => data[Math.floor((i / half) * usable)] / 255)
        levels = [...side.slice().reverse(), ...side].slice(0, bars)
        if (p === 'listening') levels = levels.map((v) => Math.max(0.05, v * 0.6))
      } else {
        const thinking = p === 'thinking' || p === 'starting'
        levels = Array.from({ length: bars }, (_, i) => {
          if (reduceMotion) return 0.06
          if (thinking) return 0.08 + 0.35 * Math.max(0, Math.sin((i / bars) * Math.PI * 2 - t / 220)) ** 6
          return 0.05 + 0.03 * Math.sin(i / 3 + t / 900)
        })
      }
      levels.forEach((v, i) => {
        const bh = Math.max(3, v * (h - 8))
        g.beginPath()
        g.roundRect(i * (w / bars) + 1.5, (h - bh) / 2, bw, bh, bw / 2)
        g.fill()
      })
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])

  // ---- agent speech, routed through the analyser so the waveform follows it
  const play = (audio?: string | null, mimeType?: string | null, src?: string, onDone?: () => void) => {
    const url = src ?? (audio && mimeType ? `data:${mimeType};base64,${audio}` : null)
    if (!url) {
      if (onDone) onDone()
      else if (inCallRef.current) setPhaseBoth('listening')
      return
    }
    player.current?.pause()
    const el = new Audio(url)
    player.current = el
    const context = audioContext()
    try { context.createMediaElementSource(el).connect(playerInput.current ?? playerAnalyser.current!) } catch { /* already connected */ }
    const done = () => {
      if (player.current !== el) return
      if (onDone) return onDone()
      if (phaseRef.current === 'speaking' || phaseRef.current === 'starting') setPhaseBoth(inCallRef.current ? 'listening' : 'idle')
    }
    el.onplay = () => { if (phaseRef.current !== 'hearing') setPhaseBoth('speaking') }
    el.onended = done
    el.onerror = done
    el.play().catch(done)
  }

  const playClips = (clips: Clip[]) => {
    const [first, ...rest] = clips
    if (!first) return
    play(first.audio, first.mimeType, undefined, rest.length ? () => playClips(rest) : undefined)
  }

  /**
   * The answer being streamed in: sentences queue here and play back to back. Bumping
   * activeTurn (when the caller talks over it, or starts talking while it is still coming in)
   * stops the rest of that answer from playing; its text still fills in.
   */
  const activeTurn = useRef(0)
  const clipQueue = useRef<Clip[]>([])
  const clipPlaying = useRef(false)
  const answerDone = useRef(true)
  /** "Mm-hm." / "Okay." in the agent's voice, played when an answer is slow to start. */
  const fillers = useRef<Clip[]>([])
  const lastFiller = useRef(-1)
  const pumpClips = (turn: number) => {
    if (turn !== activeTurn.current || clipPlaying.current) return
    const clip = clipQueue.current.shift()
    if (!clip) {
      if (answerDone.current && inCallRef.current && (phaseRef.current === 'speaking' || phaseRef.current === 'thinking')) setPhaseBoth('listening')
      return
    }
    clipPlaying.current = true
    play(clip.audio, clip.mimeType, undefined, () => {
      clipPlaying.current = false
      pumpClips(turn)
    })
  }
  const cancelAnswer = () => {
    activeTurn.current++
    clipQueue.current = []
    clipPlaying.current = false
  }

  // ---- one utterance: start recording when speech begins, stop after a pause
  const beginUtterance = (interrupting = false) => {
    if (!stream.current) return
    interruptedTurn.current = interrupting
    // Talking again before the answer has finished arriving: the caller has moved on.
    cancelAnswer()
    vad.current.startedAt = Date.now()
    vad.current.silenceMs = 0
    vad.current.peak = 0
    if (capture.current) {
      const rate = capture.current.rate
      const ms = interrupting ? Math.min(BARGE_IN_PRE_ROLL_MS, Date.now() - vad.current.suspectAt + BARGE_IN_LEAD_MS) : PRE_ROLL_MS
      const keep = Math.ceil(((ms / 1000) * rate) / 2048)
      captured.current = preRoll.current.slice(-keep)
      preRoll.current = []
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
      // About 0.3 s of sound after trimming: a cough or a click, not a sentence.
      if (wav.size < 44 + WAV_RATE * 0.6) { if (inCallRef.current) setPhaseBoth('listening'); return }
      void send(wav)
      return
    }
    if (recorder.current?.state === 'recording') {
      setPhaseBoth('thinking')
      recorder.current.stop()
    }
  }

  /** Turns the agent's voice down while checking whether the caller is talking over it. */
  const duck = (down: boolean) => {
    vad.current.ducked = down
    vad.current.duckTicks = 0
    const gain = playerGain.current
    if (gain && ctx.current) gain.gain.setTargetAtTime(down ? volumeRef.current * DUCK_LEVEL : volumeRef.current, ctx.current.currentTime, 0.015)
  }

  /** Speaking over the agent: stop it mid-sentence and listen. */
  const bargeIn = () => {
    duck(false) // full volume again for the next answer
    cancelAnswer()
    player.current?.pause()
    player.current = null
    setTurns((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (last?.who === 'agent') next[next.length - 1] = { ...last, note: last.note ?? 'Interrupted' }
      return next
    })
  }

  // ---- the detection loop: level against an adaptive noise floor
  const tick = () => {
    const analyser = micAnalyser.current
    if (!inCallRef.current || !analyser) return
    const p = phaseRef.current
    if (mutedRef.current) {
      if (p === 'hearing') {
        captured.current = null
        if (recorder.current) { recorder.current.onstop = null; recorder.current.stop(); recorder.current = null }
        setPhaseBoth('listening')
      }
      preRoll.current = []
      return
    }
    const rms = levelOf(analyser)
    const v = vad.current
    // An answer that ended (or was replaced) while turned down plays the next one at full volume.
    if (v.ducked && p !== 'speaking') duck(false)

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
      const speech = rms > Math.max(base, echo * SPEECH_OVER_ECHO)

      if (p === 'speaking' && v.ducked) {
        v.duckTicks++
        if (v.duckTicks > DUCK_SETTLE_TICKS) v.loudTicks = speech ? v.loudTicks + 1 : 0
        if (v.loudTicks >= CONFIRM_TICKS) {
          v.loudTicks = 0
          bargeIn()
          beginUtterance(true)
        } else if (v.duckTicks >= DUCK_MAX_TICKS) {
          // It was the agent's own echo, louder than estimated: learn that, so it isn't mistaken again.
          v.echoCoupling = Math.min(1, Math.max(v.echoCoupling, v.suspectRatio))
          duck(false)
          v.loudTicks = 0
        }
      } else if (p === 'speaking') {
        const suspect = rms > Math.max(base, echo * SUSPECT_OVER_ECHO)
        if (!suspect && v.playerLevel > 0.01) v.echoCoupling = Math.min(1, v.echoCoupling * 0.9 + (rms / v.playerLevel) * 0.1)
        // From the first time the caller seemed to talk, even if that check was dropped and retried.
        if (suspect && !v.loudTicks && Date.now() - v.suspectAt > BARGE_IN_PRE_ROLL_MS) v.suspectAt = Date.now()
        if (suspect && !v.loudTicks) v.suspectRatio = 0
        if (suspect && v.playerLevel > 0.01) v.suspectRatio = Math.max(v.suspectRatio, rms / v.playerLevel)
        v.loudTicks = suspect ? v.loudTicks + 1 : 0
        if (v.loudTicks >= DUCK_TICKS) {
          v.loudTicks = 0
          duck(true)
        }
      } else {
        v.loudTicks = speech ? v.loudTicks + 1 : 0
        if (v.loudTicks >= START_TICKS) {
          v.loudTicks = 0
          beginUtterance()
        }
      }
    } else if (p === 'hearing') {
      v.peak = Math.max(v.peak, rms)
      v.silenceMs = rms < Math.max(MIN_SPEECH_LEVEL * 0.8, v.floor * 2.2) ? v.silenceMs + TICK_MS : 0
      const took = Date.now() - v.startedAt
      if ((v.silenceMs >= END_SILENCE_MS && took > MIN_UTTERANCE_MS) || took > MAX_UTTERANCE_MS) endUtterance()
    }
  }

  // ---- send a turn with the conversation so far
  const send = async (audio: Blob) => {
    setPhaseBoth('thinking')
    const recordingUrl = URL.createObjectURL(audio)
    recordingUrls.current.push(recordingUrl)
    const history = turnsRef.current
      .filter((t) => t.text && !t.text.startsWith('('))
      .slice(-8)
      .map((t) => ({ who: t.who === 'you' ? 'caller' : 'agent', text: t.text }))
    const form = new FormData()
    form.append('audio', audio, 'utterance')
    form.append('history', JSON.stringify(history))
    form.append('conversationId', conversationId.current)
    if (interruptedTurn.current) form.append('interrupted', '1')
    const turn = ++activeTurn.current
    clipQueue.current = []
    clipPlaying.current = false
    answerDone.current = false
    // If the answer is slow to start, acknowledge, the way a person says "mm-hm" on a call.
    setTimeout(() => {
      if (turn !== activeTurn.current || clipPlaying.current || clipQueue.current.length || phaseRef.current !== 'thinking' || !fillers.current.length) return
      let pick = Math.floor(Math.random() * fillers.current.length)
      if (pick === lastFiller.current) pick = (pick + 1) % fillers.current.length
      lastFiller.current = pick
      clipQueue.current.push(fillers.current[pick])
      pumpClips(turn)
    }, FILLER_AFTER_MS)
    try {
      const res = await fetch(`/api/agents/${agentId}/voice`, { method: 'POST', body: form })
      if (!res.ok) {
        const body: VoiceResponse = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      if (!(res.headers.get('content-type') ?? '').includes('ndjson')) {
        // Nothing usable was heard: a plain JSON reply.
        const body: VoiceResponse = await res.json()
        answerDone.current = true
        if (!inCallRef.current) return
        if (body.status === 'no_speech') {
          // Don't make the agent say "sorry?" to background noise.
          if (phaseRef.current === 'thinking') setPhaseBoth('listening')
          return
        }
        setTurns((prev) => [
          ...prev,
          { who: 'you', text: body.transcript || '(nothing heard)', recordingUrl, note: 'Not understood clearly, so it wasn’t sent to the agent.' },
          { who: 'agent', text: body.reply ?? '', status: body.status, audio: body.audio, mimeType: body.mimeType },
        ])
        if (phaseRef.current === 'thinking') play(body.audio, body.mimeType)
        return
      }

      // Streamed answer: heard → audio (one event per sentence) → done.
      const update = (fn: (t: Turn) => Turn) => setTurns((prev) => prev.map((t) => (t.who === 'agent' && t.id === turn ? fn(t) : t)))
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
          const event = JSON.parse(line) as { type: string; transcript?: string; runId?: string | null; text?: string; audio?: string | null; mimeType?: string | null; ttsError?: string; status?: string }
          if (event.type === 'heard') {
            setTurns((prev) => [
              ...prev,
              { who: 'you', text: event.transcript || '(nothing heard)', recordingUrl },
              { who: 'agent', id: turn, text: '', runId: event.runId ?? null, clips: [] },
            ])
          } else if (event.type === 'audio') {
            const clip = event.audio && event.mimeType ? { audio: event.audio, mimeType: event.mimeType } : null
            update((t) => ({ ...t, text: t.text ? `${t.text} ${event.text ?? ''}` : event.text ?? '', clips: clip ? [...(t.clips ?? []), clip] : t.clips, note: event.ttsError ? `Speech unavailable: ${event.ttsError}` : t.note }))
            if (clip && turn === activeTurn.current && inCallRef.current) {
              clipQueue.current.push(clip)
              pumpClips(turn)
            }
          } else if (event.type === 'done') {
            update((t) => ({ ...t, status: event.status, runId: event.runId ?? t.runId, text: t.text || '(no answer)' }))
          }
        }
      }
      if (turn === activeTurn.current) {
        answerDone.current = true
        pumpClips(turn) // nothing left to play: back to listening
      }
    } catch (e) {
      answerDone.current = true
      setError(e instanceof Error ? e.message : 'Something went wrong')
      if (inCallRef.current && turn === activeTurn.current) setPhaseBoth('listening')
    }
  }

  // ---- call control
  const startCall = async () => {
    setError(null)
    audioContext() // created inside the click, so the browser lets it play sound
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
      vad.current = { floor: 0.01, loudTicks: 0, silenceMs: 0, startedAt: 0, peak: 0, echoCoupling: INITIAL_ECHO_COUPLING, playerLevel: 0, ducked: false, duckTicks: 0, suspectAt: 0, played: [], suspectRatio: 0 }
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
          if (captured.current) {
            captured.current.push(e.data)
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
      } catch {
        capture.current = null // older browser: MediaRecorder from the moment speech is detected
      }

      const res = await fetch(`/api/agents/${agentId}/voice`)
      const body: VoiceResponse & { fillers?: Clip[] } = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      fillers.current = body.fillers ?? []
      inCallRef.current = true
      setInCall(true)
      setMuted(false)
      setTurns((prev) => [...prev, { who: 'agent', text: body.greeting ?? '', audio: body.audio, mimeType: body.mimeType, note: body.ttsError ? `Speech unavailable: ${body.ttsError}` : undefined }])
      vadTimer.current = setInterval(tick, TICK_MS)
      play(body.audio, body.mimeType)
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

  const stopEverything = () => {
    inCallRef.current = false
    setInCall(false)
    if (vadTimer.current) clearInterval(vadTimer.current)
    vadTimer.current = null
    if (recorder.current?.state === 'recording') { recorder.current.onstop = null; recorder.current.stop() }
    recorder.current = null
    capture.current?.node.disconnect()
    capture.current = null
    captured.current = null
    preRoll.current = []
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    player.current?.pause()
    player.current = null
    setPhaseBoth('idle')
  }

  useEffect(() => () => {
    stopEverything()
    recordingUrls.current.forEach((u) => URL.revokeObjectURL(u))
    void ctx.current?.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      : `Call ${first}: talk naturally, no buttons. A headset works best.`

  return (
    <section
      aria-label={`Talk to ${first}`}
      className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-gradient-to-b from-primary-50/70 to-white dark:from-primary-950/30 dark:to-neutral-900 p-5 space-y-4"
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
        <canvas
          ref={canvas}
          aria-hidden="true"
          className="w-full h-24 [--wave-agent:theme(colors.primary.500)] [--wave-you:theme(colors.rose.500)] dark:[--wave-agent:theme(colors.primary.400)] dark:[--wave-you:theme(colors.rose.400)]"
        />
        <p className="text-sm text-neutral-600 dark:text-neutral-300 min-h-[1.25rem] text-center" role="status" aria-live="polite">{label}</p>
        {!inCall ? (
          <button onClick={startCall} disabled={phase !== 'idle'} className="inline-flex items-center gap-2 rounded-full bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white px-6 py-3 text-sm font-medium shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2">
            {phase === 'starting' ? <Loader2 className="w-4 h-4 animate-spin" /> : <PhoneCall className="w-4 h-4" />}{turns.length ? 'Call again' : 'Start call'}
          </button>
        ) : (
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button onClick={() => setMuted((m) => !m)} aria-pressed={muted} className={`inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-medium border focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${muted ? 'bg-amber-100 border-amber-300 text-amber-900 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-200' : 'bg-white dark:bg-neutral-800 border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200'}`}>
              {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}{muted ? 'Unmute' : 'Mute'}
            </button>
            <button onClick={stopEverything} className="inline-flex items-center gap-2 rounded-full bg-rose-600 hover:bg-rose-700 text-white px-6 py-3 text-sm font-medium shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 focus-visible:ring-offset-2">
              <PhoneOff className="w-4 h-4" />End call
            </button>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400 text-center" role="alert">{error}</p>}

      {current.length > 0 && (
        <div className="space-y-2">
          {current.map((t, i) => <Bubble key={i} turn={t} agentId={agentId} onPlay={play} onPlayClips={playClips} onShowRun={onShowRun} />)}
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
            {earlier.map((t, i) => <Bubble key={i} turn={t} agentId={agentId} onPlay={play} onPlayClips={playClips} onShowRun={onShowRun} muted />)}
          </div>
        </details>
      )}
    </section>
  )
}

function Bubble({ turn, agentId, onPlay, onPlayClips, onShowRun, muted }: { turn: Turn; agentId: string; onPlay: (audio?: string | null, mime?: string | null, src?: string) => void; onPlayClips?: (clips: Clip[]) => void; onShowRun?: (runId: string) => void; muted?: boolean }) {
  const you = turn.who === 'you'
  return (
    <div className={`flex ${you ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${you ? 'bg-primary-600 text-white' : 'bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 border border-neutral-200 dark:border-neutral-700'} ${muted ? 'opacity-80' : ''}`}>
        <p className="whitespace-pre-wrap break-words">{turn.text}</p>
        <p className={`mt-1 flex flex-wrap items-center gap-3 text-xs ${you ? 'text-primary-100' : 'text-neutral-500 dark:text-neutral-400'}`}>
          {you && turn.recordingUrl && <button onClick={() => onPlay(null, null, turn.recordingUrl)} className="inline-flex items-center gap-1 underline"><Play className="w-3 h-3" />Play my recording</button>}
          {!you && (turn.clips?.length || turn.audio) ? <button onClick={() => (turn.clips?.length ? onPlayClips?.(turn.clips) : onPlay(turn.audio, turn.mimeType))} className="inline-flex items-center gap-1 underline"><Volume2 className="w-3 h-3" />Play again</button> : null}
          {!you && turn.runId && (onShowRun
            ? <button onClick={() => onShowRun(turn.runId!)} className="underline">See how it answered</button>
            : <Link href={`/dashboard/agents/${agentId}?run=${encodeURIComponent(turn.runId)}`} className="underline">See how it answered</Link>)}
          {turn.note && <span>{turn.note}</span>}
        </p>
      </div>
    </div>
  )
}
