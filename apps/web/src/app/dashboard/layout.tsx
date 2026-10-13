import { ReactNode } from 'react'
import { DashboardNav } from './DashboardNav'

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: 'LayoutDashboard' },
  { name: 'Team', href: '/dashboard/team', icon: 'Network' },
  { name: 'Agents', href: '/dashboard/agents', icon: 'Bot' },
  { name: 'Approvals', href: '/dashboard/approvals', icon: 'CheckCircle2' },
  { name: 'Improvements', href: '/dashboard/improvements', icon: 'Sparkles' },
  { name: 'Skills', href: '/dashboard/skills', icon: 'Zap' },
  { name: 'Knowledge', href: '/dashboard/knowledge', icon: 'Brain' },
  { name: 'Workflows', href: '/dashboard/workflows', icon: 'BookOpen' },
  { name: 'Integrations', href: '/dashboard/integrations', icon: 'Shield' },
  { name: 'Analytics', href: '/dashboard/analytics', icon: 'BarChart2' },
]

const adminNavigation = [
  { name: 'Tenants', href: '/dashboard/tenants', icon: 'Building' },
  { name: 'Users', href: '/dashboard/users', icon: 'Users' },
  { name: 'Settings', href: '/dashboard/settings', icon: 'Settings' },
]

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <DashboardNav
      navigation={navigation}
      adminNavigation={adminNavigation}
    >
      {children}
    </DashboardNav>
  )
}