import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant, UserRole } from '@ai-workforce/billing'
import { getInvoiceById } from '@ai-workforce/billing'

async function checkInvoiceAccess(session: { user: { id: string; role: string; tenantId: string } }, invoiceId: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
  if (!invoice) throw new Error('NOT_FOUND')

  if (!canAccessTenant(session.user.role as UserRole, session.user.tenantId, invoice.tenantId)) {
    throw new Error('FORBIDDEN')
  }
  return invoice
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
    await checkInvoiceAccess(session, id)

    const invoice = await getInvoiceById(id)
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    return NextResponse.json(invoice)
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
    console.error('Error fetching invoice:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}