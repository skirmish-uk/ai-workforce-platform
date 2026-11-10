import type { NextRequest } from 'next/server'

/** The tenant a request is about: the caller's own, or (platform staff) ?tenantId=. */
export function tenantFor(session: { user: { role: string; tenantId: string } }, request: NextRequest): string {
  const isPlatform = session.user.role === 'PLATFORM_ADMIN' || session.user.role === 'PLATFORM_OPERATOR'
  const asked = request.nextUrl.searchParams.get('tenantId')
  return isPlatform && asked ? asked : session.user.tenantId
}
