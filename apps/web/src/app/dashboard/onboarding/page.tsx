'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { ArrowLeft, ArrowRight, Check, Loader2, Building2, Target, Zap, FileText, Plug, CheckCircle } from 'lucide-react'
import { Button, Input, Textarea, Card, CardContent, CardHeader, CardTitle } from '@ai-workforce/ui'

const steps = [
  { id: 1, title: 'Business Profile', icon: Building2, description: 'Tell us about your company' },
  { id: 2, title: 'Goals', icon: Target, description: 'What outcomes do you want?' },
  { id: 3, title: 'Workflows', icon: Zap, description: 'Select processes to automate' },
  { id: 4, title: 'Knowledge', icon: FileText, description: 'Upload documents & SOPs' },
  { id: 5, title: 'Integrations', icon: Plug, description: 'Connect your systems' },
]

const workflowOptions = [
  { id: 'lead_follow_up', name: 'Lead Follow-up', description: 'Automated follow-up emails to qualified leads' },
  { id: 'email_triage', name: 'Email Triage', description: 'Classify and prioritize incoming emails' },
  { id: 'meeting_summary', name: 'Meeting Summaries', description: 'Auto-generate meeting notes and action items' },
  { id: 'crm_update', name: 'CRM Updates', description: 'Keep CRM records current automatically' },
  { id: 'document_extraction', name: 'Document Extraction', description: 'Extract data from PDFs and documents' },
  { id: 'reporting', name: 'Automated Reporting', description: 'Generate weekly/monthly business reports' },
]

const integrationOptions = [
  { id: 'gmail', name: 'Gmail', description: 'Send/receive emails, manage labels' },
  { id: 'outlook', name: 'Outlook', description: 'Microsoft email and calendar' },
  { id: 'hubspot', name: 'HubSpot CRM', description: 'Contacts, deals, companies' },
  { id: 'salesforce', name: 'Salesforce', description: 'Enterprise CRM platform' },
  { id: 'google_calendar', name: 'Google Calendar', description: 'Schedule and manage meetings' },
  { id: 'slack', name: 'Slack', description: 'Team messaging and notifications' },
  { id: 'google_drive', name: 'Google Drive', description: 'Document storage and sharing' },
  { id: 'notion', name: 'Notion', description: 'Knowledge base and wiki' },
]

interface FormData {
  industry: string
  geography: string
  companySize: string
  services: string
  targetCustomers: string
  painPoints: string
  currentSoftware: string
  existingSOPs: string
  complianceRequirements: string
  goals: string[]
  workflows: string[]
  knowledgeFiles: File[]
  integrations: string[]
}

export default function OnboardingPage() {
  const { data: session } = useSession()
  const router = useRouter()
  const [currentStep, setCurrentStep] = useState(1)
  const [loading, setLoading] = useState(false)
  const [formData, setFormData] = useState<FormData>({
    // Step 1
    industry: '',
    geography: '',
    companySize: '',
    services: '',
    targetCustomers: '',
    painPoints: '',
    currentSoftware: '',
    existingSOPs: '',
    complianceRequirements: '',
    // Step 2
    goals: [],
    // Step 3
    workflows: [],
    // Step 4
    knowledgeFiles: [],
    // Step 5
    integrations: [],
  })

  const handleChange = (field: string, value: unknown) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const handleSubmit = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/onboarding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: currentStep, data: formData }),
      })
      if (res.ok) {
        if (currentStep < steps.length) {
          setCurrentStep(prev => prev + 1)
        } else {
          router.push('/dashboard')
        }
      } else {
        alert('Failed to save. Please try again.')
      }
    } catch (error) {
      console.error('Failed to save:', error)
      alert('Failed to save. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const renderStep = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2">
              <Input label="Industry" value={formData.industry} onChange={e => handleChange('industry', e.target.value)} placeholder="e.g., Marketing Agency" required />
              <Input label="Geography" value={formData.geography} onChange={e => handleChange('geography', e.target.value)} placeholder="e.g., Australia" required />
            </div>
            <Input label="Company Size" value={formData.companySize} onChange={e => handleChange('companySize', e.target.value)} placeholder="e.g., 10-50 employees" required />
            <Textarea label="Services / Products" value={formData.services} onChange={e => handleChange('services', e.target.value)} placeholder="Describe what you offer" rows={3} required />
            <Textarea label="Target Customers" value={formData.targetCustomers} onChange={e => handleChange('targetCustomers', e.target.value)} placeholder="Who are your ideal customers?" rows={3} />
            <Textarea label="Pain Points" value={formData.painPoints} onChange={e => handleChange('painPoints', e.target.value)} placeholder="What are your biggest operational challenges?" rows={3} />
            <Textarea label="Current Software Stack" value={formData.currentSoftware} onChange={e => handleChange('currentSoftware', e.target.value)} placeholder="e.g., HubSpot, Gmail, Slack, Notion" rows={3} />
            <Textarea label="Existing SOPs / Processes" value={formData.existingSOPs} onChange={e => handleChange('existingSOPs', e.target.value)} placeholder="Do you have documented processes?" rows={3} />
            <Textarea label="Compliance Requirements" value={formData.complianceRequirements} onChange={e => handleChange('complianceRequirements', e.target.value)} placeholder="Any regulatory requirements? (e.g., GDPR, HIPAA)" rows={2} />
          </div>
        )
      case 2:
        return (
          <div className="space-y-6">
            <p className="text-neutral-600 dark:text-neutral-400">Select the outcomes you want your AI employee to achieve:</p>
            <div className="space-y-4">
              {[
                { id: 'response_time', label: 'Faster Response Times', desc: 'Reduce time to respond to leads/customers' },
                { id: 'qualified_leads', label: 'More Qualified Leads', desc: 'Better lead qualification and scoring' },
                { id: 'tasks_completed', label: 'More Tasks Completed', desc: 'Increase automation of repetitive tasks' },
                { id: 'processing_time', label: 'Reduced Processing Time', desc: 'Speed up document/data processing' },
                { id: 'missed_followups', label: 'Zero Missed Follow-ups', desc: 'Never let a lead go cold' },
                { id: 'admin_hours', label: 'Reduce Admin Hours', desc: 'Free up team for high-value work' },
                { id: 'revenue_opportunities', label: 'Capture Revenue Opportunities', desc: 'Identify and act on upsell/cross-sell' },
              ].map(goal => (
                <label key={goal.id} className="flex items-start gap-3 p-4 border border-neutral-200 dark:border-neutral-700 rounded-lg cursor-pointer hover:border-primary-300 dark:hover:border-primary-700 transition-colors">
                  <input
                    type="checkbox"
                    checked={formData.goals.includes(goal.id)}
                    onChange={e => handleChange('goals', e.target.checked ? [...formData.goals, goal.id] : formData.goals.filter(g => g !== goal.id))}
                    className="mt-1 w-4 h-4 text-primary-600 border-neutral-300 rounded focus:ring-primary-500"
                  />
                  <div>
                    <p className="font-medium text-neutral-900 dark:text-neutral-50">{goal.label}</p>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">{goal.desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>
        )
      case 3:
        return (
          <div className="space-y-6">
            <p className="text-neutral-600 dark:text-neutral-400">Choose workflows to automate first (start with 1-2):</p>
            <div className="grid gap-4 md:grid-cols-2">
              {workflowOptions.map(wf => (
                <label key={wf.id} className="flex items-start gap-3 p-4 border border-neutral-200 dark:border-neutral-700 rounded-lg cursor-pointer hover:border-primary-300 dark:hover:border-primary-700 transition-colors">
                  <input
                    type="checkbox"
                    checked={formData.workflows.includes(wf.id)}
                    onChange={e => handleChange('workflows', e.target.checked ? [...formData.workflows, wf.id] : formData.workflows.filter(w => w !== wf.id))}
                    className="mt-1 w-4 h-4 text-primary-600 border-neutral-300 rounded focus:ring-primary-500"
                  />
                  <div>
                    <p className="font-medium text-neutral-900 dark:text-neutral-50">{wf.name}</p>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">{wf.description}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>
        )
      case 4:
        return (
          <div className="space-y-6">
            <p className="text-neutral-600 dark:text-neutral-400">Upload documents, SOPs, FAQs, and reference materials:</p>
            <div className="border-2 border-dashed border-neutral-300 dark:border-neutral-600 rounded-xl p-8 text-center">
              <FileText className="w-12 h-12 text-neutral-400 mx-auto mb-4" />
              <p className="text-neutral-600 dark:text-neutral-400 mb-4">Drag & drop files here, or click to browse</p>
              <input
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.txt,.md,.csv"
                onChange={e => handleChange('knowledgeFiles', Array.from(e.target.files || []))}
                className="sr-only"
                id="file-upload"
              />
              <Button variant="outline" onClick={() => document.getElementById('file-upload')?.click()}>
                Choose Files
              </Button>
            </div>
            {formData.knowledgeFiles.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Selected files:</p>
                {formData.knowledgeFiles.map((file, i) => (
                  <div key={i} className="flex items-center justify-between p-3 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
                    <span className="text-sm text-neutral-900 dark:text-neutral-50">{file.name} ({(file.size / 1024).toFixed(1)} KB)</span>
                    <Button variant="ghost" size="sm" onClick={() => handleChange('knowledgeFiles', formData.knowledgeFiles.filter((_, idx) => idx !== i))}>
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-neutral-500 dark:text-neutral-400">Supported: PDF, DOC, DOCX, TXT, MD, CSV (max 10MB each)</p>
          </div>
        )
      case 5:
        return (
          <div className="space-y-6">
            <p className="text-neutral-600 dark:text-neutral-400">Select systems to connect (configure credentials later):</p>
            <div className="grid gap-4 md:grid-cols-2">
              {integrationOptions.map(int => (
                <label key={int.id} className="flex items-start gap-3 p-4 border border-neutral-200 dark:border-neutral-700 rounded-lg cursor-pointer hover:border-primary-300 dark:hover:border-primary-700 transition-colors">
                  <input
                    type="checkbox"
                    checked={formData.integrations.includes(int.id)}
                    onChange={e => handleChange('integrations', e.target.checked ? [...formData.integrations, int.id] : formData.integrations.filter(i => i !== int.id))}
                    className="mt-1 w-4 h-4 text-primary-600 border-neutral-300 rounded focus:ring-primary-500"
                  />
                  <div>
                    <p className="font-medium text-neutral-900 dark:text-neutral-50">{int.name}</p>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">{int.description}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>
        )
      default:
        return null
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-neutral-900 dark:text-neutral-50">Welcome to AI Workforce</h1>
        <p className="text-neutral-600 dark:text-neutral-400 mt-2">Let&apos;s set up your AI employee in 5 steps</p>
      </div>

      <div className="flex items-center justify-center gap-2">
        {steps.map((step, i) => (
          <div key={step.id} className="flex items-center gap-2">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
              i + 1 < currentStep ? 'bg-green-600 text-white' :
              i + 1 === currentStep ? 'bg-primary-600 text-white' :
              'bg-neutral-200 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400'
            }`}>
              {i + 1 < currentStep ? <Check className="w-5 h-5" /> : step.id}
            </div>
            {i < steps.length - 1 && <div className={`w-16 h-1 ${i + 1 < currentStep ? 'bg-green-600' : 'bg-neutral-200 dark:bg-neutral-700'}`} />}
          </div>
        ))}
      </div>

      <div className="space-y-2 text-center text-sm text-neutral-500 dark:text-neutral-400">
        <p className="font-medium text-neutral-900 dark:text-neutral-50">{steps[currentStep - 1].title}</p>
        <p>{steps[currentStep - 1].description}</p>
      </div>

      <form onSubmit={e => { e.preventDefault(); handleSubmit() }}>
        <Card>
          <CardContent className="pt-6">
            {renderStep()}
          </CardContent>
        </Card>

        <div className="flex justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={() => setCurrentStep(prev => Math.max(1, prev - 1))}
            disabled={currentStep === 1}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          <Button
            type="submit"
            isLoading={loading}
            disabled={loading}
          >
            {currentStep === steps.length ? 'Complete Setup' : 'Next'}
            {currentStep < steps.length && <ArrowRight className="w-4 h-4 ml-2" />}
          </Button>
        </div>
      </form>
    </div>
  )
}