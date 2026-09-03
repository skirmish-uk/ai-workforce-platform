import { prisma } from '@ai-workforce/db'
import { z } from 'zod'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
})

export interface Invoice {
  id: string
  tenantId: string
  amount: number // in cents
  currency: string
  status: string // Prisma returns string, but valid values are: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible'
  pdfUrl?: string | null
  hostedUrl?: string | null
  createdAt: Date
  updatedAt: Date
  subscriptionId?: string
  subscription?: {
    id: string
    plan: string
    status: string
  }
}

export interface InvoiceListParams {
  tenantId: string
  limit?: number
  offset?: number
  status?: string
}

export async function listInvoices(params: InvoiceListParams): Promise<{ invoices: Invoice[]; total: number }> {
  const { tenantId, limit = 20, offset = 0, status } = params

  const where: any = { tenantId }
  if (status) where.status = status

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.invoice.count({ where }),
  ])

  return { invoices, total }
}

export async function getInvoiceById(invoiceId: string): Promise<Invoice | null> {
  return prisma.invoice.findUnique({ where: { id: invoiceId } })
}

export async function syncInvoiceFromStripe(stripeInvoice: Stripe.Invoice): Promise<Invoice> {
  const subscription = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId: stripeInvoice.subscription as string },
  })

  if (!subscription) {
    throw new Error(`Subscription not found for invoice ${stripeInvoice.id}`)
  }

  const invoice = await prisma.invoice.upsert({
    where: { id: `inv_${stripeInvoice.id}` },
    update: {
      amount: stripeInvoice.amount_paid,
      currency: stripeInvoice.currency.toUpperCase(),
      status: stripeInvoice.status ?? 'draft',
      pdfUrl: stripeInvoice.invoice_pdf,
      hostedUrl: stripeInvoice.hosted_invoice_url,
    },
    create: {
      id: `inv_${stripeInvoice.id}`,
      tenantId: subscription.tenantId,
      subscriptionId: subscription.id,
      amount: stripeInvoice.amount_paid,
      currency: stripeInvoice.currency.toUpperCase(),
      status: stripeInvoice.status ?? 'draft',
      pdfUrl: stripeInvoice.invoice_pdf,
      hostedUrl: stripeInvoice.hosted_invoice_url,
    },
  })

  return invoice
}

export async function syncInvoicesForTenant(tenantId: string): Promise<Invoice[]> {
  const subscriptions = await prisma.subscription.findMany({
    where: { tenantId },
    select: { stripeSubscriptionId: true },
  })

  const stripeSubscriptionIds = subscriptions
    .map(s => s.stripeSubscriptionId)
    .filter((id): id is string => id !== null)
  if (stripeSubscriptionIds.length === 0) return []

  const invoices: Invoice[] = []

  for (const subId of stripeSubscriptionIds) {
    const stripeInvoices = await stripe.invoices.list({
      subscription: subId,
      limit: 100,
    })

    for (const inv of stripeInvoices.data) {
      const synced = await syncInvoiceFromStripe(inv)
      invoices.push(synced)
    }
  }

  return invoices
}

export async function getInvoicePdfUrl(invoiceId: string): Promise<string | null> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
  return invoice?.pdfUrl || null
}

export async function sendInvoiceEmail(invoiceId: string): Promise<boolean> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
  if (!invoice || !invoice.hostedUrl) return false

  // TODO: Send email with invoice link
  // This would integrate with your email service
  console.log(`Sending invoice ${invoiceId} to tenant ${invoice.tenantId}`)
  return true
}