'use client'

import { useSession } from 'next-auth/react'
import { BarChart2, TrendingUp, Activity, DollarSign, Bot, Users, Zap, FileText } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@ai-workforce/ui'

const metrics = [
  { name: 'Total Agents', value: '1', change: '+1 this month', icon: Bot, color: 'text-blue-600 bg-blue-100 dark:bg-blue-900/30' },
  { name: 'Active Workflows', value: '0', change: 'Ready to run', icon: Activity, color: 'text-green-600 bg-green-100 dark:bg-green-900/30' },
  { name: 'Skills Configured', value: '2', change: '2 active', icon: Zap, color: 'text-purple-600 bg-purple-100 dark:bg-purple-900/30' },
  { name: 'Knowledge Docs', value: '3', change: '3 indexed', icon: FileText, color: 'text-orange-600 bg-orange-100 dark:bg-orange-900/30' },
  { name: 'Team Members', value: '2', change: '2 active', icon: Users, color: 'text-indigo-600 bg-indigo-100 dark:bg-indigo-900/30' },
  { name: 'Integrations', value: '2', change: '2 connected', icon: TrendingUp, color: 'text-pink-600 bg-pink-100 dark:bg-pink-900/30' },
]

export default function AnalyticsPage() {
  const { data: session } = useSession()

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">Analytics</h1>
        <p className="text-neutral-600 dark:text-neutral-400 mt-1">Platform usage and performance metrics</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {metrics.map((metric) => (
          <Card key={metric.name}>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{metric.name}</p>
                  <p className="text-3xl font-bold text-neutral-900 dark:text-neutral-50 mt-1">{metric.value}</p>
                  <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">{metric.change}</p>
                </div>
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${metric.color}`}>
                  <metric.icon className="w-6 h-6" aria-hidden="true" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Workflow Execution Trends</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64 flex items-end justify-around p-4">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, i) => (
                <div key={day} className="flex flex-col items-center gap-2">
                  <div
                    className="w-10 bg-primary-600 rounded-t transition-all hover:bg-primary-700"
                    style={{ height: `${Math.max(20, 20 + i * 15)}px` }}
                  />
                  <span className="text-xs text-neutral-500">{day}</span>
                </div>
              ))}
            </div>
            <p className="text-sm text-neutral-500 dark:text-neutral-400 text-center mt-4">No workflow executions yet</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Agent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {[
                { agent: 'Sarah - Sales Assistant', runs: 0, success: 0, avgTime: '0s' },
              ].map((a) => (
                <div key={a.agent} className="flex items-center justify-between p-4 bg-neutral-50 dark:bg-neutral-800/50 rounded-lg">
                  <div>
                    <p className="font-medium text-neutral-900 dark:text-neutral-50">{a.agent}</p>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">{a.runs} runs • {a.success}% success</p>
                  </div>
                  <span className="text-neutral-500">{a.avgTime}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}