import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant, UserRole } from '@ai-workforce/billing'
import { createSubscription, getSubscriptionByTenant, cancelSubscription, resumeSubscription, changePlan, SubscriptionStatus, BillingInterval, createSubscriptionSchema } from '@ai-workforce/billing'

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const tenantId = session.user.tenantId
    const userRole = session.user.role as UserRole

    if (!canAccessTenant(userRole, session.user.tenantId, tenantId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const subscription = await getSubscriptionByTenant(tenantId)
    if (!subscription) {
      return NextResponse.json({ subscription: null })
    }

    return NextResponse.json(subscription)
  } catch (error) {
    console.error('Error fetching subscription:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userRole = session.user.role as UserRole
    const tenantId = session.user.tenantId

    if (!canAccessTenant(userRole, session.user.tenantId, tenantId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const validated = {
      tenantId,
      planId: body.planId,
      interval: body.interval,
      paymentMethodId: body.paymentMethodId,
      trialDays: body.trialDays,
    }

    const subscription = await createSubscription(validated)
    return NextResponse.json(subscription, { status: 201 })
  } catch (error) {
    console.error('Error creating subscription:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}