import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@ai-workforce/ui'
import { Settings, Shield, Users, Database, Bell, Key, Globe, Palette } from 'lucide-react'

const settingsSections = [
  {
    title: 'General',
    description: 'Platform-wide settings and configuration',
    icon: Settings,
    items: [
      { label: 'Platform Name', description: 'AI Workforce Platform' },
      { label: 'Default Language', description: 'English' },
      { label: 'Timezone', description: 'UTC' },
      { label: 'Maintenance Mode', description: 'Disabled' },
    ],
  },
  {
    title: 'Security',
    description: 'Authentication and authorization settings',
    icon: Shield,
    items: [
      { label: 'Session Timeout', description: '24 hours' },
      { label: 'MFA Required', description: 'Platform admins only' },
      { label: 'Password Policy', description: 'Min 12 chars, complexity required' },
      { label: 'Audit Logging', description: 'Enabled' },
    ],
  },
  {
    title: 'Users & Roles',
    description: 'Manage platform user roles and permissions',
    icon: Users,
    items: [
      { label: 'Platform Admins', description: 'Full platform access' },
      { label: 'Platform Operators', description: 'Operational access, no admin' },
      { label: 'Default Tenant Role', description: 'Customer Admin' },
      { label: 'Invitation Expiry', description: '7 days' },
    ],
  },
  {
    title: 'Database',
    description: 'Database configuration and maintenance',
    icon: Database,
    items: [
      { label: 'Backup Schedule', description: 'Daily at 2 AM UTC' },
      { label: 'Retention Period', description: '30 days' },
      { label: 'Read Replicas', description: '2 replicas' },
      { label: 'Connection Pool', description: '100 connections' },
    ],
  },
  {
    title: 'Notifications',
    description: 'Alert and notification settings',
    icon: Bell,
    items: [
      { label: 'Incident Alerts', description: 'Email + Slack' },
      { label: 'Billing Alerts', description: 'Email only' },
      { label: 'System Health', description: 'Email + PagerDuty' },
      { label: 'Weekly Reports', description: 'Every Monday 9 AM' },
    ],
  },
  {
    title: 'API Keys',
    description: 'Manage platform API keys and integrations',
    icon: Key,
    items: [
      { label: 'Stripe', description: 'Configured' },
      { label: 'SendGrid', description: 'Configured' },
      { label: 'Slack', description: 'Configured' },
      { label: 'PagerDuty', description: 'Not configured' },
    ],
  },
]

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">Settings</h1>
        <p className="text-neutral-500 dark:text-neutral-400 mt-1">Platform configuration and administration</p>
      </div>

      <div className="space-y-6">
        {settingsSections.map((section) => (
          <Card key={section.title}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
                  <section.icon className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                </div>
                <div>
                  <CardTitle>{section.title}</CardTitle>
                  <CardDescription>{section.description}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {section.items.map((item, index) => (
                  <div key={index} className="space-y-1">
                    <dt className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{item.label}</dt>
                    <dd className="text-sm text-neutral-500 dark:text-neutral-400">{item.description}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}