'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, Mic, PhoneCall, Square, Volume2 } from 'lucide-react'
import { Button } from '@ai-workforce/ui'

interface Turn {
  who: 'you' | 'agent'
  text: string
  runId?: string | null
  status?: string
  audio?: string | null
  mimeType?: string | null
  note?: string
}

interface VoiceResponse {
  transcript?: string
  reply?: string
  greeting?: string
  status?: string
  runId?: string | null
  audio?: string | null
  mimeType?: string | null
  ttsError?: string
  error?: string
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
 * Turn-based voice conversation with an agent: tap to talk, tap again to send; the
 * agent's answer is spoken back and written out. Each turn is a normal agent run.
 */
export function VoicePanel({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'thinking'>('idle')
  const [started, setStarted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const player = useRef<HTMLAudioElement | null>(null)
  const logEnd = useRef<HTMLDivElement | null>(null)
  const first = agentName.split(/\s+[-–]\s+|\s+/)[0]

  useEffect(() => { logEnd.current?.scrollIntoView({ block: 'nearest' }) }, [turns])
  useEffect(() => () => { recorder.current?.stream.getTracks().forEach((t) => t.stop()); player.current?.pause() }, [])

  const play = (audio?: string | null, mimeType?: string | null) => {
    if (!audio || !mimeType) return
    player.current?.pause()
    player.current = new Audio(`data:${mimeType};base64,${audio}`)
    player.current.play().catch(() => undefined)
  }

  const start = async () => {
    setError(null)
    setState('starting')
    try {
      const res = await fetch(`/api/agents/${agentId}/voice`)
      const body: VoiceResponse = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setTurns([{ who: 'agent', text: body.greeting ?? '', audio: body.audio, mimeType: body.mimeType, note: body.ttsError ? `Speech unavailable: ${body.ttsError}` : undefined }])
      play(body.audio, body.mimeType)
      setStarted(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the conversation')
    } finally {
      setState('idle')
    }
  }

  const record = async () => {
    setError(null)
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('This browser cannot record audio. Try a current Chrome, Edge, Firefox or Safari.')
      return
    }
    try {
      player.current?.pause()
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = recorderMimeType()
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunks.current = []
      rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data) }
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        void send(new Blob(chunks.current, { type: rec.mimeType || mimeType || 'audio/webm' }))
      }
      recorder.current = rec
      rec.start()
      setState('recording')
    } catch (e) {
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the browser’s site settings and try again.' : 'Could not start the microphone.')
      setState('idle')
    }
  }

  const stop = () => {
    if (recorder.current?.state === 'recording') {
      setState('thinking')
      recorder.current.stop()
    }
  }

  const send = async (audio: Blob) => {
    if (audio.size < 1000) {
      setState('idle')
      setError('That recording was too short. Tap, speak, then tap again.')
      return
    }
    const form = new FormData()
    form.append('audio', audio, 'utterance')
    try {
      const res = await fetch(`/api/agents/${agentId}/voice`, { method: 'POST', body: form })
      const body: VoiceResponse = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
      setTurns((prev) => [
        ...prev,
        { who: 'you', text: body.transcript || '(nothing heard)' },
        { who: 'agent', text: body.reply ?? '', runId: body.runId, status: body.status, audio: body.audio, mimeType: body.mimeType, note: body.ttsError ? `Speech unavailable: ${body.ttsError}` : undefined },
      ])
      play(body.audio, body.mimeType)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setState('idle')
    }
  }

  return (
    <section className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-4 space-y-4" aria-label={`Talk to ${first}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">Talk to {first}</h2>
          <p className="text-xs text-neutral-500">Voice conversation. Each answer comes from the same agent, rules and knowledge as a typed task.</p>
        </div>
        {!started ? (
          <Button onClick={start} isLoading={state === 'starting'} disabled={state !== 'idle'}>
            <PhoneCall className="w-4 h-4 mr-2" />Start conversation
          </Button>
        ) : state === 'recording' ? (
          <Button variant="destructive" onClick={stop}><Square className="w-4 h-4 mr-2" />Stop and send</Button>
        ) : (
          <Button onClick={record} disabled={state !== 'idle'}>
            {state === 'thinking' ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Mic className="w-4 h-4 mr-2" />}
            {state === 'thinking' ? `${first} is answering…` : 'Tap to talk'}
          </Button>
        )}
      </div>

      {state === 'recording' && (
        <p className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" role="status">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" aria-hidden="true" />Listening… tap “Stop and send” when you’ve finished.
        </p>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}

      {turns.length > 0 && (
        <ol className="space-y-3 max-h-80 overflow-auto">
          {turns.map((t, i) => (
            <li key={i} className={`flex ${t.who === 'you' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${t.who === 'you' ? 'bg-primary-600 text-white' : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100'}`}>
                <p className="whitespace-pre-wrap">{t.text}</p>
                {t.who === 'agent' && (t.audio || t.runId || t.note) && (
                  <p className="mt-1 flex flex-wrap items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
                    {t.audio && <button onClick={() => play(t.audio, t.mimeType)} className="inline-flex items-center gap-1 underline"><Volume2 className="w-3 h-3" />Play again</button>}
                    {t.runId && <Link href={`/dashboard/agents/${agentId}?run=${encodeURIComponent(t.runId)}`} className="underline">See how it answered</Link>}
                    {t.note && <span>{t.note}</span>}
                  </p>
                )}
              </div>
            </li>
          ))}
          <div ref={logEnd} />
        </ol>
      )}
      <p className="text-xs text-neutral-500">Recordings are sent for transcription and are not stored. {first} introduces itself as an AI assistant.</p>
    </section>
  )
}
