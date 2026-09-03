'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { ArrowLeft, CreditCard, RotateCcw, AlertTriangle, CheckCircle, ChevronRight, FileText, Download, Calendar, DollarSign, TrendingUp } from 'lucide-react'
import Link from 'next/link'
import { Button, Badge, Card, CardContent, CardHeader, CardTitle, CardDescription } from '@ai-workforce/ui'
import { formatDate, formatCurrency } from '@ai-workforce/ui'

interface Plan {
  id: string
  name: string
  tier: string
  description: string
  priceMonthly: number
  priceYearly: number
  currency: string
  features: string[]
  limits: {
    maxAgents: number
    maxWorkflows: number
    maxSkills: number
    maxKnowledgeDocuments: number
    maxIntegrations: number
    maxTeamMembers: number
    apiCallsPerMonth: number
    storageGB: number
    supportLevel: string
    customIntegrations: boolean
    sso: boolean
    auditLogs: boolean
  }
  isActive: boolean
}

interface Subscription {
  id: string
  planId: string
  planTier: string
  status: string
  interval: string
  currentPeriodStart: string
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
  canceledAt: string | null
  plan: {
    id: string
    name: string
    tier: string
    priceMonthly: number
    priceYearly: number
    currency: string
  }
}

interface Invoice {
  id: string
  amount: number
  currency: string
  status: string
  invoicePdf?: string
  hostedInvoiceUrl?: string
  periodStart: string
  periodEnd: string
  dueDate?: string
  paidAt?: string
  createdAt: string
}

export default function BillingPage() {
  const { data: session } = useSession()
  const [activeTab, setActiveTab] = useState<'plans' | 'subscription' | 'invoices'>('subscription')
  const [plans, setPlans] = useState<Plan[]>([])
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(false)
  const [invoicePagination, setInvoicePagination] = useState({ page: 1, pageSize: 10, total: 0, totalPages: 0 })

  const fetchPlans = async () => {
    try {
      const res = await fetch('/api/billing/plans')
      if (res.ok) setPlans(await res.json())
    } catch (error) {
      console.error('Failed to fetch plans:', error)
    }
  }

  const fetchSubscription = async () => {
    try {
      const res = await fetch('/api/billing/subscriptions')
      if (res.ok) {
        const data = await res.json()
        setSubscription(data.subscription)
      } else {
        setSubscription(null)
      }
    } catch (error) {
      console.error('Failed to fetch subscription:', error)
    }
  }

  const fetchInvoices = async () => {
    try {
      const params = new URLSearchParams({
        page: invoicePagination.page.toString(),
        pageSize: invoicePagination.pageSize.toString(),
      })
      const res = await fetch(`/api/billing/invoices?${params}`)
      if (res.ok) {
        const data = await res.json()
        setInvoices(data.data)
        setInvoicePagination(prev => ({
          ...prev,
          total: data.pagination.total,
          totalPages: data.pagination.totalPages,
        }))
      }
    } catch (error) {
      console.error('Failed to fetch invoices:', error)
    }
  }

  useEffect(() => {
    fetchPlans()
    fetchSubscription()
  }, [])

  useEffect(() => {
    fetchInvoices()
  }, [invoicePagination.page])

  const handleSubscriptionAction = async (action: 'cancel' | 'resume' | 'change_plan', data?: any) => {
    if (!subscription) return
    try {
      const res = await fetch(`/api/billing/subscriptions/${subscription.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...data }),
      })
      if (res.ok) {
        const data = await res.json()
        setSubscription(data)
      } else {
        alert('Failed to process action')
      }
    } catch (error) {
      console.error('Action failed:', error)
      alert('Action failed')
    }
  }

  const statusColors: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
    active: 'success',
    trial: 'info',
    past_due: 'warning',
    cancelled: 'danger',
    paused: 'default',
    incomplete: 'warning',
  }

  const tierOrder = ['starter', 'growth', 'enterprise']

  const tabs = [
    { id: 'subscription', label: 'Subscription', icon: CreditCard },
    { id: 'plans', label: 'Plans', icon: TrendingUp },
    { id: 'invoices', label: 'Invoices', icon: FileText },
  ] as const

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">Billing</h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1">Manage your subscription, plans, and invoices</p>
        </div>
      </div>

      <div className="flex gap-2 border-b border-neutral-200 dark:border-neutral-800">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-2 ${
              activeTab === tab.id
                ? 'border-primary-600 text-primary-600'
                : 'border-transparent text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'subscription' && (
        <div className="space-y-6">
          {subscription ? (
            <div className="space-y-6">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <div>
                    <CardTitle>{subscription.plan?.name || 'Current Plan'}</CardTitle>
                    <CardDescription>Current subscription status</CardDescription>
                  </div>
                  <Badge variant={statusColors[subscription.status] || 'default'} className="text-lg">
                    {subscription.status.charAt(0).toUpperCase() + subscription.status.slice(1).replace('_', ' ')}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid gap-4 md:grid-cols-3">
                    <div className="p-4 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
                      <p className="text-sm text-neutral-500 dark:text-neutral-400">Billing Cycle</p>
                      <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-50 capitalize">{subscription.interval}</p>
                    </div>
                    <div className="p-4 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
                      <p className="text-sm text-neutral-500 dark:text-neutral-400">Amount</p>
                      <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">
                        {formatCurrency(subscription.plan?.priceMonthly || 0)}/{subscription.interval === 'monthly' ? 'mo' : 'yr'}
                      </p>
                    </div>
                    <div className="p-4 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
                      <p className="text-sm text-neutral-500 dark:text-neutral-400">Next Billing</p>
                      <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">{formatDate(subscription.currentPeriodEnd)}</p>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="p-4 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
                      <p className="text-sm text-neutral-500 dark:text-neutral-400">Status</p>
                      <p className="font-medium capitalize">{subscription.status.replace('_', ' ')}</p>
                      {subscription.cancelAtPeriodEnd && (
                        <p className="text-sm text-yellow-600 dark:text-yellow-400 mt-1">Cancels at period end</p>
                      )}
                    </div>
                    <div className="p-4 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
                      <p className="text-sm text-neutral-500 dark:text-neutral-400">Plan</p>
                      <p className="font-medium">{subscription.plan?.name}</p>
                      <p className="text-sm text-neutral-500 dark:text-neutral-400">{subscription.planTier}</p>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-neutral-200 dark:border-neutral-800 flex gap-3">
                    {subscription.status === 'active' && subscription.cancelAtPeriodEnd && (
                      <Button variant="outline" onClick={() => handleSubscriptionAction('resume')}>
                        <RotateCcw className="w-4 h-4 mr-2" />
                        Resume Subscription
                      </Button>
                    )}
                    {subscription.status === 'active' && !subscription.cancelAtPeriodEnd && (
                      <Button variant="destructive" onClick={() => handleSubscriptionAction('cancel', { immediately: false })}>
                        <AlertTriangle className="w-4 h-4 mr-2" />
                        Cancel at Period End
                      </Button>
                    )}
                    <Button variant="outline" onClick={() => setActiveTab('plans')}>
                      <TrendingUp className="w-4 h-4 mr-2" />
                      Change Plan
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Plan Limits & Usage</CardTitle>
                  <CardDescription>Your current plan limits and usage</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {/* Usage bars would go here */}
                    <p className="text-neutral-500 dark:text-neutral-400 text-center py-8">
                      Usage tracking coming soon
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : (
            <div className="text-center py-12">
              <CreditCard className="w-16 h-16 text-neutral-400 mx-auto mb-4" />
              <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-50 mb-2">No active subscription</h2>
              <p className="text-neutral-600 dark:text-neutral-400 mb-6 max-w-md mx-auto">
                You don&apos;t have an active subscription. Choose a plan below to get started.
              </p>
              <Button onClick={() => setActiveTab('plans')} className="w-auto">
                <TrendingUp className="w-4 h-4 mr-2" />
                View Plans
              </Button>
            </div>
          )}
        </div>
      )}

      {activeTab === 'plans' && (
        <div className="space-y-6">
          <div className="grid gap-6 md:grid-cols-3">
            {plans.map((plan) => (
              <Card key={plan.id} className="relative flex flex-col">
                {plan.tier === 'growth' && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="bg-primary-600 text-white text-xs font-medium px-3 py-1 rounded-full">
                      Most Popular
                    </span>
                  </div>
                )}
                <CardHeader>
                  <CardTitle>{plan.name}</CardTitle>
                  <CardDescription>{plan.description}</CardDescription>
                </CardHeader>
                <CardContent className="flex-1 space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-baseline gap-2">
                      <span className="text-4xl font-bold text-neutral-900 dark:text-neutral-50">
                        {formatCurrency(plan.priceMonthly)}
                      </span>
                      <span className="text-neutral-500 dark:text-neutral-400">/mo</span>
                    </div>
                    <div className="text-sm text-neutral-500 dark:text-neutral-400">
                      {formatCurrency(plan.priceYearly)}/yr (save {Math.round((1 - plan.priceYearly / (plan.priceMonthly * 12)) * 100)}%)
                    </div>
                  </div>

                  <ul className="space-y-2">
                    {plan.features.map((feature, i) => (
                      <li key={i} className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
                        <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                        {feature}
                      </li>
                    ))}
                  </ul>

                  <Button
                    className="w-full"
                    variant={plan.tier === 'growth' ? 'primary' : 'outline'}
                    onClick={() => alert(`Subscribe to ${plan.name} plan - coming soon`)}
                  >
                    {plan.tier === 'growth' ? 'Get Started' : 'Select Plan'}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'invoices' && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Invoice History</CardTitle>
            </CardHeader>
            <CardContent>
              {invoices.length === 0 ? (
                <p className="text-neutral-500 dark:text-neutral-400 text-center py-8">No invoices found</p>
              ) : (
                <div className="space-y-3">
                  {invoices.map((invoice) => (
                    <div key={invoice.id} className="flex items-center justify-between p-4 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
                      <div className="flex items-center gap-4">
                        <FileText className="w-6 h-6 text-neutral-400" />
                        <div>
                          <p className="font-medium">Invoice #{invoice.id.slice(-8)}</p>
                          <p className="text-sm text-neutral-500 dark:text-neutral-400">
                            {formatDate(invoice.periodStart)} - {formatDate(invoice.periodEnd)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <Badge variant={
                          invoice.status === 'paid' ? 'success' :
                          invoice.status === 'open' ? 'warning' :
                          invoice.status === 'void' ? 'danger' : 'default'
                        }>
                          {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                        </Badge>
                        <span className="font-medium tabular-nums">{formatCurrency(invoice.amount)}</span>
                        {invoice.hostedInvoiceUrl && (
                          <a href={invoice.hostedInvoiceUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-primary-600 hover:text-primary-500 text-sm">
                            <FileText className="w-4 h-4" />
                            View
                          </a>
                        )}
                        {invoice.invoicePdf && (
                          <a href={invoice.invoicePdf} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-primary-600 hover:text-primary-500 text-sm">
                            <Download className="w-4 h-4" />
                            PDF
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {invoicePagination.totalPages > 1 && (
                <div className="mt-6 flex items-center justify-between">
                  <p className="text-sm text-neutral-500 dark:text-neutral-400">
                    Page {invoicePagination.page} of {invoicePagination.totalPages} ({invoicePagination.total} total)
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={invoicePagination.page === 1}
                      onClick={() => setInvoicePagination(prev => ({ ...prev, page: prev.page - 1 }))}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={invoicePagination.page === invoicePagination.totalPages}
                      onClick={() => setInvoicePagination(prev => ({ ...prev, page: prev.page + 1 }))}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
