import { prisma } from '@ai-workforce/db'
import Stripe from 'stripe'
import { syncInvoiceFromStripe } from './invoices'
import { SubscriptionStatus, mapStripeStatus } from './subscriptions'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
})

export const STRIPE_WEBHOOK_EVENTS = [
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'invoice.finalized',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'payment_method.attached',
  'payment_method.detached',
  'checkout.session.completed',
] as const

export type StripeWebhookEventType = typeof STRIPE_WEBHOOK_EVENTS[number]

export interface WebhookEvent {
  id: string
  type: string
  data: any
  created: number
}

export async function handleStripeWebhook(event: Stripe.Event): Promise<void> {
  console.log(`Processing Stripe webhook: ${event.type}`)

  switch (event.type) {
    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice)
      break
    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice)
      break
    case 'invoice.finalized':
      await handleInvoiceFinalized(event.data.object as Stripe.Invoice)
      break
    case 'customer.subscription.created':
      await handleSubscriptionCreated(event.data.object as Stripe.Subscription)
      break
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object as Stripe.Subscription)
      break
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription)
      break
    case 'customer.subscription.trial_will_end':
      await handleTrialWillEnd(event.data.object as Stripe.Subscription)
      break
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session)
      break
    default:
      console.log(`Unhandled webhook event type: ${event.type}`)
  }
}

async function handleInvoicePaymentSucceeded(invoice: any): Promise<void> {
  console.log(`Invoice payment succeeded: ${invoice.id}`)

  // Sync invoice to local DB
  await syncInvoiceFromStripe(invoice)

  // Update subscription status if needed
  if (invoice.subscription) {
    const subscription = await prisma.subscription.findUnique({
      where: { stripeSubscriptionId: invoice.subscription as string },
    })

    if (subscription && subscription.status === SubscriptionStatus.PAST_DUE) {
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: SubscriptionStatus.ACTIVE },
      })
    }
  }
}

async function handleInvoicePaymentFailed(invoice: any): Promise<void> {
  console.log(`Invoice payment failed: ${invoice.id}`)

  await syncInvoiceFromStripe(invoice)

  if (invoice.subscription) {
    const subscription = await prisma.subscription.findUnique({
      where: { stripeSubscriptionId: invoice.subscription as string },
    })

if (subscription) {
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: SubscriptionStatus.PAST_DUE },

        // TODO: Send payment failed notification to tenant
      })
    }
  }
}

async function handleInvoiceFinalized(invoice: any): Promise<void> {
  console.log(`Invoice finalized: ${invoice.id}`)
  await syncInvoiceFromStripe(invoice)
}

async function handleSubscriptionCreated(subscription: any): Promise<void> {
  console.log(`Subscription created: ${subscription.id}`)

  const localSubscription = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId: subscription.id },
  })

  if (!localSubscription) {
    // This might be a new subscription created via Stripe Checkout
    // The local record should already exist from our createSubscription flow
    console.log(`Local subscription not found for ${subscription.id}`)
  }
}

async function handleSubscriptionUpdated(subscription: any): Promise<void> {
  console.log(`Subscription updated: ${subscription.id}`)

  const localSubscription = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId: subscription.id },
  })

  if (!localSubscription) {
    console.log(`Local subscription not found for ${subscription.id}`)
    return
  }

// Update local subscription with Stripe data
  await prisma.subscription.update({
    where: { id: localSubscription.id },
    data: {
      status: mapStripeStatus(subscription.status),
      currentPeriodStart: new Date(subscription.current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
      trialStart: subscription.trial_start ? new Date(subscription.trial_start * 1000) : null,
      trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
      stripePriceId: subscription.items.data[0]?.price.id || null,
    },
  })
}

async function handleSubscriptionDeleted(subscription: any): Promise<void> {
  console.log(`Subscription deleted: ${subscription.id}`)

  const localSubscription = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId: subscription.id },
  })

  if (localSubscription) {
    await prisma.subscription.update({
      where: { id: localSubscription.id },
      data: {
        status: SubscriptionStatus.CANCELLED,
        canceledAt: new Date(),
      },
    })
  }
}

async function handleTrialWillEnd(subscription: any): Promise<void> {
  console.log(`Trial will end for subscription: ${subscription.id}`)

  // TODO: Send trial ending notification to tenant
  // This would typically be sent 3 days before trial ends
}

async function handleCheckoutCompleted(session: any): Promise<void> {
  console.log(`Checkout completed: ${session.id}`)

  if (session.mode === 'subscription' && session.subscription) {
    const subscription = await stripe.subscriptions.retrieve(session.subscription as string)
    await handleSubscriptionCreated(subscription)
  }
}

export function constructStripeEvent(payload: string | Buffer, signature: string): Stripe.Event {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!
  return stripe.webhooks.constructEvent(payload, signature, webhookSecret)
}

export async function processWebhookRequest(
  payload: string | Buffer,
  signature: string
): Promise<{ received: boolean }> {
  let event: Stripe.Event

  try {
    event = constructStripeEvent(payload, signature)
  } catch (err) {
    console.error('Webhook signature verification failed:', err)
    throw new Error('Invalid webhook signature')
  }

  await handleStripeWebhook(event)
  return { received: true }
}