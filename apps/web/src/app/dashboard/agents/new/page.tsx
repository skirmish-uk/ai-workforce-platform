'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { ArrowLeft, Save, X } from 'lucide-react'
import Link from 'next/link'
import { Button, Input, Textarea, Card, CardContent, CardHeader, CardTitle } from '@ai-workforce/ui'
import { VoiceRecorder, cloneForm, type CloneSetup, type VoiceTake } from '../voice-recorder'

interface VoiceSetup extends CloneSetup {
  stockVoices: Array<{ id: string; name: string; description: string }>
}

/** "own" = record the speaker now; the voice is cloned right after the agent is created. */
type VoiceChoice = string | 'own'

const firstName = (name: string) => name.split(/\s+[-–]\s+|\s+/)[0] || 'your assistant'

interface AgentFormData {
  name: string
  role: string
  mission: string
  systemPrompt: string
  modelProvider: string
  modelName: string
}

export default function NewAgentPage() {
  const { data: session } = useSession()
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [formData, setFormData] = useState<AgentFormData>({
    name: '',
    role: '',
    mission: '',
    systemPrompt: '',
    modelProvider: 'anthropic',
    modelName: 'claude-haiku-5-5',
  })
  const [error, setError] = useState<string | null>(null)
  const [voiceSetup, setVoiceSetup] = useState<VoiceSetup | null>(null)
  const [voiceOn, setVoiceOn] = useState(false)
  const [greeting, setGreeting] = useState('')
  const [greetingEdited, setGreetingEdited] = useState(false)
  const [voiceChoice, setVoiceChoice] = useState<VoiceChoice>('')
  const [take, setTake] = useState<VoiceTake | null>(null)
  const [progress, setProgress] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/voice/clone-setup')
      .then((r) => (r.ok ? r.json() : null))
      .then((setup: VoiceSetup | null) => {
        if (!setup) return
        setVoiceSetup(setup)
        setVoiceChoice(setup.stockVoices[0]?.id ?? '')
      })
      .catch(() => undefined)
  }, [])

  // The greeting follows the agent's name until someone edits it. It must say it's an AI.
  const business = voiceSetup?.businessName ?? 'our'
  const suggestedGreeting = `Hi, I'm ${firstName(formData.name)}, ${business}'s AI assistant. How can I help?`
  const spokenGreeting = greetingEdited ? greeting : suggestedGreeting
  const greetingSaysAI = /\b(ai|a\.i\.|artificial intelligence|virtual assistant|automated)\b/i.test(spokenGreeting)
  const ownVoice = voiceOn && voiceChoice === 'own'
  const canCreate = !voiceOn || (greetingSaysAI && (!ownVoice || take !== null))

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    const stock = voiceSetup?.stockVoices ?? []
    // A recorded voice is cloned after creation; until then the agent uses the first stock voice.
    const startVoice = voiceChoice === 'own' ? stock[0]?.id : voiceChoice
    const voice = voiceOn
      ? { enabled: true, greeting: spokenGreeting, ...(startVoice ? { provider: 'cartesia', voiceId: startVoice } : {}) }
      : undefined
    try {
      setProgress('Creating the agent…')
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          tenantId: session?.user?.tenantId,
          ...(voice ? { config: { voice } } : {}),
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body.error || 'Failed to create agent')
        return
      }
      if (ownVoice && take) {
        setProgress('Creating the voice from your recording…')
        const cloned = await fetch(`/api/agents/${body.id}/voice/clone`, { method: 'POST', body: cloneForm(take) })
        if (!cloned.ok) {
          // The agent exists; the voice can be recorded again on its page.
          router.push(`/dashboard/agents/${body.id}?voice=failed`)
          return
        }
      }
      router.push(`/dashboard/agents/${body.id}`)
    } catch (e) {
      console.error('Failed to create agent:', e)
      setError('Failed to create agent')
    } finally {
      setSaving(false)
      setProgress(null)
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/dashboard/agents" className="p-2 text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">Create New Agent</h1>
          <p className="text-neutral-600 dark:text-neutral-400">Configure your AI employee</p>
        </div>
      </div>

      <form onSubmit={e => { e.preventDefault(); handleSave() }} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Basic Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input label="Agent Name" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} placeholder="e.g., Sarah - Sales Assistant" required />
            <Input label="Role" value={formData.role} onChange={e => setFormData({...formData, role: e.target.value})} placeholder="e.g., Sales Development Representative" required />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Mission & Instructions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Textarea label="Mission" value={formData.mission} onChange={e => setFormData({...formData, mission: e.target.value})} placeholder="What is this agent's primary purpose?" rows={3} required />
            <Textarea label="System Prompt" value={formData.systemPrompt} onChange={e => setFormData({...formData, systemPrompt: e.target.value})} placeholder="Detailed instructions for the agent..." rows={6} required />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Model Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Input label="Model Provider" value={formData.modelProvider} onChange={e => setFormData({...formData, modelProvider: e.target.value})} required />
              <Input label="Model Name" value={formData.modelName} onChange={e => setFormData({...formData, modelName: e.target.value})} required />
            </div>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">Example: anthropic / claude-haiku-5-5</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Voice</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-start gap-3 text-sm text-neutral-700 dark:text-neutral-200">
              <input id="voice-on" type="checkbox" checked={voiceOn} onChange={(e) => setVoiceOn(e.target.checked)} className="mt-1" />
              <span>
                <span className="font-medium">This agent can talk</span>
                <span className="block text-neutral-500 dark:text-neutral-400">People can have a spoken conversation with it from its page. It answers with the same rules and knowledge as a typed task.</span>
              </span>
            </label>

            {voiceOn && (
              <div className="space-y-4">
                <div>
                  <Input label="Greeting (spoken first, must say it's an AI)" value={spokenGreeting} onChange={(e) => { setGreeting(e.target.value); setGreetingEdited(true) }} maxLength={300} />
                  {!greetingSaysAI && <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">The greeting must tell people they&apos;re talking to an AI assistant.</p>}
                </div>

                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">Which voice?</legend>
                  {(voiceSetup?.stockVoices ?? []).map((v) => (
                    <label key={v.id} className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-200">
                      <input type="radio" name="voice-choice" id={`voice-${v.name.toLowerCase()}`} checked={voiceChoice === v.id} onChange={() => setVoiceChoice(v.id)} className="mt-1" />
                      <span><span className="font-medium">{v.name}</span> <span className="text-neutral-500 dark:text-neutral-400">{v.description}</span></span>
                    </label>
                  ))}
                  {voiceSetup?.available && (
                    <label className={`flex items-start gap-2 text-sm ${voiceSetup.canChange ? 'text-neutral-700 dark:text-neutral-200' : 'text-neutral-400'}`}>
                      <input type="radio" name="voice-choice" id="voice-own" checked={voiceChoice === 'own'} onChange={() => setVoiceChoice('own')} disabled={!voiceSetup.canChange} className="mt-1" />
                      <span>
                        <span className="font-medium">Use your own voice</span>{' '}
                        <span className="text-neutral-500 dark:text-neutral-400">{voiceSetup.canChange ? 'record a short script now and Cartesia makes a private copy' : '(an admin can do this)'}</span>
                      </span>
                    </label>
                  )}
                  {!voiceSetup?.available && <p className="text-sm text-neutral-500">With no Cartesia account connected, the agent uses the standard OpenAI voice.</p>}
                </fieldset>

                {ownVoice && voiceSetup && (
                  <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 p-4">
                    <VoiceRecorder setup={voiceSetup} onTake={setTake} disabled={saving} idPrefix="new-voice" />
                    {!take && <p className="mt-3 text-sm text-neutral-500">Record the script to create the agent with this voice, or pick a stock voice and add your own later from the agent&apos;s page.</p>}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
        {progress && <p className="text-sm text-neutral-600 dark:text-neutral-300" role="status">{progress}</p>}

        <div className="flex justify-end gap-3">
          <Link href="/dashboard/agents">
            <Button type="button" variant="outline" onClick={() => router.push('/dashboard/agents')}>
              <X className="w-4 h-4 mr-2" />
              Cancel
            </Button>
          </Link>
          <Button type="submit" isLoading={saving} disabled={!canCreate}>
            <Save className="w-4 h-4 mr-2" />
            Create Agent
          </Button>
        </div>
      </form>
    </div>
  )
}