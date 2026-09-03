'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { ArrowLeft, Zap, Copy, Edit, Trash2, CheckCircle, Clock } from 'lucide-react'
import Link from 'next/link'
import { Button, Badge, Card, CardContent, CardHeader, CardTitle } from '@ai-workforce/ui'
import { formatDate } from '@ai-workforce/ui'

interface Skill {
  id: string
  name: string
  version: string
  description: string
  purpose: string
  instructions: string
  requiredTools: string[]
  inputs: Record<string, unknown>
  outputs: Record<string, unknown>
  constraints: string[]
  failureHandling: Record<string, unknown>
  evaluationCases: Array<Record<string, unknown>>
  metadata: Record<string, unknown>
  isActive: boolean
  tenantId: string | null
  createdAt: string
  updatedAt: string
  _count?: { agents: number }
}

export default function SkillDetailPage() {
  const params = useParams()
  const router = useRouter()
  const { data: session } = useSession()
  const skillId = params.id as string
  const [skill, setSkill] = useState<Skill | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/skills/${skillId}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => { setSkill(data); setLoading(false) })
      .catch(() => { setLoading(false) })
  }, [skillId])

  if (loading) {
    return (
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-8 text-center">
        <div className="animate-spin w-8 h-8 border-2 border-primary-600 border-t-transparent rounded-full mx-auto"></div>
      </div>
    )
  }

  if (!skill) {
    return (
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-8 text-center">
        <p className="text-neutral-600 dark:text-neutral-400">Skill not found</p>
        <Link href="/dashboard/skills" className="mt-4 inline-flex items-center gap-2 text-primary-600 hover:text-primary-500">
          <ArrowLeft className="w-4 h-4" />
          Back to Skills
        </Link>
      </div>
    )
  }

  const userRole = session?.user?.role
  const canManage = userRole === 'PLATFORM_ADMIN' || userRole === 'PLATFORM_OPERATOR' || userRole === 'CUSTOMER_ADMIN'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/dashboard/skills" className="p-2 text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">{skill.name}</h1>
            <p className="text-neutral-600 dark:text-neutral-400">v{skill.version} • {skill.tenantId ? 'Custom' : 'Global'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={skill.isActive ? 'success' : 'default'}>{skill.isActive ? 'Active' : 'Inactive'}</Badge>
          {canManage && (
            <>
              <Button variant="outline" size="sm"><Edit className="w-4 h-4 mr-2" />Edit</Button>
              <Button variant="destructive" size="sm" onClick={() => { if(confirm('Delete this skill?')) router.push('/dashboard/skills') }}><Trash2 className="w-4 h-4 mr-2" />Delete</Button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader><CardTitle>Description</CardTitle></CardHeader>
            <CardContent><p className="text-neutral-600 dark:text-neutral-400 whitespace-pre-wrap">{skill.description}</p></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Purpose</CardTitle></CardHeader>
            <CardContent><p className="text-neutral-600 dark:text-neutral-400 whitespace-pre-wrap">{skill.purpose}</p></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Instructions</CardTitle></CardHeader>
            <CardContent><p className="text-neutral-600 dark:text-neutral-400 whitespace-pre-wrap bg-neutral-50 dark:bg-neutral-800 p-4 rounded-lg">{skill.instructions}</p></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Constraints</CardTitle></CardHeader>
            <CardContent>
              {skill.constraints.length === 0 ? (
                <p className="text-neutral-500 dark:text-neutral-400">No constraints defined</p>
              ) : (
                <ul className="space-y-2">
                  {skill.constraints.map((c, i) => (
                    <li key={i} className="flex items-center gap-2 text-neutral-600 dark:text-neutral-400">
                      <CheckCircle className="w-4 h-4 text-green-600" />
                      {c}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Configuration</CardTitle>
              {canManage && <Button variant="ghost" size="sm">Edit</Button>}
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4">
                <div><p className="text-sm text-neutral-500 dark:text-neutral-400">Required Tools</p>
                  <p className="font-medium">{skill.requiredTools.length ? skill.requiredTools.join(', ') : 'None'}</p>
                </div>
                <div><p className="text-sm text-neutral-500 dark:text-neutral-400">Inputs</p>
                  <p className="font-medium text-sm font-mono">{JSON.stringify(skill.inputs, null, 2)}</p>
                </div>
                <div><p className="text-sm text-neutral-500 dark:text-neutral-400">Outputs</p>
                  <p className="font-medium text-sm font-mono">{JSON.stringify(skill.outputs, null, 2)}</p>
                </div>
                <div><p className="text-sm text-neutral-500 dark:text-neutral-400">Failure Handling</p>
                  <p className="font-medium text-sm font-mono">{JSON.stringify(skill.failureHandling, null, 2)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Evaluation Cases</CardTitle></CardHeader>
            <CardContent>
              {skill.evaluationCases.length === 0 ? (
                <p className="text-neutral-500 dark:text-neutral-400">No evaluation cases defined</p>
              ) : (
                <div className="space-y-3">
                  {skill.evaluationCases.map((ec, i) => (
                    <div key={i} className="p-4 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
                      <p className="font-medium">Case {i + 1}</p>
                      <p className="text-sm font-mono text-neutral-600 dark:text-neutral-400">{JSON.stringify(ec, null, 2)}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Metadata</CardTitle></CardHeader>
            <CardContent>
              <div className="grid gap-2 text-sm">
                <div><span className="text-neutral-500">Used by:</span> <span className="font-medium ml-2">{skill._count?.agents || 0} agents</span></div>
                <div><span className="text-neutral-500">Created:</span> <span className="font-medium ml-2">{formatDate(skill.createdAt)}</span></div>
                <div><span className="text-neutral-500">Updated:</span> <span className="font-medium ml-2">{formatDate(skill.updatedAt)}</span></div>
                <div><span className="text-neutral-500">Type:</span> <span className="font-medium ml-2">{skill.tenantId ? 'Custom' : 'Global'}</span></div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}