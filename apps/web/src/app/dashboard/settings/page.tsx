'use client'

import { useSession } from 'next-auth/react'
import { User, Bell, Shield, Palette, Globe, Database, Key, Trash2, LogOut } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '@ai-workforce/ui'

export default function SettingsPage() {
  const { data: session } = useSession()
  const user = session?.user

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">Settings</h1>
        <p className="text-neutral-600 dark:text-neutral-400 mt-1">Manage your account and workspace preferences</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center gap-6">
              <div className="w-20 h-20 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
                <User className="w-10 h-10 text-primary-600 dark:text-primary-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">{user?.name || 'Unnamed User'}</h3>
                <p className="text-neutral-500 dark:text-neutral-400">{user?.email}</p>
                <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">Role: {user?.role?.replace('_', ' ')}</p>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Input label="Full Name" defaultValue={user?.name || ''} />
              <Input label="Email" defaultValue={user?.email || ''} type="email" disabled />
            </div>
            <Button>Save Changes</Button>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Preferences</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-neutral-900 dark:text-neutral-50">Email Notifications</p>
                  <p className="text-sm text-neutral-500 dark:text-neutral-400">Receive email updates</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only peer" defaultChecked />
                  <div className="w-11 h-6 bg-neutral-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary-300 dark:peer-focus:ring-primary-800 rounded-full peer dark:bg-neutral-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-neutral-600 peer-checked:bg-primary-600"></div>
                </label>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-neutral-900 dark:text-neutral-50">Dark Mode</p>
                  <p className="text-sm text-neutral-500 dark:text-neutral-400">Use dark theme</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only peer" />
                  <div className="w-11 h-6 bg-neutral-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary-300 dark:peer-focus:ring-primary-800 rounded-full peer dark:bg-neutral-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-neutral-600 peer-checked:bg-primary-600"></div>
                </label>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Security</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button variant="outline" className="w-full justify-start gap-3">
                <Shield className="w-4 h-4" />
                Change Password
              </Button>
              <Button variant="outline" className="w-full justify-start gap-3">
                <Key className="w-4 h-4" />
                Manage API Keys
              </Button>
              <Button variant="outline" className="w-full justify-start gap-3" onClick={() => window.location.href = '/api/auth/signout'}>
                <LogOut className="w-4 h-4" />
                Sign Out Everywhere
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="border-red-200 dark:border-red-800">
          <CardHeader>
            <CardTitle className="text-red-600 dark:text-red-400 flex items-center gap-2">
              <Trash2 className="w-5 h-5" />
              Danger Zone
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Once you delete your account, there is no going back. Please be certain.
            </p>
            <Button variant="destructive" className="w-full">Delete Account</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Workspace Name</label>
              <Input defaultValue="Demo Marketing Agency" />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Industry</label>
              <Input defaultValue="Marketing" />
            </div>
            <Button>Update Workspace</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}