'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { ArrowLeft, Bot, Save, X } from 'lucide-react'
import Link from 'next/link'
import { Button, Input, Textarea, Card, CardContent, CardHeader, CardTitle } from '@ai-workforce/ui'

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
    modelName: 'claude-3-sonnet-20240229',
  })

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          tenantId: session?.user?.tenantId,
        }),
      })
      if (res.ok) {
        const agent = await res.json()
        router.push(`/dashboard/agents/${agent.id}`)
      } else {
        const error = await res.json()
        alert(error.error || 'Failed to create agent')
      }
    } catch (error) {
      console.error('Failed to create agent:', error)
      alert('Failed to create agent')
    } finally {
      setSaving(false)
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
            <p className="text-sm text-neutral-500 dark:text-neutral-400">Example: anthropic / claude-3-sonnet-20240229</p>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Link href="/dashboard/agents">
            <Button type="button" variant="outline" onClick={() => router.push('/dashboard/agents')}>
              <X className="w-4 h-4 mr-2" />
              Cancel
            </Button>
          </Link>
          <Button type="submit" isLoading={saving}>
            <Save className="w-4 h-4 mr-2" />
            Create Agent
          </Button>
        </div>
      </form>
    </div>
  )
}