import { ApprovalLevel } from '@prisma/client'

export interface WorkflowStepBase {
  id: string
  name?: string
}

export interface AgentTaskStep extends WorkflowStepBase {
  type: 'agent_task'
  agentId: string
  /** May reference prior step output via {{steps.stepId.output}} or {{input}}. */
  input: string
  outputKey?: string
}

/** No eval/new Function: conditions are a fixed structured shape, evaluated safely. */
export interface StepCondition {
  path: string
  operator: 'eq' | 'ne' | 'contains' | 'exists' | 'not_exists' | 'gt' | 'lt'
  value?: unknown
}

export interface ConditionStep extends WorkflowStepBase {
  type: 'condition'
  condition: StepCondition
  onTrue?: WorkflowStep[]
  onFalse?: WorkflowStep[]
}

export interface ApprovalStep extends WorkflowStepBase {
  type: 'approval'
  action: string
  level?: ApprovalLevel
}

export interface DelayStep extends WorkflowStepBase {
  type: 'delay'
  durationMs: number
}

export interface TransformStep extends WorkflowStepBase {
  type: 'transform'
  outputKey: string
  template: string
}

export interface ParallelStep extends WorkflowStepBase {
  type: 'parallel'
  steps: WorkflowStep[]
}

export type WorkflowStep = AgentTaskStep | ConditionStep | ApprovalStep | DelayStep | TransformStep | ParallelStep

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key]
    return undefined
  }, obj)
}

/** Replaces {{a.b.c}} placeholders with a dot-path lookup into the run context. */
export function interpolate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const value = getPath(context, path)
    if (value === undefined || value === null) return ''
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
}

export function evaluateCondition(condition: StepCondition, context: Record<string, unknown>): boolean {
  const actual = getPath(context, condition.path)
  switch (condition.operator) {
    case 'exists':
      return actual !== undefined && actual !== null
    case 'not_exists':
      return actual === undefined || actual === null
    case 'eq':
      return actual === condition.value
    case 'ne':
      return actual !== condition.value
    case 'contains':
      if (typeof actual === 'string') return actual.includes(String(condition.value))
      if (Array.isArray(actual)) return actual.includes(condition.value)
      return false
    case 'gt':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual > condition.value
    case 'lt':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual < condition.value
    default:
      return false
  }
}

export function parseSteps(raw: unknown): WorkflowStep[] {
  if (!Array.isArray(raw)) return []
  return raw as WorkflowStep[]
}
