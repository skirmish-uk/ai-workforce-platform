import { prisma } from '@ai-workforce/db'
import { z } from 'zod'
import Stripe from 'stripe'
import { Plan, getPlanById } from './plans'
import { PlanTier, SubscriptionStatus, BillingInterval } from '@prisma/client'

export { SubscriptionStatus, BillingInterval }

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
})

export interface Subscription {
  id: string
  tenantId: string
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  stripePriceId: string | null
  plan: string
  planTier: PlanTier
  status: SubscriptionStatus
  interval: BillingInterval
  currentPeriodStart: Date
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
  canceledAt?: Date | null
  trialStart?: Date | null
  trialEnd?: Date | null
  metadata: unknown
  createdAt: Date
  updatedAt: Date
}

export const createSubscriptionSchema = z.object({
  tenantId: z.string().cuid(),
  planId: z.string(),
  interval: z.enum(['monthly', 'yearly']),
  paymentMethodId: z.string().optional(),
  trialDays: z.number().int().positive().optional(),
})

export async function createSubscription(input: z.infer<typeof createSubscriptionSchema>): Promise<Subscription> {
  const plan = await getPlanById(input.planId)
  if (!plan) throw new Error('Plan not found')

  const stripePriceId = input.interval === 'monthly'
    ? plan.stripePriceIdMonthly
    : plan.stripePriceIdYearly

  if (!stripePriceId) throw new Error('Stripe price ID not configured for plan')

  // Get or create Stripe customer
  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId } })
  if (!tenant) throw new Error('Tenant not found')

  let stripeCustomerId = tenant.stripeCustomerId
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email: `tenant-${input.tenantId}@aiworkforce.local`,
      metadata: { tenantId: input.tenantId },
    })
    stripeCustomerId = customer.id
    await prisma.tenant.update({
      where: { id: input.tenantId },
      data: { stripeCustomerId },
    })
  }

  // Attach payment method if provided
  if (input.paymentMethodId) {
    await stripe.paymentMethods.attach(input.paymentMethodId, {
      customer: stripeCustomerId,
    })
    await stripe.customers.update(stripeCustomerId, {
      invoice_settings: { default_payment_method: input.paymentMethodId },
    })
  }

  // Create subscription
  const subscriptionParams: Stripe.SubscriptionCreateParams = {
    customer: stripeCustomerId,
    items: [{ price: stripePriceId }],
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.payment_intent'],
    metadata: {
      tenantId: input.tenantId,
      planId: input.planId,
    },
  }

  if (input.trialDays) {
    subscriptionParams.trial_period_days = input.trialDays
  }

  const stripeSubscription = await stripe.subscriptions.create(subscriptionParams)

  const subscription = await prisma.subscription.create({
    data: {
      tenantId: input.tenantId,
      stripeCustomerId,
      stripeSubscriptionId: stripeSubscription.id,
      stripePriceId,
      plan: input.planId,
      planTier: plan.tier as any,
      status: mapStripeStatus(stripeSubscription.status ?? 'incomplete') as any,
      interval: input.interval === 'monthly' ? 'MONTHLY' : 'YEARLY',
      currentPeriodStart: new Date(stripeSubscription.current_period_start * 1000),
      currentPeriodEnd: new Date(stripeSubscription.current_period_end * 1000),
      cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
      trialStart: stripeSubscription.trial_start ? new Date(stripeSubscription.trial_start * 1000) : undefined,
      trialEnd: stripeSubscription.trial_end ? new Date(stripeSubscription.trial_end * 1000) : undefined,
    },
  })

  return subscription
}

export async function cancelSubscription(subscriptionId: string, immediately = false): Promise<Subscription> {
  const subscription = await prisma.subscription.findUnique({ where: { id: subscriptionId } })
  if (!subscription) throw new Error('Subscription not found')
  if (!subscription.stripeSubscriptionId) throw new Error('No Stripe subscription ID found')

  if (immediately) {
    await stripe.subscriptions.cancel(subscription.stripeSubscriptionId)
  } else {
    await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
      cancel_at_period_end: true,
    })
  }

  const updated = await prisma.subscription.update({
    where: { id: subscriptionId },
    data: {
      cancelAtPeriodEnd: !immediately,
      canceledAt: immediately ? new Date() : undefined,
      status: immediately ? SubscriptionStatus.CANCELLED : subscription.status,
    },
  })

  return updated
}

export async function resumeSubscription(subscriptionId: string): Promise<Subscription> {
  const subscription = await prisma.subscription.findUnique({ where: { id: subscriptionId } })
  if (!subscription) throw new Error('Subscription not found')
  if (!subscription.stripeSubscriptionId) throw new Error('No Stripe subscription ID found')

  await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
    cancel_at_period_end: false,
  })

  const updated = await prisma.subscription.update({
    where: { id: subscriptionId },
    data: {
      cancelAtPeriodEnd: false,
      canceledAt: null,
    },
  })

  return updated
}

export async function changePlan(subscriptionId: string, newPlanId: string, interval: 'monthly' | 'yearly'): Promise<Subscription> {
  const subscription = await prisma.subscription.findUnique({ where: { id: subscriptionId } })
  if (!subscription) throw new Error('Subscription not found')
  if (!subscription.stripeSubscriptionId) throw new Error('No Stripe subscription ID found')

  const newPlan = await getPlanById(newPlanId)
  if (!newPlan) throw new Error('Plan not found')

  const newPriceId = interval === 'monthly'
    ? newPlan.stripePriceIdMonthly
    : newPlan.stripePriceIdYearly

  if (!newPriceId) throw new Error('Stripe price ID not configured for plan')

  // Update Stripe subscription
  const stripeSubscription = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId)
  await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
    items: [{
      id: stripeSubscription.items.data[0].id,
      price: newPriceId,
    }],
    proration_behavior: 'create_prorations',
  })

  // Update local subscription
  const updated = await prisma.subscription.update({
    where: { id: subscriptionId },
    data: {
      plan: newPlanId,
      planTier: newPlan.tier as any,
      stripePriceId: newPriceId,
      interval: interval === 'monthly' ? 'MONTHLY' : 'YEARLY',
    },
  })

  return updated
}

export async function getSubscriptionByTenant(tenantId: string): Promise<Subscription | null> {
  return prisma.subscription.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<Subscription | null> {
  return prisma.subscription.findUnique({ where: { stripeSubscriptionId } })
}

export function mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case 'active':
      return SubscriptionStatus.ACTIVE
    case 'past_due':
      return SubscriptionStatus.PAST_DUE
    case 'canceled':
      return SubscriptionStatus.CANCELLED
    case 'incomplete':
    case 'incomplete_expired':
    case 'unpaid':
      return SubscriptionStatus.PAST_DUE
    case 'trialing':
      return SubscriptionStatus.TRIAL
    default:
      return SubscriptionStatus.PAST_DUE
  }
}