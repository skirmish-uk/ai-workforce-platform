import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant, UserRole } from '@ai-workforce/billing'
import { cancelSubscription, resumeSubscription, changePlan, SubscriptionStatus, BillingInterval } from '@ai-workforce/billing'

async function checkSubscriptionAccess(session: { user: { id: string; role: string; tenantId: string } }, subscriptionId: string) {
  const subscription = await prisma.subscription.findUnique({ where: { id: subscriptionId } })
  if (!subscription) throw new Error('NOT_FOUND')

  if (!canAccessTenant(session.user.role as UserRole, session.user.tenantId, subscription.tenantId)) {
    throw new Error('FORBIDDEN')
  }
  return subscription
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    await checkSubscriptionAccess(session, id)

    const subscription = await prisma.subscription.findUnique({
      where: { id },
    })

    if (!subscription) {
      return NextResponse.json({ error: 'Subscription not found' }, { status: 404 })
    }

    return NextResponse.json(subscription)
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Subscription not found' }, { status: 404 })
    }
    console.error('Error fetching subscription:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const subscription = await checkSubscriptionAccess(session, id)

    const userRole = session.user.role as UserRole
    // Check if user has permission to modify subscription
    // Only PLATFORM_ADMIN and CUSTOMER_ADMIN can modify subscriptions

    const body = await request.json()
    const { action, ...data } = body

    switch (action) {
      case 'cancel': {
        const immediately = data.immediately === true
        const cancelled = await cancelSubscription(id, immediately)
        return NextResponse.json(cancelled)
      }

      case 'resume': {
        const resumed = await resumeSubscription(id)
        return NextResponse.json(resumed)
      }

      case 'change_plan': {
        const { planId, interval } = data
        const changed = await changePlan(id, data.planId, data.interval)
        return NextResponse.json(changed)
      }

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Subscription not found' }, { status: 404 })
    }
    console.error('Error updating subscription:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}