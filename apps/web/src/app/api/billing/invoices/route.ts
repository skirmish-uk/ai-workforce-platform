import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { hasPermission, canAccessTenant, UserRole } from '@ai-workforce/billing'
import { listInvoices, getInvoiceById, syncInvoicesForTenant } from '@ai-workforce/billing'

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const page = parseInt(searchParams.get('page') || '1')
    const pageSize = parseInt(searchParams.get('pageSize') || '20')
    const status = searchParams.get('status')
    const tenantId = session.user.tenantId
    const userRole = session.user.role as UserRole

    if (!canAccessTenant(userRole, session.user.tenantId, tenantId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const result = await listInvoices({
      tenantId,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      status: status || undefined,
    })

    return NextResponse.json({
      data: result.invoices,
      pagination: {
        page,
        pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / pageSize),
      },
    })
  } catch (error) {
    console.error('Error listing invoices:', error)
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
    const { action } = body

    if (action === 'sync') {
      const invoices = await syncInvoicesForTenant(tenantId)
      return NextResponse.json({ synced: invoices.length, invoices })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Error syncing invoices:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}