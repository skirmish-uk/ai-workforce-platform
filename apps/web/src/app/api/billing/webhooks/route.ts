import { NextRequest, NextResponse } from 'next/server'
import { handleStripeWebhook, constructStripeEvent, processWebhookRequest } from '@ai-workforce/billing'

export async function POST(request: NextRequest) {
  try {
    const payload = await request.text()
    const signature = request.headers.get('stripe-signature')

    if (!signature) {
      return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 })
    }

    const result = await processWebhookRequest(payload, signature)
    return NextResponse.json(result)
  } catch (error) {
    console.error('Webhook error:', error)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}