'use client'

import { useSession } from 'next-auth/react'
import { Bot, Zap, Brain, BookOpen, Shield, Clock, CheckCircle, TrendingUp, UserPlus } from 'lucide-react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'

const stats = [
  { name: 'Active Agents', value: '1', change: '+1 this month', icon: Bot, color: 'text-blue-600 bg-blue-100 dark:bg-blue-900/30' },
  { name: 'Skills Configured', value: '2', change: '2 active', icon: Zap, color: 'text-purple-600 bg-purple-100 dark:bg-purple-900/30' },
  { name: 'Knowledge Docs', value: '3', change: '3 indexed', icon: Brain, color: 'text-green-600 bg-green-100 dark:bg-green-900/30' },
  { name: 'Workflows Run', value: '0', change: 'Ready to start', icon: BookOpen, color: 'text-orange-600 bg-orange-100 dark:bg-orange-900/30' },
]

const recentActivity = [
  { id: '1', type: 'agent_created', message: 'Agent "Sarah - Sales Assistant" created', time: new Date(Date.now() - 2 * 60 * 60 * 1000), status: 'success' },
  { id: '2', type: 'skill_added', message: 'Skill "lead_follow_up" added to agent', time: new Date(Date.now() - 4 * 60 * 60 * 1000), status: 'success' },
  { id: '3', type: 'knowledge_uploaded', message: '3 knowledge documents uploaded and indexed', time: new Date(Date.now() - 6 * 60 * 60 * 1000), status: 'success' },
  { id: '4', type: 'integration_configured', message: 'Gmail and HubSpot integrations configured', time: new Date(Date.now() - 8 * 60 * 60 * 1000), status: 'pending' },
]

const nextSteps = [
  { title: 'Complete onboarding', description: 'Set up your business profile, goals, and workflows', href: '/dashboard/onboarding', icon: UserPlus, color: 'bg-indigo-100 dark:bg-indigo-900/30' },
  { title: 'Complete agent configuration', description: 'Review and finalize agent permissions and approval policies', href: '/dashboard/agents', icon: Bot, color: 'bg-blue-100 dark:bg-blue-900/30' },
  { title: 'Run evaluation suite', description: 'Test your agent against evaluation cases before production', href: '/dashboard/agents', icon: CheckCircle, color: 'bg-green-100 dark:bg-green-900/30' },
  { title: 'Connect integrations', description: 'Authenticate Gmail and HubSpot for production use', href: '/dashboard/integrations', icon: Shield, color: 'bg-purple-100 dark:bg-purple-900/30' },
  { title: 'Deploy to production', description: 'Launch your AI employee after successful evaluation', href: '/dashboard/agents', icon: TrendingUp, color: 'bg-orange-100 dark:bg-orange-900/30' },
]

export default function DashboardPage() {
  const { data: session } = useSession()
  const user = session?.user

  return (
    <div className="space-y-8">
      {/* Welcome header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-neutral-900 dark:text-neutral-50">
          Welcome back, {user?.name?.split(' ')[0] || 'there'}
        </h1>
        <p className="text-neutral-600 dark:text-neutral-400 mt-1">
          Here&apos;s an overview of your AI workforce platform.
        </p>
      </div>

      {/* Stats grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.name} className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{stat.name}</p>
                <p className="text-3xl font-bold text-neutral-900 dark:text-neutral-50 mt-1">{stat.value}</p>
                <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">{stat.change}</p>
              </div>
              <div className={clsx('w-12 h-12 rounded-xl flex items-center justify-center', stat.color)}>
                <stat.icon className="w-6 h-6" aria-hidden="true" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Main content grid */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Recent activity */}
        <div className="lg:col-span-2 bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800">
          <div className="px-6 py-4 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">Recent Activity</h2>
            <Link href="/dashboard/activity" className="text-sm text-primary-600 hover:text-primary-500 font-medium">
              View all
            </Link>
          </div>
          <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {recentActivity.map((activity) => (
              <div key={activity.id} className="px-6 py-4 flex items-start gap-4">
                <div className={clsx('w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0', activity.status === 'success' ? 'bg-green-100 dark:bg-green-900/30' : 'bg-yellow-100 dark:bg-yellow-900/30')}>
                  {activity.status === 'success' ? (
                    <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400" />
                  ) : (
                    <Clock className="w-4 h-4 text-yellow-600 dark:text-yellow-400" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-neutral-900 dark:text-neutral-50">{activity.message}</p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                    {formatDistanceToNow(activity.time, { addSuffix: true })}
                  </p>
                </div>
                <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', activity.status === 'success' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300')}>
                  {activity.status === 'success' ? 'Completed' : 'Pending'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Next steps */}
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-6">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50 mb-4">Next Steps</h2>
          <div className="space-y-3">
            {nextSteps.map((step) => (
              <Link key={step.title} href={step.href} className="block p-4 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:border-primary-300 dark:hover:border-primary-700 hover:bg-primary-50 dark:hover:bg-primary-900/10 transition-colors group">
                <div className="flex items-start gap-3">
                  <div className={clsx('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 group-hover:bg-primary-100 dark:group-hover:bg-primary-900/30 transition-colors', step.color || 'bg-primary-100 dark:bg-primary-900/30')}>
                    <step.icon className="w-4 h-4 text-primary-600 dark:text-primary-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50 group-hover:text-primary-600 dark:group-hover:text-primary-400 transition-colors">{step.title}</p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{step.description}</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-6">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50 mb-4">Quick Actions</h2>
        <div className="flex flex-wrap gap-3">
          <Link href="/dashboard/agents/new" className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors">
            <Bot className="w-4 h-4" />
            Create New Agent
          </Link>
          <Link href="/dashboard/skills/new" className="inline-flex items-center gap-2 px-4 py-2 border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 text-sm font-medium rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
            <Zap className="w-4 h-4" />
            Add Skill
          </Link>
          <Link href="/dashboard/knowledge/upload" className="inline-flex items-center gap-2 px-4 py-2 border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 text-sm font-medium rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
            <Brain className="w-4 h-4" />
            Upload Knowledge
          </Link>
          <Link href="/dashboard/workflows/new" className="inline-flex items-center gap-2 px-4 py-2 border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 text-sm font-medium rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
            <BookOpen className="w-4 h-4" />
            Create Workflow
          </Link>
        </div>
      </div>
    </div>
  )
}

function clsx(...classes: (string | undefined | false)[]) {
  return classes.filter(Boolean).join(' ')
}