'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, Mic, Play, RotateCcw, Square, Trash2, Wand2 } from 'lucide-react'

interface CloneStatus {
  available: boolean
  canChange: boolean
  businessName: string
  minSeconds: number
  maxSeconds: number
  voice: { provider: string | null; voiceId: string | null; clonedVoice: { consentFrom: string; consentDate: string } | null }
  script: string[]
}

type Step = 'idle' | 'consent' | 'recording' | 'review' | 'uploading' | 'done'

const WAV_RATE = 24000

/** Decodes whatever the browser recorded and re-encodes it as 16-bit mono WAV, which Cartesia accepts and the server can measure. */
async function toWav(recording: Blob): Promise<{ wav: Blob; seconds: number; peak: number }> {
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

/**
 * "Use your own voice": the speaker reads a short script (starting with a spoken consent
 * statement), and Cartesia makes a private copy of the voice for this agent. Admins only.
 */
export function VoiceClone({ agentId, agentName }: { agentId: string; agentName: string }) {
  const first = agentName.split(/\s+[-–]\s+|\s+/)[0]
  const [status, setStatus] = useState<CloneStatus | null>(null)
  const [step, setStep] = useState<Step>('idle')
  const [name, setName] = useState('')
  const [consent, setConsent] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [take, setTake] = useState<{ wav: Blob; url: string; seconds: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const sample = useRef<HTMLAudioElement | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/voice/clone`)
      if (res.ok) setStatus(await res.json())
    } catch { /* shown as unavailable */ }
  }, [agentId])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current)
    recorder.current?.stream.getTracks().forEach((t) => t.stop())
    sample.current?.pause()
  }, [])
  useEffect(() => () => { if (take) URL.revokeObjectURL(take.url) }, [take])

  if (!status) return null
  const cloned = status.voice.clonedVoice
  const script = status.script.map((line) => line.replace('{name}', name.trim() || 'your name'))

  const startRecording = async () => {
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
        try {
          const converted = await toWav(new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' }))
          if (converted.peak < 0.05) {
            setError('The microphone picked up almost nothing. Check it is the right one and not muted, then record again.')
            setStep('consent')
            return
          }
          setTake({ wav: converted.wav, url: URL.createObjectURL(converted.wav), seconds: converted.seconds })
          setStep('review')
        } catch {
          setError('Could not read the recording. Try again, or use a different browser.')
          setStep('consent')
        }
      }
      recorder.current = rec
      rec.start()
      setElapsed(0)
      const started = Date.now()
      timer.current = setInterval(() => {
        const s = (Date.now() - started) / 1000
        setElapsed(s)
        if (s >= Math.min(status.maxSeconds, 90) && rec.state === 'recording') rec.stop()
      }, 200)
      setStep('recording')
    } catch (e) {
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the browser’s site settings and try again.' : 'Could not start the microphone.')
    }
  }

  const stopRecording = () => { if (recorder.current?.state === 'recording') recorder.current.stop() }

  const upload = async () => {
    if (!take) return
    setError(null)
    setStep('uploading')
    const form = new FormData()
    form.append('audio', take.wav, 'voice.wav')
    form.append('speakerName', name.trim())
    form.append('consent', 'yes')
    try {
      const res = await fetch(`/api/agents/${agentId}/voice/clone`, { method: 'POST', body: form })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setStep('done')
      await refresh()
      if (body.sample?.audio) {
        sample.current = new Audio(`data:${body.sample.mimeType};base64,${body.sample.audio}`)
        void sample.current.play().catch(() => undefined)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Voice cloning failed')
      setStep('review')
    }
  }

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/agents/${agentId}/voice/clone`, { method: 'DELETE' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setStep('idle')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the voice')
    } finally {
      setBusy(false)
    }
  }

  const reset = () => { setTake(null); setStep('consent'); setError(null) }
  const tooShort = take !== null && take.seconds < status.minSeconds

  return (
    <section aria-label={`${first}'s voice`} className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">{first}&apos;s voice</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            {cloned
              ? <>Using <strong>{cloned.consentFrom}</strong>&apos;s voice (consent recorded {cloned.consentDate}).</>
              : status.voice.provider === 'cartesia' ? 'Using a stock Australian voice.' : 'Using a stock voice.'}
          </p>
        </div>
        {cloned && status.canChange && (
          <button onClick={remove} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-60">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}Remove this voice
          </button>
        )}
      </div>

      {!status.available && <p className="text-sm text-neutral-500">Using your own voice needs a Cartesia account connected on the server (CARTESIA_API_KEY).</p>}
      {status.available && !status.canChange && <p className="text-sm text-neutral-500">An admin can give {first} a recorded voice.</p>}

      {status.available && status.canChange && step === 'idle' && (
        <button onClick={() => setStep('consent')} className="inline-flex items-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 text-sm font-medium">
          <Mic className="w-4 h-4" />{cloned ? 'Record a different voice' : 'Use your own voice'}
        </button>
      )}

      {step !== 'idle' && step !== 'done' && (
        <div className="space-y-4">
          <ol className="text-sm text-neutral-600 dark:text-neutral-300 list-decimal pl-5 space-y-1">
            <li>Find a quiet room and use a decent microphone or headset.</li>
            <li>Read the script below at your normal pace, the way you would talk to a caller (about 30–40 seconds).</li>
            <li>Listen back, then create the voice. Cartesia keeps a private copy; you can remove it here at any time.</li>
          </ol>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="block text-sm">
              <span className="text-neutral-700 dark:text-neutral-200">Whose voice is this?</span>
              <input id="clone-speaker" value={name} onChange={(e) => setName(e.target.value)} disabled={step !== 'consent'} placeholder="Full name" maxLength={200}
                className="mt-1 w-full rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm" />
            </label>
          </div>
          <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <input id="clone-consent" type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={step !== 'consent'} className="mt-1" />
            <span>I am this person, or I have their written permission, and they agree to their voice being copied by Cartesia and used by {status.businessName}&apos;s AI assistant, which always tells callers it is an AI.</span>
          </label>

          <div className="rounded-xl bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-200 dark:border-neutral-700 p-4 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Read this aloud</p>
            {script.map((line, i) => (
              <p key={i} className={`text-base leading-relaxed ${i === 0 ? 'font-medium text-neutral-900 dark:text-neutral-50' : 'text-neutral-800 dark:text-neutral-200'}`}>{line}</p>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {step === 'consent' && (
              <button onClick={startRecording} disabled={name.trim().length < 2 || !consent} className="inline-flex items-center gap-2 rounded-full bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white px-5 py-2.5 text-sm font-medium">
                <Mic className="w-4 h-4" />Start recording
              </button>
            )}
            {step === 'recording' && (
              <>
                <button onClick={stopRecording} className="inline-flex items-center gap-2 rounded-full bg-rose-600 hover:bg-rose-700 text-white px-5 py-2.5 text-sm font-medium">
                  <Square className="w-4 h-4" />Stop
                </button>
                <span className="text-sm tabular-nums text-neutral-700 dark:text-neutral-200" role="status" aria-live="polite">
                  <span className="inline-block w-2 h-2 rounded-full bg-rose-600 animate-pulse mr-2" aria-hidden="true" />Recording {fmt(elapsed)}
                  {elapsed < status.minSeconds ? ` (at least ${status.minSeconds} s)` : ''}
                </span>
              </>
            )}
            {(step === 'review' || step === 'uploading') && take && (
              <>
                <audio src={take.url} controls className="h-10 max-w-full" />
                <span className="text-sm text-neutral-600 dark:text-neutral-300 tabular-nums">{fmt(take.seconds)}</span>
                <button onClick={reset} disabled={step === 'uploading'} className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm disabled:opacity-60">
                  <RotateCcw className="w-4 h-4" />Record again
                </button>
                <button onClick={upload} disabled={step === 'uploading' || tooShort} className="inline-flex items-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium">
                  {step === 'uploading' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}{step === 'uploading' ? 'Creating the voice…' : 'Create voice'}
                </button>
              </>
            )}
            {step !== 'recording' && step !== 'uploading' && (
              <button onClick={() => { setStep('idle'); setTake(null); setError(null) }} className="text-sm text-neutral-500 underline">Cancel</button>
            )}
          </div>
          {tooShort && <p className="text-sm text-amber-700 dark:text-amber-400">That recording is under {status.minSeconds} seconds. Read the whole script and try again.</p>}
        </div>
      )}

      {step === 'done' && cloned && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-neutral-700 dark:text-neutral-200">
          <CheckCircle2 className="w-5 h-5 text-green-600" aria-hidden="true" />
          <span>{first} now speaks with {cloned.consentFrom}&apos;s voice. Start a conversation above to hear it.</span>
          {sample.current && (
            <button onClick={() => { sample.current!.currentTime = 0; void sample.current!.play() }} className="inline-flex items-center gap-1 underline">
              <Play className="w-3.5 h-3.5" />Play the greeting again
            </button>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
    </section>
  )
}
