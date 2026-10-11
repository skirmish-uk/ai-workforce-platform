import { prisma } from '@ai-workforce/db'
import { ApprovalLevel } from '@prisma/client'

export interface PermissionCheckResult {
  action: string
  level: ApprovalLevel
  allowed: boolean
  needsApproval: boolean
}

/**
 * Actions with no explicit AgentPermission row default to requiring customer
 * approval, per CLAUDE.md design decision #4: permissions are checked before
 * every tool call, and unknown actions must never silently auto-execute.
 */
const DEFAULT_LEVEL: ApprovalLevel = ApprovalLevel.CUSTOMER_APPROVAL

export async function checkPermission(agentId: string, action: string): Promise<PermissionCheckResult> {
  const permission = await prisma.agentPermission.findFirst({ where: { agentId, action } })
  const level = permission?.level ?? DEFAULT_LEVEL

  return {
    action,
    level,
    allowed: level === ApprovalLevel.AUTOMATIC || level === ApprovalLevel.NOTIFY,
    needsApproval: level === ApprovalLevel.CUSTOMER_APPROVAL || level === ApprovalLevel.OPERATOR_APPROVAL,
  }
}
