'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, Mic, PhoneCall, Play, Square, Volume2 } from 'lucide-react'

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

type Phase = 'idle' | 'starting' | 'recording' | 'thinking' | 'speaking'

/** Peak level (0–1) below which a whole recording is treated as silence and not sent. */
const SILENCE_PEAK = 0.04
const MIC_STORAGE_KEY = 'voice-mic-device'

/** Picks a recording format the browser supports and the transcription API accepts. */
function recorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return undefined
}

/**
 * Turn-based voice conversation with an agent. A waveform shows the agent's voice while
 * it speaks and your microphone level while you talk; the current exchange sits directly
 * under it. Each turn is a normal agent run.
 */
export function VoicePanel({ agentId, agentName, onShowRun }: { agentId: string; agentName: string; onShowRun?: (runId: string) => void }) {
  const first = agentName.split(/\s+[-–]\s+|\s+/)[0]
  const [turns, setTurns] = useState<Turn[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [started, setStarted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [micId, setMicId] = useState<string>('')

  const canvas = useRef<HTMLCanvasElement | null>(null)
  const ctx = useRef<AudioContext | null>(null)
  const analyser = useRef<AnalyserNode | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const peak = useRef(0)
  const player = useRef<HTMLAudioElement | null>(null)
  const phaseRef = useRef<Phase>('idle')
  const recordingUrls = useRef<string[]>([])

  useEffect(() => { phaseRef.current = phase }, [phase])

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
  useEffect(() => { if (typeof navigator !== "undefined" && navigator.mediaDevices) void loadMics() }, [loadMics])

  const chooseMic = (id: string) => {
    setMicId(id)
    try { localStorage.setItem(MIC_STORAGE_KEY, id) } catch { /* storage unavailable */ }
  }

  // ---- audio graph: one context, one analyser feeding the waveform
  const audioGraph = () => {
    if (!ctx.current) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      ctx.current = new AC()
      analyser.current = ctx.current.createAnalyser()
      analyser.current.fftSize = 1024
      analyser.current.smoothingTimeConstant = 0.75
    }
    void ctx.current.resume()
    return { context: ctx.current, node: analyser.current! }
  }

  // ---- waveform drawing loop
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
      const active = phaseRef.current === 'speaking' || phaseRef.current === 'recording'
      g.fillStyle = phaseRef.current === 'recording' ? style.getPropertyValue('--wave-you') : style.getPropertyValue('--wave-agent')

      const bars = Math.max(24, Math.floor(w / 7))
      const bw = Math.max(2, w / bars - 3)
      let levels: number[]
      if (active && analyser.current) {
        analyser.current.getByteFrequencyData(data)
        // Voice energy sits in the lower bins; mirror it so the shape is centred.
        const half = Math.ceil(bars / 2)
        const usable = Math.floor(data.length * 0.45)
        const side = Array.from({ length: half }, (_, i) => data[Math.floor((i / half) * usable)] / 255)
        levels = [...side.slice().reverse(), ...side].slice(0, bars)
        if (phaseRef.current === 'recording') {
          const level = Math.max(...side)
          if (level > peak.current) peak.current = level
        }
      } else {
        // Idle: a slow, low "breathing" line; thinking: a travelling pulse.
        const thinking = phaseRef.current === 'thinking' || phaseRef.current === 'starting'
        levels = Array.from({ length: bars }, (_, i) => {
          if (reduceMotion) return 0.06
          if (thinking) return 0.08 + 0.35 * Math.max(0, Math.sin((i / bars) * Math.PI * 2 - t / 220)) ** 6
          return 0.05 + 0.03 * Math.sin(i / 3 + t / 900)
        })
      }
      levels.forEach((v, i) => {
        const bh = Math.max(3, v * (h - 8))
        const x = i * (w / bars) + 1.5
        const y = (h - bh) / 2
        g.beginPath()
        g.roundRect(x, y, bw, bh, bw / 2)
        g.fill()
      })
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => () => {
    recorder.current?.stream.getTracks().forEach((t) => t.stop())
    player.current?.pause()
    recordingUrls.current.forEach((u) => URL.revokeObjectURL(u))
    void ctx.current?.close()
  }, [])

  // ---- playback through the analyser, so the waveform follows the agent's voice
  const play = (audio?: string | null, mimeType?: string | null, src?: string) => {
    const url = src ?? (audio && mimeType ? `data:${mimeType};base64,${audio}` : null)
    if (!url) return
    player.current?.pause()
    const el = new Audio(url)
    player.current = el
    const { context, node } = audioGraph()
    try {
      const source = context.createMediaElementSource(el)
      source.connect(node)
      node.connect(context.destination)
    } catch { /* already connected */ }
    el.onplay = () => setPhase((p) => (p === 'recording' ? p : 'speaking'))
    el.onended = el.onpause = () => setPhase((p) => (p === 'speaking' ? 'idle' : p))
    el.play().catch(() => setPhase('idle'))
  }

  const start = async () => {
    setError(null)
    audioGraph() // created inside the click, so the browser lets it play sound
    setPhase('starting')
    try {
      const res = await fetch(`/api/agents/${agentId}/voice`)
      const body: VoiceResponse = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setTurns([{ who: 'agent', text: body.greeting ?? '', audio: body.audio, mimeType: body.mimeType, note: body.ttsError ? `Speech unavailable: ${body.ttsError}` : undefined }])
      setStarted(true)
      setPhase('idle')
      play(body.audio, body.mimeType)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the conversation')
      setPhase('idle')
    }
  }

  const record = async () => {
    setError(null)
    audioGraph()
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('This browser cannot record audio. Try a current Chrome, Edge, Firefox or Safari.')
      return
    }
    try {
      player.current?.pause()
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...(micId ? { deviceId: { exact: micId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      void loadMics() // labels become available after the first permission grant
      const { context, node } = audioGraph()
      try { node.disconnect() } catch { /* not connected */ }
      context.createMediaStreamSource(stream).connect(node) // meter only; never to the speakers
      peak.current = 0
      const mimeType = recorderMimeType()
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunks.current = []
      rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data) }
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        try { node.disconnect() } catch { /* fine */ }
        void send(new Blob(chunks.current, { type: rec.mimeType || mimeType || 'audio/webm' }), peak.current)
      }
      recorder.current = rec
      rec.start()
      setPhase('recording')
    } catch (e) {
      const name = e instanceof DOMException ? e.name : ''
      setError(
        name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the browser’s site settings and try again.'
          : name === 'OverconstrainedError' || name === 'NotFoundError' ? 'That microphone isn’t available. Pick another one from the list.'
          : 'Could not start the microphone.'
      )
      setPhase('idle')
    }
  }

  const stop = () => {
    if (recorder.current?.state === 'recording') {
      setPhase('thinking')
      recorder.current.stop()
    }
  }

  const send = async (audio: Blob, loudest: number) => {
    const recordingUrl = URL.createObjectURL(audio)
    recordingUrls.current.push(recordingUrl)
    if (audio.size < 1000 || loudest < SILENCE_PEAK) {
      setPhase('idle')
      setTurns((prev) => [...prev, { who: 'you', text: '(not sent: nothing was heard)', recordingUrl }])
      setError(`The microphone picked up almost nothing${mics.length > 1 ? '. Check that the right microphone is selected above' : ''}, then try again. Use “Play my recording” to hear what it captured.`)
      return
    }
    const form = new FormData()
    form.append('audio', audio, 'utterance')
    try {
      const res = await fetch(`/api/agents/${agentId}/voice`, { method: 'POST', body: form })
      const body: VoiceResponse = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      const unclear = body.status === 'unclear'
      setTurns((prev) => [
        ...prev,
        { who: 'you', text: body.transcript || '(nothing heard)', recordingUrl, note: unclear ? 'Not understood clearly, so it wasn’t sent to the agent.' : undefined },
        { who: 'agent', text: body.reply ?? '', runId: unclear ? null : body.runId, status: body.status, audio: body.audio, mimeType: body.mimeType, note: body.ttsError ? `Speech unavailable: ${body.ttsError}` : undefined },
      ])
      setPhase('idle')
      play(body.audio, body.mimeType)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
      setPhase('idle')
    }
  }

  // ---- the current exchange (latest of yours + latest of the agent's) and earlier history
  const last = turns.length - 1
  const pairStart = last > 0 && turns[last].who === 'agent' && turns[last - 1].who === 'you' ? last - 1 : last
  const current = last < 0 ? [] : turns.slice(pairStart)
  const earlier = turns.slice(0, Math.max(0, pairStart)).reverse()

  const label =
    phase === 'recording' ? 'Listening… tap Stop when you’ve finished'
      : phase === 'thinking' ? `${first} is thinking…`
      : phase === 'speaking' ? `${first} is speaking`
      : phase === 'starting' ? 'Connecting…'
      : started ? 'Tap to talk' : `Start a voice conversation with ${first}`

  return (
    <section
      aria-label={`Talk to ${first}`}
      className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-gradient-to-b from-primary-50/70 to-white dark:from-primary-950/30 dark:to-neutral-900 p-5 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">Talk to {first}</h2>
          <p className="text-xs text-neutral-500">Same agent, rules and knowledge as a typed task. {first} introduces itself as an AI assistant.</p>
        </div>
        {mics.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
            <Mic className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="sr-only">Microphone</span>
            <select
              id="voice-mic"
              value={micId}
              onChange={(e) => chooseMic(e.target.value)}
              disabled={phase === 'recording'}
              className="max-w-[16rem] truncate rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-2 py-1 text-xs"
            >
              <option value="">System default microphone</option>
              {mics.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* Stage: waveform + primary control */}
      <div className="flex flex-col items-center gap-3">
        <canvas
          ref={canvas}
          aria-hidden="true"
          className="w-full h-24 [--wave-agent:theme(colors.primary.500)] [--wave-you:theme(colors.rose.500)] dark:[--wave-agent:theme(colors.primary.400)] dark:[--wave-you:theme(colors.rose.400)]"
        />
        <p className="text-sm text-neutral-600 dark:text-neutral-300 min-h-[1.25rem]" role="status" aria-live="polite">{label}</p>
        {!started ? (
          <button onClick={start} disabled={phase !== 'idle'} className="inline-flex items-center gap-2 rounded-full bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white px-6 py-3 text-sm font-medium shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2">
            {phase === 'starting' ? <Loader2 className="w-4 h-4 animate-spin" /> : <PhoneCall className="w-4 h-4" />}Start conversation
          </button>
        ) : phase === 'recording' ? (
          <button onClick={stop} className="inline-flex items-center gap-2 rounded-full bg-rose-600 hover:bg-rose-700 text-white px-6 py-3 text-sm font-medium shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 focus-visible:ring-offset-2">
            <Square className="w-4 h-4" />Stop and send
          </button>
        ) : (
          <button onClick={record} disabled={phase === 'thinking' || phase === 'starting'} className="inline-flex items-center gap-2 rounded-full bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white px-6 py-3 text-sm font-medium shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2">
            {phase === 'thinking' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}{phase === 'speaking' ? 'Interrupt and talk' : 'Tap to talk'}
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400 text-center" role="alert">{error}</p>}

      {/* Current exchange, right under the waveform */}
      {current.length > 0 && (
        <div className="space-y-2">
          {current.map((t, i) => <Bubble key={i} turn={t} agentId={agentId} onPlay={play} onShowRun={onShowRun} />)}
        </div>
      )}

      {turns.length > 0 && phase === 'idle' && (
        <div className="flex justify-center">
          <button onClick={() => { player.current?.pause(); setTurns([]); setStarted(false); setError(null) }} className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 underline">
            New conversation (clears this chat)
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
        <p className="whitespace-pre-wrap">{turn.text}</p>
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
