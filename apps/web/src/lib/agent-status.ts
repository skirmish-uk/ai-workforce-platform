/** How an agent's lifecycle status reads in the dashboard: PRODUCTION shows as "live". */
export const AGENT_STATUS: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' }> = {
  DRAFT: { label: 'draft', variant: 'default' },
  EVALUATING: { label: 'deploying', variant: 'warning' },
  PRODUCTION: { label: 'live', variant: 'success' },
  PAUSED: { label: 'paused', variant: 'warning' },
  ARCHIVED: { label: 'archived', variant: 'danger' },
}

export function agentStatus(status: string): { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' } {
  return AGENT_STATUS[status] ?? { label: status.toLowerCase(), variant: 'default' }
}
