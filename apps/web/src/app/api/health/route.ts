import { NextResponse } from 'next/server'
import { runHealthChecks } from '@ai-workforce/monitoring'

/**
 * Unauthenticated liveness/readiness probe, per CLAUDE.md Phase 7. Intended
 * for infra (load balancers, uptime checks), not the tenant dashboard —
 * see /api/monitoring?type=health for the session-scoped equivalent.
 */
export async function GET() {
  const result = await runHealthChecks()
  return NextResponse.json(result, { status: result.status === 'unhealthy' ? 503 : 200 })
}
