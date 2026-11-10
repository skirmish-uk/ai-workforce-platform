'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Mic, Square } from 'lucide-react'
import { toWav } from './voice-audio'

export interface Comparison {
  provider: string
  model?: string
  text?: string
  confidence?: number | null
  ms: number
  error?: string
}

const PROVIDER_NAMES: Record<string, string> = { openai: 'OpenAI', deepgram: 'Deepgram', speechmatics: 'Speechmatics' }
const ALL_PROVIDERS = ['openai', 'deepgram', 'speechmatics']
const KEY_NAMES: Record<string, string> = { openai: 'OPENAI_API_KEY', deepgram: 'DEEPGRAM_API_KEY', speechmatics: 'SPEECHMATICS_API_KEY' }

/** Sentences with the names, numbers and phrasing that go wrong most on calls. */
const SAMPLE_SENTENCES = [
  'Hi, it’s Maria from CloudNine Analytics. Could I book a chat for Thursday at two?',
  'What does the Growth package include, and is there a minimum term?',
  'We’re a thirty-person IT company in Glasgow, and we want more leads from LinkedIn.',
  'Actually, can we make that Friday morning instead? Half nine would be ideal.',
  'Is the ad spend on top of the Growth package price, or included in it?',
]

/** Sends one recording (as WAV) to every configured transcriber. */
export async function compareRecording(agentId: string, recording: Blob): Promise<Comparison[]> {
  const form = new FormData()
  form.append('audio', await toWav(recording), 'utterance.wav')
  const res = await fetch(`/api/agents/${agentId}/voice/compare`, { method: 'POST', body: form })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
  return body.results as Comparison[]
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** Lower-case words, with "two" and "2", "thirty" and "30" counted the same (providers format numbers differently). */
const normalise = (text: string) =>
  (text.toLowerCase().replace(/[’']/g, '').match(/[a-z0-9]+/g) ?? []).map((w) => {
    const n = NUMBER_WORDS.indexOf(w)
    if (n >= 0) return String(n)
    const t = TENS.indexOf(w)
    return t >= 2 ? String(t * 10) : w
  })

/** Word errors (substitutions, insertions, deletions) of a transcript against what was read out. */
export function wordErrors(expected: string, heard: string): number {
  const a = normalise(expected)
  const b = normalise(heard)
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}

export function ComparisonResults({ results, inUse, expected }: { results: Comparison[]; inUse?: string | null; expected?: string }) {
  const words = expected ? normalise(expected).length : 0
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {results.map((r) => {
        const errors = expected && r.text !== undefined ? wordErrors(expected, r.text) : null
        return (
          <div key={r.provider} className="min-w-0 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-3 text-sm">
            <p className="flex flex-wrap items-center gap-x-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">
              <span className="text-neutral-900 dark:text-neutral-100">{PROVIDER_NAMES[r.provider] ?? r.provider}</span>
              {r.model && <span>{r.model}</span>}
              {inUse === r.provider && <span className="rounded bg-primary-100 dark:bg-primary-900/40 px-1.5 text-primary-800 dark:text-primary-200">in use</span>}
            </p>
            {r.error
              ? <p className="mt-1 text-red-600 dark:text-red-400 break-words">{r.error}</p>
              : <p className="mt-1 text-neutral-900 dark:text-neutral-100 break-words">{r.text || <span className="text-neutral-500">(nothing heard)</span>}</p>}
            <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
              <span>{(r.ms / 1000).toFixed(1)} s</span>
              {typeof r.confidence === 'number' && <span>{Math.round(r.confidence * 100)}% sure</span>}
              {errors !== null && (
                <span className={errors === 0 ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}>
                  {errors === 0 ? 'word-perfect' : `${errors} of ${words} words wrong`}
                </span>
              )}
            </p>
          </div>
        )
      })}
    </div>
  )
}

interface Run { expected: string; results?: Comparison[]; error?: string }

/**
 * Record a sentence and see how each speech-to-text provider hears it, side by side, with
 * the agent's vocabulary. Doesn't run the agent.
 */
export function TranscriberCompare({ agentId, micId }: { agentId: string; micId?: string }) {
  const [configured, setConfigured] = useState<string[] | null>(null)
  const [inUse, setInUse] = useState<string | null>(null)
  const [expected, setExpected] = useState(SAMPLE_SENTENCES[0])
  const [state, setState] = useState<'idle' | 'recording' | 'comparing'>('idle')
  const [runs, setRuns] = useState<Run[]>([])
  const [error, setError] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)

  useEffect(() => {
    fetch(`/api/agents/${agentId}/voice/compare`).then((r) => r.json()).then((b) => { setConfigured(b.configured ?? []); setInUse(b.inUse ?? null) }).catch(() => setConfigured([]))
  }, [agentId])
  useEffect(() => () => { recorder.current?.stream.getTracks().forEach((t) => t.stop()) }, [])

  const start = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(micId ? { deviceId: { exact: micId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      const rec = new MediaRecorder(stream)
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setState('comparing')
        const said = expected.trim()
        try {
          const results = await compareRecording(agentId, new Blob(chunks, { type: rec.mimeType || 'audio/webm' }))
          setRuns((prev) => [{ expected: said, results }, ...prev])
        } catch (e) {
          setRuns((prev) => [{ expected: said, error: e instanceof Error ? e.message : 'Comparison failed' }, ...prev])
        }
        setState('idle')
      }
      recorder.current = rec
      rec.start()
      setState('recording')
    } catch (e) {
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the browser’s site settings.' : 'Could not start recording.')
    }
  }

  const missing = configured ? ALL_PROVIDERS.filter((p) => !configured.includes(p)) : []

  return (
    <details className="group rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white/60 dark:bg-neutral-900/60 p-3">
      <summary className="cursor-pointer text-sm font-medium text-neutral-800 dark:text-neutral-200">Compare transcribers</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Read a sentence out and see how each speech-to-text service hears it, with this agent’s vocabulary. Nothing is sent to the agent. You can also compare any of your turns in a call.
          {missing.length > 0 && configured && <> Not set up: {missing.map((p) => `${PROVIDER_NAMES[p]} (${KEY_NAMES[p]})`).join(', ')}.</>}
        </p>
        <label className="block text-xs text-neutral-600 dark:text-neutral-400">
          <span className="mb-1 block">Read this out (edit it to say anything)</span>
          <input
            list="compare-sentences"
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
            disabled={state !== 'idle'}
            className="w-full min-w-0 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-2 py-1.5 text-sm text-neutral-900 dark:text-neutral-100"
          />
          <datalist id="compare-sentences">{SAMPLE_SENTENCES.map((s) => <option key={s} value={s} />)}</datalist>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          {state === 'recording' ? (
            <button onClick={() => recorder.current?.stop()} className="inline-flex items-center gap-2 rounded-full bg-rose-600 hover:bg-rose-700 text-white px-4 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400">
              <Square className="w-3.5 h-3.5" />Stop and compare
            </button>
          ) : (
            <button onClick={start} disabled={state !== 'idle' || !configured?.length} className="inline-flex items-center gap-2 rounded-full bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white px-4 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">
              {state === 'comparing' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}{state === 'comparing' ? 'Comparing…' : 'Record'}
            </button>
          )}
          {state === 'recording' && <span className="text-sm text-neutral-600 dark:text-neutral-300" role="status">Recording… read the sentence, then stop.</span>}
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
        {runs.map((run, i) => (
          <div key={runs.length - i} className="space-y-2">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">Read out: “{run.expected}”</p>
            {run.error ? <p className="text-sm text-red-600 dark:text-red-400">{run.error}</p> : <ComparisonResults results={run.results!} inUse={inUse} expected={run.expected} />}
          </div>
        ))}
      </div>
    </details>
  )
}
