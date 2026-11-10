import { prisma } from '@ai-workforce/db'
import { ApprovalLevel } from '@prisma/client'
import { getToolRiskProfile } from './risk'

export interface PermissionCheckResult {
  action: string
  level: ApprovalLevel
  /** False when no AgentPermission row exists and the default applied. */
  explicit: boolean
  allowed: boolean
  needsApproval: boolean
}

/**
 * Default level for a tool with no explicit AgentPermission row (CLAUDE.md design
 * decision #4: unknown actions must never silently auto-execute):
 * - read-only tools (risk class "read") run automatically: looking something up has no
 *   side effect, and asking a human before every CRM search makes an agent unusable;
 * - everything else, including unregistered tools, requires customer approval.
 * An explicit row always wins, so a read can still be set to PROHIBITED or approval.
 */
export function defaultPermissionLevel(action: string): ApprovalLevel {
  return getToolRiskProfile(action).risk === 'read' ? ApprovalLevel.AUTOMATIC : ApprovalLevel.CUSTOMER_APPROVAL
}

export async function checkPermission(agentId: string, action: string): Promise<PermissionCheckResult> {
  const permission = await prisma.agentPermission.findFirst({ where: { agentId, action } })
  const level = permission?.level ?? defaultPermissionLevel(action)

  return {
    action,
    level,
    explicit: Boolean(permission),
    allowed: level === ApprovalLevel.AUTOMATIC || level === ApprovalLevel.NOTIFY,
    needsApproval: level === ApprovalLevel.CUSTOMER_APPROVAL || level === ApprovalLevel.OPERATOR_APPROVAL,
  }
}
