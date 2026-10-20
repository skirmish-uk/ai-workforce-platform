'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, Mic, MicOff, PhoneCall, PhoneOff, Play, Volume2 } from 'lucide-react'

interface Turn {
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

// Voice activity detection (tuned by ear in a quiet office with a laptop mic and with a headset).
const TICK_MS = 50
/** Consecutive loud ticks before speech counts: 150 ms normally, 250 ms to interrupt the agent. */
const START_TICKS = 3
const BARGE_IN_TICKS = 5
/** Silence that ends the caller's turn. */
const END_SILENCE_MS = 800
const MIN_UTTERANCE_MS = 500
const MAX_UTTERANCE_MS = 30_000

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

  const canvas = useRef<HTMLCanvasElement | null>(null)
  const ctx = useRef<AudioContext | null>(null)
  /** The agent's voice, for the waveform while it speaks. */
  const playerAnalyser = useRef<AnalyserNode | null>(null)
  /** The caller's microphone: voice detection and the waveform while listening. */
  const micAnalyser = useRef<AnalyserNode | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const player = useRef<HTMLAudioElement | null>(null)
  const vadTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const recordingUrls = useRef<string[]>([])
  // Mirrors for the detection loop, which runs outside React renders.
  const phaseRef = useRef<Phase>('idle')
  const inCallRef = useRef(false)
  const mutedRef = useRef(false)
  const turnsRef = useRef<Turn[]>([])
  const vad = useRef({ floor: 0.01, loudTicks: 0, silenceMs: 0, startedAt: 0, peak: 0 })

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
  const play = (audio?: string | null, mimeType?: string | null, src?: string) => {
    const url = src ?? (audio && mimeType ? `data:${mimeType};base64,${audio}` : null)
    if (!url) {
      if (inCallRef.current) setPhaseBoth('listening')
      return
    }
    player.current?.pause()
    const el = new Audio(url)
    player.current = el
    const context = audioContext()
    try { context.createMediaElementSource(el).connect(playerAnalyser.current!) } catch { /* already connected */ }
    const done = () => {
      if (player.current !== el) return
      if (phaseRef.current === 'speaking' || phaseRef.current === 'starting') setPhaseBoth(inCallRef.current ? 'listening' : 'idle')
    }
    el.onplay = () => { if (phaseRef.current !== 'hearing') setPhaseBoth('speaking') }
    el.onended = done
    el.onerror = done
    el.play().catch(done)
  }

  // ---- one utterance: start recording when speech begins, stop after a pause
  const beginUtterance = () => {
    if (!stream.current) return
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
    if (recorder.current?.state === 'recording') {
      setPhaseBoth('thinking')
      recorder.current.stop()
    }
  }

  /** Speaking over the agent: stop it mid-sentence and listen. */
  const bargeIn = () => {
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
      if (p === 'hearing') { recorder.current?.stop(); recorder.current = null; setPhaseBoth('listening') }
      return
    }
    const buf = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    const rms = Math.sqrt(sum / buf.length)
    const v = vad.current

    if (p === 'listening' || p === 'speaking' || p === 'thinking') {
      // Learn the room's background level while it's quiet.
      if (p === 'listening' && rms < v.floor * 1.6) v.floor = Math.max(0.002, v.floor * 0.95 + rms * 0.05)
      // Interrupting needs clearly louder, longer speech, so the agent's own voice from the
      // speakers (mostly removed by echo cancellation) doesn't cut it off.
      const threshold = p === 'speaking' ? Math.max(0.05, v.floor * 6) : Math.max(0.015, v.floor * 3)
      v.loudTicks = rms > threshold ? v.loudTicks + 1 : 0
      if (v.loudTicks >= (p === 'speaking' ? BARGE_IN_TICKS : START_TICKS)) {
        v.loudTicks = 0
        if (p === 'speaking') bargeIn()
        beginUtterance()
      }
    } else if (p === 'hearing') {
      v.peak = Math.max(v.peak, rms)
      v.silenceMs = rms < Math.max(0.012, v.floor * 2.2) ? v.silenceMs + TICK_MS : 0
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
    try {
      const res = await fetch(`/api/agents/${agentId}/voice`, { method: 'POST', body: form })
      const body: VoiceResponse = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      if (!inCallRef.current) return
      if (body.status === 'no_speech') {
        // Nothing intelligible: don't make the agent say "sorry?" to background noise.
        setPhaseBoth('listening')
        return
      }
      const unclear = body.status === 'unclear'
      setTurns((prev) => [
        ...prev,
        { who: 'you', text: body.transcript || '(nothing heard)', recordingUrl, note: unclear ? 'Not understood clearly, so it wasn’t sent to the agent.' : undefined },
        { who: 'agent', text: body.reply ?? '', runId: unclear ? null : body.runId, status: body.status, audio: body.audio, mimeType: body.mimeType, note: body.ttsError ? `Speech unavailable: ${body.ttsError}` : undefined },
      ])
      // The caller may have started talking again while the agent was thinking.
      if (phaseRef.current === 'thinking') play(body.audio, body.mimeType)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
      if (inCallRef.current) setPhaseBoth('listening')
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
      micAnalyser.current = context.createAnalyser()
      micAnalyser.current.fftSize = 1024
      micAnalyser.current.smoothingTimeConstant = 0.6
      context.createMediaStreamSource(s).connect(micAnalyser.current) // detection only; never to the speakers
      vad.current = { floor: 0.01, loudTicks: 0, silenceMs: 0, startedAt: 0, peak: 0 }

      const res = await fetch(`/api/agents/${agentId}/voice`)
      const body: VoiceResponse = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
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
          {current.map((t, i) => <Bubble key={i} turn={t} agentId={agentId} onPlay={play} onShowRun={onShowRun} />)}
        </div>
      )}

      {turns.length > 0 && !inCall && (
        <div className="flex justify-center">
          <button onClick={() => { setTurns([]); setError(null) }} className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 underline">
            Clear this conversation
          </button>
        </div>
      )}

      {earlier.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300">Earlier in this conversation ({earlier.length})</summary>
          <div className="mt-2 space-y-2 max-h-72 overflow-auto pr-1">
            {earlier.map((t, i) => <Bubble key={i} turn={t} agentId={agentId} onPlay={play} onShowRun={onShowRun} muted />)}
          </div>
        </details>
      )}
    </section>
  )
}

function Bubble({ turn, agentId, onPlay, onShowRun, muted }: { turn: Turn; agentId: string; onPlay: (audio?: string | null, mime?: string | null, src?: string) => void; onShowRun?: (runId: string) => void; muted?: boolean }) {
  const you = turn.who === 'you'
  return (
    <div className={`flex ${you ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${you ? 'bg-primary-600 text-white' : 'bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 border border-neutral-200 dark:border-neutral-700'} ${muted ? 'opacity-80' : ''}`}>
        <p className="whitespace-pre-wrap break-words">{turn.text}</p>
        <p className={`mt-1 flex flex-wrap items-center gap-3 text-xs ${you ? 'text-primary-100' : 'text-neutral-500 dark:text-neutral-400'}`}>
          {you && turn.recordingUrl && <button onClick={() => onPlay(null, null, turn.recordingUrl)} className="inline-flex items-center gap-1 underline"><Play className="w-3 h-3" />Play my recording</button>}
          {!you && turn.audio && <button onClick={() => onPlay(turn.audio, turn.mimeType)} className="inline-flex items-center gap-1 underline"><Volume2 className="w-3 h-3" />Play again</button>}
          {!you && turn.runId && (onShowRun
            ? <button onClick={() => onShowRun(turn.runId!)} className="underline">See how it answered</button>
            : <Link href={`/dashboard/agents/${agentId}?run=${encodeURIComponent(turn.runId)}`} className="underline">See how it answered</Link>)}
          {turn.note && <span>{turn.note}</span>}
        </p>
      </div>
    </div>
  )
}
