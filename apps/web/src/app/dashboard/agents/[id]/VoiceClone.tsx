'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, Mic, Play, Trash2, Wand2 } from 'lucide-react'
import { VoiceRecorder, cloneForm, type CloneSetup, type VoiceTake } from '../voice-recorder'

interface CloneStatus extends CloneSetup {
  voice: { provider: string | null; voiceId: string | null; clonedVoice: { consentFrom: string; consentDate: string } | null }
}

type Step = 'idle' | 'recording' | 'uploading' | 'done'

/**
 * "Use your own voice": the speaker reads a short script (starting with a spoken consent
 * statement), and Cartesia makes a private copy of the voice for this agent. Admins only.
 */
export function VoiceClone({ agentId, agentName }: { agentId: string; agentName: string }) {
  const first = agentName.split(/\s+[-–]\s+|\s+/)[0]
  const [status, setStatus] = useState<CloneStatus | null>(null)
  const [step, setStep] = useState<Step>('idle')
  const [take, setTake] = useState<VoiceTake | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sample = useRef<HTMLAudioElement | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/voice/clone`)
      if (res.ok) setStatus(await res.json())
    } catch { /* shown as unavailable */ }
  }, [agentId])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => () => { sample.current?.pause() }, [])
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
        <button onClick={() => setStep('recording')} className="inline-flex items-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 text-sm font-medium">
          <Mic className="w-4 h-4" />{cloned ? 'Record a different voice' : 'Use your own voice'}
        </button>
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
