'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CheckCircle2, Loader2, Mic, Play, Square, Trash2, Wand2 } from 'lucide-react'
import { VoiceRecorder, cloneForm, type CloneSetup, type VoiceTake } from '../voice-recorder'

interface SavedVoice { voiceId: string; consentFrom: string; consentDate: string; inUse: boolean }

interface CloneStatus extends CloneSetup {
  voice: { provider: string | null; voiceId: string | null; clonedVoice: { consentFrom: string; consentDate: string } | null }
  saved: SavedVoice[]
  stock: { provider: string | null; voiceId: string | null; name: string | null; inUse: boolean }
  maxVoices: number
  /** This month's voice usage against its limits (0 = no limit); null if it couldn't be read. */
  usage: { tenant: { used: number; limit: number }; clones: { used: number; limit: number } } | null
}

/** About 780 characters of Cartesia speech make a minute. */
const CHARS_PER_MINUTE = 780

type Step = 'idle' | 'recording' | 'uploading' | 'done'

/**
 * The agent's voices: its stock voice and any recorded ones ("Use your own voice": the speaker
 * reads a short script starting with a spoken consent statement, and Cartesia makes a private
 * copy). Recording another adds it; switch between them, or remove one. Admins only.
 */
export function VoiceClone({ agentId, agentName }: { agentId: string; agentName: string }) {
  const first = agentName.split(/\s+[-–]\s+|\s+/)[0]
  const [status, setStatus] = useState<CloneStatus | null>(null)
  const [step, setStep] = useState<Step>('idle')
  const [take, setTake] = useState<VoiceTake | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The voice being switched to or removed (its id, or "stock"). */
  const [busy, setBusy] = useState<string | null>(null)
  /** A saved voice waiting for "Remove for good?" to be confirmed. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const sample = useRef<HTMLAudioElement | null>(null)
  /** "Listen" previews: which voice is loading or playing, and its audio. */
  const [preview, setPreview] = useState<{ key: string; loading: boolean } | null>(null)
  const previewAudio = useRef<HTMLAudioElement | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/voice/clone`)
      if (res.ok) setStatus(await res.json())
    } catch { /* shown as unavailable */ }
  }, [agentId])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => () => { sample.current?.pause(); previewAudio.current?.pause() }, [])
  // Arrived from the new-agent form after the voice couldn't be made: say so and reopen the recorder.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('voice') === 'failed') {
      setError('The agent was created, but its voice couldn’t be made from the recording. Record it again here.')
      setStep('recording')
    }
  }, [])

  if (!status) return null
  const cloned = status.voice.clonedVoice

  const upload = async () => {
    if (!take) return
    setError(null)
    setStep('uploading')
    try {
      const res = await fetch(`/api/agents/${agentId}/voice/clone`, { method: 'POST', body: cloneForm(take) })
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
      setStep('recording')
    }
  }

  const remove = async (voiceId: string) => {
    setBusy(voiceId)
    setError(null)
    try {
      const res = await fetch(`/api/agents/${agentId}/voice/clone?voiceId=${encodeURIComponent(voiceId)}`, { method: 'DELETE' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setStep('idle')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the voice')
    } finally {
      setBusy(null)
      setConfirmRemove(null)
    }
  }

  const stopPreview = () => {
    previewAudio.current?.pause()
    previewAudio.current = null
    setPreview(null)
  }

  /** Plays the greeting in a voice without switching to it (the second time comes from the cache). */
  const listen = async (key: string) => {
    if (preview?.key === key) { stopPreview(); return }
    stopPreview()
    sample.current?.pause()
    setError(null)
    setPreview({ key, loading: true })
    try {
      const res = await fetch(`/api/agents/${agentId}/voice/preview?voice=${encodeURIComponent(key)}`)
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Request failed (${res.status})`)
      const url = URL.createObjectURL(await res.blob())
      const audio = new Audio(url)
      previewAudio.current = audio
      const done = () => {
        URL.revokeObjectURL(url)
        if (previewAudio.current === audio) { previewAudio.current = null; setPreview(null) }
      }
      audio.onended = done
      audio.onerror = done
      await audio.play()
      if (previewAudio.current === audio) setPreview({ key, loading: false })
    } catch (e) {
      setPreview((p) => (p?.key === key ? null : p))
      setError(e instanceof Error ? e.message : 'Couldn’t play that voice')
    }
  }

  const use = async (choice: { voiceId: string } | { stock: true }) => {
    const key = 'stock' in choice ? 'stock' : choice.voiceId
    setBusy(key)
    setError(null)
    try {
      const res = await fetch(`/api/agents/${agentId}/voice/clone`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(choice) })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setStep('idle')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not switch voice')
    } finally {
      setBusy(null)
    }
  }

  const full = status.saved.length >= status.maxVoices
  const stockName = status.stock.name ? `${status.stock.name}${status.stock.provider === 'cartesia' ? ' (stock Australian voice)' : ' (stock voice)'}` : 'Stock voice'

  return (
    <section aria-label={`${first}'s voice`} className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">{first}&apos;s voice</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            {cloned
              ? <>Using <strong>{cloned.consentFrom}</strong>&apos;s voice (consent recorded {cloned.consentDate}).</>
              : <>Using {stockName}.</>}
          </p>
        </div>
      </div>

      {(status.saved.length > 0 || status.canChange) && (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-800" aria-label="Voices">
          {[{ key: 'stock', label: stockName, detail: 'Comes with the platform', inUse: status.stock.inUse, saved: null as SavedVoice | null },
            ...status.saved.map((v) => ({ key: v.voiceId, label: `${v.consentFrom}'s voice`, detail: `Recorded with consent ${v.consentDate}`, inUse: v.inUse, saved: v }))].map((row) => (
            <li key={row.key} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate">{row.label}</p>
                <p className="text-xs text-neutral-500">{row.detail}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => listen(row.key)} aria-label={`${preview?.key === row.key ? 'Stop' : 'Listen to'} ${row.label}`} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800">
                  {preview?.key === row.key
                    ? preview.loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-3.5 h-3.5 fill-current" />
                    : <Play className="w-4 h-4" />}
                  {preview?.key === row.key && !preview.loading ? 'Stop' : 'Listen'}
                </button>
                {row.inUse ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-green-50 dark:bg-green-900/30 px-2.5 py-1 text-xs font-medium text-green-800 dark:text-green-300"><Check className="w-3.5 h-3.5" />In use</span>
                ) : status.canChange && (
                  <button onClick={() => use(row.saved ? { voiceId: row.saved.voiceId } : { stock: true })} disabled={busy !== null} className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-60">
                    {busy === row.key && <Loader2 className="w-4 h-4 animate-spin" />}Use this voice
                  </button>
                )}
                {row.saved && status.canChange && (confirmRemove === row.key ? (
                  <span className="inline-flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-neutral-600 dark:text-neutral-300">Delete it for good?</span>
                    <button onClick={() => remove(row.key)} disabled={busy !== null} className="inline-flex items-center gap-1 rounded-lg bg-red-600 hover:bg-red-700 text-white px-2.5 py-1 text-sm disabled:opacity-60">
                      {busy === row.key && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Delete
                    </button>
                    <button onClick={() => setConfirmRemove(null)} className="text-neutral-500 underline">Keep</button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmRemove(row.key)} disabled={busy !== null} aria-label={`Remove ${row.label}`} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-neutral-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-60">
                    <Trash2 className="w-4 h-4" />Remove
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {status.usage && status.canChange && status.voice.provider === 'cartesia' && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
          This month: {status.usage.tenant.used.toLocaleString()}
          {status.usage.tenant.limit > 0 && <> of {status.usage.tenant.limit.toLocaleString()}</>} characters of speech
          {status.usage.tenant.limit > 0 && <> (about {Math.round(status.usage.tenant.used / CHARS_PER_MINUTE)} of {Math.round(status.usage.tenant.limit / CHARS_PER_MINUTE)} minutes)</>}
          {status.usage.clones.limit > 0 && <> · {status.usage.clones.used} of {status.usage.clones.limit} voices recorded</>}
          {status.usage.tenant.limit > 0 && status.usage.tenant.used > status.usage.tenant.limit - 300 && <span className="text-amber-700 dark:text-amber-400"> · limit reached: calls are off until next month</span>}
        </p>
      )}

      {!status.available && <p className="text-sm text-neutral-500">Using your own voice needs a Cartesia account connected on the server (CARTESIA_API_KEY).</p>}
      {status.available && !status.canChange && <p className="text-sm text-neutral-500">An admin can give {first} a recorded voice.</p>}

      {status.available && status.canChange && step !== 'recording' && step !== 'uploading' && (
        full
          ? <p className="text-sm text-neutral-500">{status.maxVoices} voices are saved, the most an agent can keep. Remove one to record another.</p>
          : (
            <button onClick={() => { setStep('recording'); setTake(null) }} className="inline-flex items-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 text-sm font-medium">
              <Mic className="w-4 h-4" />{status.saved.length ? 'Record another voice' : 'Use your own voice'}
            </button>
          )
      )}

      {(step === 'recording' || step === 'uploading') && (
        <div className="space-y-4">
          <VoiceRecorder setup={status} onTake={setTake} disabled={step === 'uploading'} idPrefix="clone" />
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={upload} disabled={!take || step === 'uploading'} className="inline-flex items-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium">
              {step === 'uploading' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}{step === 'uploading' ? 'Creating the voice…' : 'Create voice'}
            </button>
            {step === 'recording' && <button onClick={() => { setStep('idle'); setTake(null); setError(null) }} className="text-sm text-neutral-500 underline">Cancel</button>}
          </div>
        </div>
      )}

      {step === 'done' && cloned && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-neutral-700 dark:text-neutral-200">
          <CheckCircle2 className="w-5 h-5 text-green-600" aria-hidden="true" />
          <span>{first} now speaks with {cloned.consentFrom}&apos;s voice, and it&apos;s saved with the others. Start a conversation above to hear it.</span>
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
