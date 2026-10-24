'use client'

import { useEffect, useRef, useState } from 'react'
import { Mic, RotateCcw, Square } from 'lucide-react'

/**
 * Records a speaker reading the voice-cloning script (consent statement first) and hands back a
 * WAV take. Used on the agent page ("Use your own voice") and in the new-agent form. Uploading is
 * the caller's job: POST /api/agents/[id]/voice/clone.
 */
export interface VoiceTake {
  wav: Blob
  seconds: number
  speakerName: string
}

export interface CloneSetup {
  available: boolean
  canChange: boolean
  businessName: string
  minSeconds: number
  maxSeconds: number
  /** Script lines; "{name}" is replaced with the speaker's name. */
  script: string[]
}

const WAV_RATE = 24000

/** Decodes whatever the browser recorded and re-encodes it as 16-bit mono WAV, which Cartesia accepts and the server can measure. */
export async function toWav(recording: Blob): Promise<{ wav: Blob; seconds: number; peak: number }> {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const decoder = new AC()
  const decoded = await decoder.decodeAudioData(await recording.arrayBuffer())
  void decoder.close()
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * WAV_RATE)), WAV_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const samples = (await offline.startRendering()).getChannelData(0)
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const text = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)) }
  text(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE')
  text(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true)
  out.setUint32(24, WAV_RATE, true); out.setUint32(28, WAV_RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true)
  text(36, 'data'); out.setUint32(40, samples.length * 2, true)
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    peak = Math.max(peak, Math.abs(v))
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true)
  }
  return { wav: new Blob([out.buffer], { type: 'audio/wav' }), seconds: samples.length / WAV_RATE, peak }
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** Upload form for a take (consent is confirmed by the recorder before a take exists). */
export function cloneForm(take: VoiceTake): FormData {
  const form = new FormData()
  form.append('audio', take.wav, 'voice.wav')
  form.append('speakerName', take.speakerName)
  form.append('consent', 'yes')
  return form
}

/**
 * Name + consent, the script, record / stop / listen / record again. Calls onTake with a usable
 * take (long enough, not silent, consent given), or null when there isn't one.
 */
export function VoiceRecorder({ setup, onTake, disabled, idPrefix = 'voice' }: { setup: CloneSetup; onTake: (take: VoiceTake | null) => void; disabled?: boolean; idPrefix?: string }) {
  const [name, setName] = useState('')
  const [consent, setConsent] = useState(false)
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [take, setTake] = useState<{ wav: Blob; url: string; seconds: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current)
    recorder.current?.stream.getTracks().forEach((t) => t.stop())
  }, [])
  useEffect(() => () => { if (take) URL.revokeObjectURL(take.url) }, [take])

  // Report a usable take whenever the inputs change (renaming after recording still applies).
  useEffect(() => {
    const usable = take && consent && name.trim().length >= 2 && take.seconds >= setup.minSeconds
    onTake(usable ? { wav: take.wav, seconds: take.seconds, speakerName: name.trim() } : null)
  }, [take, consent, name, setup.minSeconds, onTake])

  const script = setup.script.map((line) => line.replace('{name}', name.trim() || 'your name'))

  const start = async () => {
    setError(null)
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('This browser cannot record audio. Try a current Chrome, Edge, Firefox or Safari.')
      return
    }
    try {
      // Natural sound for cloning: no gain riding or echo processing.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false } })
      const rec = new MediaRecorder(stream)
      chunks.current = []
      rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        if (timer.current) clearInterval(timer.current)
        setRecording(false)
        try {
          const converted = await toWav(new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' }))
          if (converted.peak < 0.05) {
            setError('The microphone picked up almost nothing. Check it is the right one and not muted, then record again.')
            return
          }
          setTake({ wav: converted.wav, url: URL.createObjectURL(converted.wav), seconds: converted.seconds })
        } catch {
          setError('Could not read the recording. Try again, or use a different browser.')
        }
      }
      recorder.current = rec
      rec.start()
      setTake(null)
      setElapsed(0)
      const started = Date.now()
      timer.current = setInterval(() => {
        const s = (Date.now() - started) / 1000
        setElapsed(s)
        if (s >= Math.min(setup.maxSeconds, 90) && rec.state === 'recording') rec.stop()
      }, 200)
      setRecording(true)
    } catch (e) {
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the browser’s site settings and try again.' : 'Could not start the microphone.')
    }
  }
  const stop = () => { if (recorder.current?.state === 'recording') recorder.current.stop() }
  const tooShort = take !== null && take.seconds < setup.minSeconds
  const locked = disabled || recording

  return (
    <div className="space-y-4">
      <ol className="text-sm text-neutral-600 dark:text-neutral-300 list-decimal pl-5 space-y-1">
        <li>Find a quiet room and use a decent microphone or headset.</li>
        <li>Read the script below at your normal pace, the way you would talk to a caller (about 30–40 seconds).</li>
        <li>Listen back. Cartesia keeps a private copy of the voice; it can be removed from the agent&apos;s page at any time.</li>
      </ol>

      <label className="block text-sm">
        <span className="text-neutral-700 dark:text-neutral-200">Whose voice is this?</span>
        <input id={`${idPrefix}-speaker`} value={name} onChange={(e) => setName(e.target.value)} disabled={locked} placeholder="Full name" maxLength={200}
          className="mt-1 w-full rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm" />
      </label>
      <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-200">
        <input id={`${idPrefix}-consent`} type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={locked} className="mt-1" />
        <span>I am this person, or I have their written permission, and they agree to their voice being copied by Cartesia and used by {setup.businessName}&apos;s AI assistant, which always tells callers it is an AI.</span>
      </label>

      <div className="rounded-xl bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-200 dark:border-neutral-700 p-4 space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Read this aloud</p>
        {script.map((line, i) => (
          <p key={i} className={`text-base leading-relaxed ${i === 0 ? 'font-medium text-neutral-900 dark:text-neutral-50' : 'text-neutral-800 dark:text-neutral-200'}`}>{line}</p>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {!recording && !take && (
          <button type="button" onClick={start} disabled={disabled || name.trim().length < 2 || !consent} className="inline-flex items-center gap-2 rounded-full bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white px-5 py-2.5 text-sm font-medium">
            <Mic className="w-4 h-4" />Start recording
          </button>
        )}
        {recording && (
          <>
            <button type="button" onClick={stop} className="inline-flex items-center gap-2 rounded-full bg-rose-600 hover:bg-rose-700 text-white px-5 py-2.5 text-sm font-medium">
              <Square className="w-4 h-4" />Stop
            </button>
            <span className="text-sm tabular-nums text-neutral-700 dark:text-neutral-200" role="status" aria-live="polite">
              <span className="inline-block w-2 h-2 rounded-full bg-rose-600 animate-pulse mr-2" aria-hidden="true" />Recording {fmt(elapsed)}
              {elapsed < setup.minSeconds ? ` (at least ${setup.minSeconds} s)` : ''}
            </span>
          </>
        )}
        {!recording && take && (
          <>
            <audio src={take.url} controls className="h-10 max-w-full" />
            <span className="text-sm text-neutral-600 dark:text-neutral-300 tabular-nums">{fmt(take.seconds)}</span>
            <button type="button" onClick={start} disabled={disabled || name.trim().length < 2 || !consent} className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm disabled:opacity-60">
              <RotateCcw className="w-4 h-4" />Record again
            </button>
          </>
        )}
      </div>
      {tooShort && <p className="text-sm text-amber-700 dark:text-amber-400">That recording is under {setup.minSeconds} seconds. Read the whole script and record again.</p>}
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
    </div>
  )
}
