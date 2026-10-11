import { ApprovalLevel } from '@prisma/client'
import { isHighRisk, type ToolRiskClass } from './risk'

/**
 * Progressive-trust stages, configured per agent (Agent.config.contract.autonomyStage).
 * A stage is a ceiling: it can only make a tool call *more* restricted than its
 * AgentPermission row, never less.
 */
export const AUTONOMY_STAGES = ['observe', 'recommend', 'draft', 'approval_gated', 'limited', 'expanded'] as const
export type AutonomyStage = (typeof AUTONOMY_STAGES)[number]

export function stageRank(stage: AutonomyStage): number {
  return AUTONOMY_STAGES.indexOf(stage)
}

export type ToolDecision =
  | { kind: 'execute'; level: ApprovalLevel; reason: string }
  | { kind: 'approval'; level: ApprovalLevel; reason: string }
  | { kind: 'deny'; level: ApprovalLevel; reason: string }
  /** Recorded as a proposed action for a human; not executed. */
  | { kind: 'propose'; level: ApprovalLevel; reason: string }

export interface ToolDecisionInput {
  toolName: string
  stage: AutonomyStage
  risk: ToolRiskClass
  /** The agent's AgentPermission level for this tool (defaultPermissionLevel() when no row exists). */
  permissionLevel: ApprovalLevel
  /** Whether the tool is inside the agent contract's allowlist (true when the contract has no allowlist). */
  allowlisted: boolean
  /** Tool access revoked by a tenant/global kill switch. */
  disabled?: boolean
  /** The exact call was already approved by an authorised human (Approval row). */
  preApproved?: boolean
}

function atLeast(level: ApprovalLevel, floor: ApprovalLevel): ApprovalLevel {
  const order: ApprovalLevel[] = ['AUTOMATIC', 'NOTIFY', 'CUSTOMER_APPROVAL', 'OPERATOR_APPROVAL', 'PROHIBITED']
  return order.indexOf(level) >= order.indexOf(floor) ? level : floor
}

function fromLevel(level: ApprovalLevel, reason: string, preApproved: boolean): ToolDecision {
  switch (level) {
    case 'AUTOMATIC':
    case 'NOTIFY':
      return { kind: 'execute', level, reason }
    case 'CUSTOMER_APPROVAL':
    case 'OPERATOR_APPROVAL':
      return preApproved
        ? { kind: 'execute', level, reason: `${reason}; executing the exact call a human approved` }
        : { kind: 'approval', level, reason }
    case 'PROHIBITED':
    default:
      return { kind: 'deny', level: 'PROHIBITED', reason: 'Action is prohibited for this agent' }
  }
}

/**
 * Pure decision function: combines the per-tool AgentPermission level, the
 * tool's risk class, and the agent's autonomy stage into one decision. Kept
 * free of I/O so every branch is unit-tested (policy.test.ts).
 */
export function decideToolAction(input: ToolDecisionInput): ToolDecision {
  const preApproved = input.preApproved === true

  if (input.disabled) {
    return { kind: 'deny', level: 'PROHIBITED', reason: 'Tool access has been revoked (kill switch)' }
  }
  if (!input.allowlisted) {
    return { kind: 'deny', level: 'PROHIBITED', reason: "Tool is outside this agent's allowed tool list" }
  }
  if (input.permissionLevel === 'PROHIBITED') {
    return { kind: 'deny', level: 'PROHIBITED', reason: 'Action is prohibited for this agent' }
  }

  if (input.risk === 'read') {
    return fromLevel(input.permissionLevel, 'Read-only tool', preApproved)
  }

  switch (input.stage) {
    case 'observe':
      return { kind: 'deny', level: input.permissionLevel, reason: 'Agent is in the observe stage: no external writes' }
    case 'recommend':
      return { kind: 'propose', level: input.permissionLevel, reason: 'Agent is in the recommend stage: action recorded as a proposal' }
    case 'draft':
      if (input.risk === 'draft') return fromLevel(input.permissionLevel, 'Draft-only action in draft stage', preApproved)
      return { kind: 'propose', level: input.permissionLevel, reason: 'Agent is in the draft stage: only drafts/previews may be created' }
    case 'approval_gated':
      return fromLevel(atLeast(input.permissionLevel, 'CUSTOMER_APPROVAL'), 'Approval-gated stage', preApproved)
    case 'limited':
      if (isHighRisk(input.risk)) {
        return fromLevel(
          atLeast(input.permissionLevel, 'CUSTOMER_APPROVAL'),
          `High-risk action (${input.risk}) requires approval in the limited stage`,
          preApproved
        )
      }
      return fromLevel(input.permissionLevel, 'Low-risk reversible action within limited autonomy', preApproved)
    case 'expanded':
      return fromLevel(input.permissionLevel, 'Expanded autonomy: per-tool permission applies', preApproved)
    default:
      return { kind: 'deny', level: 'PROHIBITED', reason: `Unknown autonomy stage "${String(input.stage)}"` }
  }
}
