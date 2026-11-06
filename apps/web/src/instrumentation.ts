/**
 * Next.js instrumentation: uncaught errors while handling a request become Incidents in the
 * operator console (packages/monitoring/src/errors.ts). Node runtime only: the recorder uses the
 * database and Redis, so its import sits inside the NEXT_RUNTIME check, which the edge build drops.
 */
export async function register() {}

export async function onRequestError(error: unknown, request: { path: string; method: string }, context: { routePath?: string }) {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { recordError } = await import('@ai-workforce/monitoring')
    await recordError({ source: 'web', where: `${request.method} ${context.routePath ?? request.path.split('?')[0]}`, error })
  }
}
