import { randomUUID } from 'node:crypto'
import { prisma } from '@ai-workforce/db'
import type { Agent } from '@prisma/client'
import { AgentExecutionError, redact, redactString, safeErrorMessage } from '@ai-workforce/domain'
import { LLM_EFFORTS, estimateCostUsd, totalInputTokens, type LLMEffort, type LLMClient, type LLMClientConfig, type LLMMessage, type LLMSystemBlock, type LLMTool } from '@ai-workforce/llm'
import { agentFailure, agentHeartbeat } from '@ai-workforce/monitoring'
import {
  authorizeToolCall,
  checkPermission,
  decideToolAction,
  getToolRiskProfile,
  toolRegistry,
  ToolInputValidationError,
  type AutonomyStage,
  type RegisteredTool,
} from '@ai-workforce/tools'
import { buildAgentContext } from './context'
import { resolveAgentContract, type AgentContract, type ModelTier } from './contract'
import { assessDefinitionOfDone, type DodAssessment } from './dod'
import { createToolApproval } from './approvals'
import { completeWithFallback, selectModelCandidates, ModelUnavailableError, type ModelAttempt } from './routing'
import { canonicalJson, readKillSwitch, resolveEffectiveStage } from './safety'
import { checkSpendCap } from './spend-cap'
import { runAuthorizedTool, type ToolExecutorFn } from './tool-runner'
import { wrapUntrusted } from './untrusted'
import { detectQualitySignals, type QualitySignal } from './quality'
import { readVoiceConfig } from './voice'
import { CONVERSATION_MESSAGE_MAX_CHARS, isConversationId } from './conversations'
import { readSelfManagementPolicy } from './workforce/policy'
import { executeWorkforceTool, workforceToolsFor, WORKFORCE_READ_TOOLS } from './workforce/tools'

/** Hard ceiling on delegation depth regardless of any contract. */
export const MAX_DELEGATION_DEPTH = 3

export type RunAgentStatus =
  | 'completed'
  | 'partial'
  | 'needs_clarification'
  | 'escalated'
  | 'approval_required'
  | 'blocked'
  | 'cancelled'
  | 'failed'

export type RunPhase = 'diagnose' | 'assemble' | 'act' | 'assess'

/** 'replay': the revision pipeline re-running a recent real input against a candidate (always dry-run). */
export type RunTrigger = 'manual' | 'api' | 'schedule' | 'workflow' | 'delegation' | 'evaluation' | 'replay' | 'voice' | 'event'

export interface RunAgentDeps {
  createClient?: (provider: string, model: string, config: LLMClientConfig) => LLMClient
  executeTool?: ToolExecutorFn
  sleep?: (ms: number) => Promise<void>
}

export interface ParentRunInfo {
  runId: string
  rootRunId: string
  /** Agent IDs from the root manager down to the delegating agent. */
  chain: string[]
  depth: number
}

export interface RunAgentOptions {
  /** Defaults to a random UUID. The queue worker passes the BullMQ job id so run id == job id. */
  runId?: string
  /** Legacy override; can only lower the contract's limit. */
  maxIterations?: number
  /** When set, a tool call requiring approval also pauses this WorkflowRun. */
  workflowRunId?: string
  workflowStepId?: string
  userId?: string
  trigger?: RunTrigger
  /** Ask for the contract's model tier (simple/standard/complex) instead of the primary model. */
  tier?: ModelTier
  /** Remaining USD budget handed down by a parent run (delegation). */
  budgetUsd?: number
  signal?: AbortSignal
  isCancelled?: () => boolean | Promise<boolean>
  /** Evaluation/sandbox mode: tools are never executed against real systems and approvals are not persisted. */
  dryRun?: boolean
  /** With dryRun: read-only tools run for real (no side effects) so a replay sees real data. */
  liveReads?: boolean
  toolFixtures?: Record<string, unknown>
  parent?: ParentRunInfo
  /**
   * Streams the model's visible text as it is written (voice turns speak it sentence by
   * sentence). `step` is the model call within the run, starting at 0. Text can precede a tool
   * call, and is streamed before the run's result checks have run.
   */
  onTextDelta?: (delta: string, step: number) => void
  /** The dashboard conversation this run belongs to; its id and the person's own words go on the audit row. */
  conversation?: { id: string; message: string }
  deps?: RunAgentDeps
}

export type RunAgentToolCallStatus =
  | 'completed'
  | 'simulated'
  | 'denied'
  | 'error'
  | 'approval_required'
  | 'proposed'
  | 'duplicate_suppressed'
  | 'unknown_outcome'

export interface RunAgentToolCallRecord {
  toolName: string
  /** Redacted. */
  input: unknown
  /** Redacted. */
  output?: unknown
  error?: string
  status: RunAgentToolCallStatus
  reason?: string
}

export interface PhaseRecord {
  phase: RunPhase
  at: string
  notes: string[]
}

export interface ChildRunRecord {
  agentId: string
  runId: string
  status: RunAgentStatus
  costUsd: number | null
  dodPassed?: boolean
}

/**
 * One step of how a run reached its result, for the run's trace in the dashboard: what the
 * model wrote (and any thinking the provider returned in readable form) and which tools it
 * asked for, then a short summary of each tool's result. Redacted and truncated; tool results
 * are data from outside systems and are shown as text, never acted on.
 */
export interface ReasoningStep {
  kind: 'model' | 'tool'
  text?: string
  thinking?: string
  calls?: Array<{ tool: string; input: unknown }>
  tool?: string
  ok?: boolean
  result?: string
}

const MAX_REASONING_STEPS = 40

function summarizeToolOutput(output: unknown): string {
  const text = typeof output === 'string' ? output : JSON.stringify(redact(output, { maxStringLength: 300 }))
  return redactString(text ?? '', 600)
}

/** Readable thinking from the provider's raw content blocks (often empty: some models only return a signature). */
function readableThinking(providerContent: unknown): string | undefined {
  const blocks = (providerContent as { content?: Array<{ type?: string; thinking?: unknown }> } | undefined)?.content
  if (!Array.isArray(blocks)) return undefined
  const text = blocks.filter((b) => b?.type === 'thinking' && typeof b.thinking === 'string').map((b) => b.thinking as string).join('\n').trim()
  return text ? redactString(text, 1500) : undefined
}

export interface RunAgentResult {
  reasoning?: ReasoningStep[]
  runId: string
  status: RunAgentStatus
  output: string | null
  toolCalls: RunAgentToolCallRecord[]
  tokensUsed: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  /** This run's own LLM cost. null when every model used is missing from the pricing table. */
  costUsd: number | null
  /** Cost of delegated child runs (recorded on their own audit rows). */
  childCostUsd: number
  durationMs: number
  agentVersion?: number
  stage?: AutonomyStage
  model?: { provider: string; model: string }
  modelAttempts: ModelAttempt[]
  iterations: number
  phases: PhaseRecord[]
  dod?: DodAssessment
  proposedActions: Array<{ toolName: string; input: unknown; reason: string }>
  clarificationQuestions?: string[]
  escalation?: { reason: string; severity: string; destination: string }
  childRuns: ChildRunRecord[]
  contextWarnings: string[]
  injectionSignals: Array<{ source: string; signals: string[] }>
  /** Problems a finished run can have despite its status (see ./quality.ts). */
  qualitySignals: QualitySignal[]
  approvalId?: string
  pendingTool?: { toolName: string; input: unknown }
  /** Voice: the agent ended the call (platform__end_call) after saying goodbye. */
  endCall?: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// Platform (built-in) tools — always answered by the executor, never by an adapter
// ---------------------------------------------------------------------------

const CLARIFY_TOOL: LLMTool = {
  name: 'platform__request_clarification',
  description: 'Stop and ask the requester for missing, ambiguous or conflicting information instead of guessing. Ends the run.',
  inputSchema: {
    type: 'object',
    properties: { questions: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 } },
    required: ['questions'],
  },
}

/** Upper bound on a hand-off reason (secrets are still redacted); 1,000 cut real findings in half. */
const ESCALATION_REASON_MAX_CHARS = 6000

const ESCALATE_TOOL: LLMTool = {
  name: 'platform__escalate',
  description: 'Hand the task to a human: out of scope, high risk, policy unclear, or persistent failures. Ends the run.',
  inputSchema: {
    type: 'object',
    properties: { reason: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high'] } },
    required: ['reason'],
  },
}

/**
 * Voice calls only: ends the call once the caller is done. The goodbye is the text written with
 * the call, spoken before the page hangs up (about a second after it finishes).
 */
const END_CALL_TOOL: LLMTool = {
  name: 'platform__end_call',
  description:
    'End the phone call. Only once the caller has said they have everything they need, or said goodbye, and nothing they asked is still open. Write a short, warm goodbye in the same reply; the call ends after it is spoken. Ends the run.',
  inputSchema: { type: 'object', properties: {}, required: [] },
}

/**
 * How to talk on a call (every voice turn, after the agent's own instructions). Written after
 * listening to Ava's first calls on 21 Oct: every answer ended with "Would you like more detail
 * on…?", repeated "in Australian dollars, excluding GST" each time, and a plain "No." got a
 * three-sentence recap. Stable text, so it is cached with the rest of the prompt.
 */
export const VOICE_STYLE = `## On a live call
You're talking with someone on the phone, not writing to them. Sound like a friendly, switched-on member of staff who knows the business well.
- Answer what they asked straight away, in plain spoken English with contractions. Usually one to three short sentences; say more only when they ask for detail, and then give the detail rather than a summary.
- Don't end every reply with a question or an offer. Most of the time just answer and stop; they'll ask if they want more. When a follow-up question genuinely helps, keep it short and vary how you put it.
- Don't repeat what you've already said on this call (prices, "excluding GST", who you work with) unless they ask again.
- React to what they say when it's natural ("Oh, a startup, nice.", "Got it.", "Sure."), and don't start replies the same way each time. Don't greet them again.
- If they ask you to repeat something, say it again more simply, not word for word. If they ask for more detail than you have, say so plainly and offer to pass it to the team.
- Short replies like "no", "okay" or "that's fine" just need a short reply. Don't recap.
- Say numbers, prices and times the way people say them aloud. No lists, headings, symbols or links.
- Wrapping up: when their questions seem dealt with (they say thanks, "that's great", "that's all"), you can check once, lightly, whether there's anything else. Once they say they're done or say goodbye, say a short, warm goodbye in one sentence and call ${END_CALL_TOOL.name}. Don't ask "anything else?" again after they've said no.`

interface Specialist {
  id: string
  name: string
  role: string
  mission?: string
  /** The specialist's contract scope (front desk only), so routing goes by what each agent handles. */
  handles?: string[]
}

function delegateTool(specialists: Specialist[]): LLMTool {
  return {
    name: 'platform__delegate',
    description:
      'Delegate one bounded subtask to a specialist agent and receive its validated result. Give it only the information it needs. Available specialists: ' +
      specialists
        .map((s) => `${s.id} (${s.name} — ${s.role}${s.mission ? `: ${s.mission.slice(0, 160)}` : ''}${s.handles?.length ? `. Handles: ${s.handles.map((h) => h.slice(0, 120)).slice(0, 4).join('; ')}` : ''})`)
        .join('; '),
    inputSchema: {
      type: 'object',
      properties: {
        specialistAgentId: { type: 'string', enum: specialists.map((s) => s.id) },
        task: { type: 'string', description: 'The subtask, its expected output, and only the context needed.' },
      },
      required: ['specialistAgentId', 'task'],
    },
  }
}

function readModelConfig(config: unknown): { maxTokens?: number; temperature?: number; effort?: LLMEffort; thinking?: 'default' | 'off'; voiceThinking?: 'default' | 'off' } {
  if (!config || typeof config !== 'object') return {}
  const c = config as Record<string, unknown>
  const mode = (v: unknown) => (v === 'off' || v === 'default' ? v : undefined)
  return {
    maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : undefined,
    temperature: typeof c.temperature === 'number' ? c.temperature : undefined,
    effort: LLM_EFFORTS.includes(c.effort as LLMEffort) ? (c.effort as LLMEffort) : undefined,
    thinking: mode(c.thinking),
    voiceThinking: mode(c.voiceThinking),
  }
}

/**
 * Voice turns run at low effort (a caller is waiting for the first word): on 20 Oct, Ava's
 * suite passed 20/21 at low effort vs 7/7 x3 at the default medium, and the run was ~1 s faster.
 * Thinking stays on: turning it off (modelConfig.voiceThinking = "off") was faster but Ava
 * stopped using the calendar and cited "the FAQ" (5-6/7). With thinking off, models can also
 * write a tool call as text; VOICE_NOTE is the guard recommended for that case.
 */
const VOICE_NOTE = 'This turn is spoken on a live call. When you use a tool, you may say a brief sentence first. If no tool can express what the caller asked for, say so instead of guessing. Do not include internal or system XML tags in your response.'

function parseObjectInput(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, 5) : []
}

const AUDIT_ACTION: Record<RunAgentStatus, string> = {
  completed: 'AGENT_RUN_COMPLETED',
  failed: 'AGENT_RUN_FAILED',
  cancelled: 'AGENT_RUN_FAILED',
  partial: 'AGENT_RUN_FINISHED',
  needs_clarification: 'AGENT_RUN_FINISHED',
  escalated: 'AGENT_RUN_ESCALATED',
  approval_required: 'AGENT_RUN_FINISHED',
  blocked: 'AGENT_RUN_FINISHED',
}

/**
 * The closed-loop agent run (brief §7): Diagnose → Assemble → Act → Assess.
 *
 * Every run has a run ID, an explicit phase history and exactly one terminal
 * status. Loops are bounded by iterations, tool calls, wall-clock time and
 * cost. Every tool call goes through the application-side policy (contract
 * allowlist, autonomy stage, AgentPermission, kill switch) and approval gate;
 * the model's own claims are never taken as evidence that an action happened.
 */
export async function runAgent(agentId: string, input: string, options: RunAgentOptions = {}): Promise<RunAgentResult> {
  const startedAt = Date.now()
  const runId = options.runId ?? randomUUID()
  const trigger: RunTrigger = options.trigger ?? (options.parent ? 'delegation' : options.workflowRunId ? 'workflow' : 'api')

  const agent = await prisma.agent.findUnique({ where: { id: agentId }, include: { tenant: { select: { settings: true } } } })
  if (!agent) {
    throw new AgentExecutionError(`Agent ${agentId} not found`, { agentId })
  }

  const run = new AgentRun(agent, input, runId, trigger, startedAt, options)
  try {
    return await run.execute()
  } catch (error) {
    agentFailureSafe(agentId, error)
    return run.finish('failed', { error: safeErrorMessage(error, 'Agent execution failed') })
  }
}

class AgentRun {
  private readonly toolCalls: RunAgentToolCallRecord[] = []
  /** input = every input token (cached or not); cacheRead/cacheWrite = the cached share of it. */
  private readonly usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  private ownCost = 0
  private costKnown = false
  private childCost = 0
  private readonly phases: PhaseRecord[] = []
  private readonly modelAttempts: ModelAttempt[] = []
  private readonly proposedActions: RunAgentResult['proposedActions'] = []
  private readonly childRuns: ChildRunRecord[] = []
  private contextWarnings: string[] = []
  private injectionSignals: RunAgentResult['injectionSignals'] = []
  private qualitySignals: QualitySignal[] = []
  private reasoning: ReasoningStep[] = []

  /** The agent's model settings, with the voice-turn defaults (see VOICE_NOTE) applied. */
  private modelSettings(): ReturnType<typeof readModelConfig> {
    const cfg = readModelConfig(this.agent.modelConfig)
    if (this.trigger !== 'voice') return cfg
    return { ...cfg, effort: cfg.effort ?? 'low', thinking: cfg.voiceThinking ?? cfg.thinking }
  }

  private recordStep(step: ReasoningStep): void {
    if (this.reasoning.length < MAX_REASONING_STEPS) this.reasoning.push(step)
  }
  private iterations = 0
  private modelUsed?: { provider: string; model: string }
  private contract!: AgentContract
  private stage?: AutonomyStage
  private budgetUsd = Infinity
  private finished?: RunAgentResult
  private endCall = false

  constructor(
    private readonly agent: Agent & { tenant: { settings: unknown } },
    private readonly input: string,
    private readonly runId: string,
    private readonly trigger: RunTrigger,
    private readonly startedAt: number,
    private readonly options: RunAgentOptions
  ) {}

  private enter(phase: RunPhase, ...notes: string[]): void {
    this.phases.push({ phase, at: new Date().toISOString(), notes })
  }

  private note(text: string): void {
    this.phases[this.phases.length - 1]?.notes.push(text)
  }

  private get rootRunId(): string {
    return this.options.parent?.rootRunId ?? this.runId
  }

  private async cancelled(): Promise<boolean> {
    if (this.options.signal?.aborted) return true
    try {
      return (await this.options.isCancelled?.()) === true
    } catch {
      return false
    }
  }

  private spentUsd(): number {
    return this.ownCost + this.childCost
  }

  async execute(): Promise<RunAgentResult> {
    const diagnosis = await this.diagnose()
    if (diagnosis) return diagnosis

    const assembled = await this.assemble()
    if ('status' in assembled) return assembled

    return this.act(assembled)
  }

  // ------------------------------------------------------------------ DIAGNOSE
  private async diagnose(): Promise<RunAgentResult | null> {
    this.enter('diagnose', `trigger=${this.trigger}`)
    const resolved = resolveAgentContract(this.agent)
    this.contract = resolved.contract
    if (resolved.source === 'legacy_default') this.note('No agent contract: using conservative approval-gated defaults.')
    if (resolved.errors.length) {
      return this.finish('blocked', { error: `Invalid agent contract: ${resolved.errors.join('; ')}` })
    }

    const killSwitch = readKillSwitch(this.agent.tenant.settings)
    if (killSwitch.agentsDisabled) return this.finish('blocked', { error: killSwitch.reason })
    if (this.agent.status === 'PAUSED' || this.agent.status === 'ARCHIVED') {
      return this.finish('blocked', { error: `Agent is ${this.agent.status}` })
    }
    if (this.agent.isCandidate && !this.options.dryRun) {
      return this.finish('blocked', { error: 'Candidate agents (revision sandboxes) only run in dry-run evaluation and replay' })
    }

    if (this.options.parent) {
      const depth = this.options.parent.depth
      if (depth > MAX_DELEGATION_DEPTH) return this.finish('blocked', { error: `Delegation depth ${depth} exceeds platform limit ${MAX_DELEGATION_DEPTH}` })
      if (this.options.parent.chain.includes(this.agent.id)) return this.finish('blocked', { error: 'Delegation cycle detected' })
    }

    if (!this.input.trim()) {
      return this.finish('needs_clarification', { clarificationQuestions: ['The request was empty. What would you like me to do?'] })
    }
    if (this.input.length > this.contract.inputs.maxLength) {
      return this.finish('blocked', { error: `Input is ${this.input.length} characters; the contract allows ${this.contract.inputs.maxLength}.` })
    }
    const required = this.contract.inputs.requiredFields
    if (required.length) {
      const obj = parseObjectInput(this.input)
      const missing = obj ? required.filter((f) => obj[f] === undefined || obj[f] === null || obj[f] === '') : required
      if (missing.length) {
        return this.finish('needs_clarification', {
          clarificationQuestions: missing.map((f) => `Please provide "${f}"${obj ? '' : ' (send the request as a JSON object)'}.`),
        })
      }
    }

    const spend = await checkSpendCap(this.agent.tenantId)
    if (!spend.allowed) {
      await this.audit('AGENT_RUN_BLOCKED_SPEND_CAP', {
        reason: spend.reason,
        spentTodayUsd: spend.spentTodayUsd,
        spentThisMonthUsd: spend.spentThisMonthUsd,
      })
      return this.finish('blocked', { error: spend.reason, skipAudit: true })
    }
    const tenantRemaining = Math.min(
      spend.limits.dailyUsd !== undefined ? spend.limits.dailyUsd - spend.spentTodayUsd : Infinity,
      spend.limits.monthlyUsd !== undefined ? spend.limits.monthlyUsd - spend.spentThisMonthUsd : Infinity
    )
    this.budgetUsd = Math.min(tenantRemaining, this.contract.limits.maxRunCostUsd ?? Infinity, this.options.budgetUsd ?? Infinity)
    if (this.budgetUsd <= 0) return this.finish('blocked', { error: 'No cost budget remains for this run' })

    // An evaluation must exercise the stage being promoted to, or limited/expanded could never earn
    // evidence. That is safe only because dry runs never execute real tools or persist approvals.
    const evaluating = this.options.dryRun === true && (this.trigger === 'evaluation' || this.trigger === 'replay')
    const effective = evaluating
      ? { stage: this.contract.autonomyStage, capped: false, reason: undefined }
      : await resolveEffectiveStage(this.agent, this.contract)
    if (evaluating) this.note(`evaluating configured stage "${this.contract.autonomyStage}" in dry-run`)
    this.stage = effective.stage
    if (effective.capped && effective.reason) this.note(effective.reason)
    this.note(`stage=${this.stage}; budgetUsd=${Number.isFinite(this.budgetUsd) ? this.budgetUsd.toFixed(4) : 'unlimited'}`)

    if (await this.cancelled()) return this.finish('cancelled', { error: 'Run cancelled before start' })
    return null
  }

  // ------------------------------------------------------------------ ASSEMBLE
  private async assemble(): Promise<
    | RunAgentResult
    | { registered: Map<string, RegisteredTool>; llmTools: LLMTool[]; systemPrompt: string; systemBlocks: LLMSystemBlock[]; specialists: Map<string, Specialist>; workforce: Set<string> }
  > {
    this.enter('assemble')
    const killSwitch = readKillSwitch(this.agent.tenant.settings)

    // Skill tools ∩ contract allowlist, minus anything policy would always deny (least privilege:
    // a prohibited tool isn't even offered to the model).
    // Deterministic order (here and below): tools and prompt must be byte-identical between runs for prompt caching.
    const skillLinks = await prisma.agentSkill.findMany({ where: { agentId: this.agent.id, enabled: true }, include: { skill: true }, orderBy: [{ skill: { name: 'asc' } }, { skillId: 'asc' }] })
    const requested = toolRegistry.resolve(skillLinks.filter((l) => l.skill.isActive).flatMap((l) => l.skill.requiredTools))
    const registered = new Map<string, RegisteredTool>()
    const toolNotes: string[] = []
    for (const tool of requested) {
      const permission = await checkPermission(this.agent.id, tool.toolName)
      const profile = getToolRiskProfile(tool.toolName)
      const decision = decideToolAction({
        toolName: tool.toolName,
        stage: this.stage!,
        risk: profile.risk,
        permissionLevel: permission.level,
        allowlisted: !this.contract.allowedTools || this.contract.allowedTools.includes(tool.toolName),
        disabled: killSwitch.disabledTools.includes(tool.toolName),
      })
      if (decision.kind === 'deny') {
        this.note(`not offered: ${tool.toolName} (${decision.reason})`)
        continue
      }
      registered.set(tool.toolName, tool)
      const treatment =
        decision.kind === 'execute' ? 'runs automatically' : decision.kind === 'approval' ? 'requires human approval (the run pauses)' : 'recorded as a proposal only, not executed'
      toolNotes.push(`${tool.toolName} — ${treatment}`)
    }

    const specialists = new Map<string, Specialist>()
    if (this.contract.delegation.enabled) {
      // "*" = the whole team (front desk). Only a manager may use it; other managers are never delegates.
      const wholeTeam = this.contract.management.enabled && this.contract.delegation.allowedSpecialists.includes('*')
      const rows = await prisma.agent.findMany({
        where: {
          ...(wholeTeam ? {} : { id: { in: this.contract.delegation.allowedSpecialists } }),
          tenantId: this.agent.tenantId,
          isCandidate: false,
          status: { notIn: ['PAUSED', 'ARCHIVED'] },
        },
        select: { id: true, name: true, role: true, mission: true, config: true },
        orderBy: { id: 'asc' },
      })
      for (const row of rows) {
        if (row.id === this.agent.id) continue
        const specialistContract = wholeTeam ? resolveAgentContract(row).contract : null
        if (specialistContract?.management.enabled) continue
        specialists.set(row.id, {
          id: row.id,
          name: row.name,
          role: row.role,
          mission: wholeTeam ? row.mission : undefined,
          handles: specialistContract?.scope.inScope,
        })
      }
      const missing = this.contract.delegation.allowedSpecialists.filter((id) => id !== '*' && !specialists.has(id))
      if (missing.length) this.note(`specialists unavailable (missing, paused, self or other tenant): ${missing.join(', ')}`)
    }

    // Self-management tools (docs/WORKFORCE_MANAGER.md): only when the tenant has opted in.
    const { policy } = readSelfManagementPolicy(this.agent.tenant.settings)
    const workforceTools = workforceToolsFor({ policy, contract: this.contract, isCandidate: this.agent.isCandidate })

    const context = await buildAgentContext(this.agent.id, {
      // Voice turns skip the semantic search (an embedding round trip, ~0.3 s) and use the
      // agent's attached documents directly: a caller is waiting on every turn.
      query: this.trigger === 'voice' ? undefined : this.input,
      contract: this.contract,
      stage: this.stage,
      toolNotes: [
        ...toolNotes,
        ...(specialists.size ? ['platform__delegate — hand a bounded subtask to a specialist'] : []),
        ...workforceTools.map((t) => `${t.name} — platform self-management tool`),
        'platform__request_clarification — ask for missing information (ends the run)',
        'platform__escalate — hand off to a human (ends the run)',
        ...(this.trigger === 'voice' ? [`${END_CALL_TOOL.name} — end the phone call after saying goodbye (ends the run)`] : []),
      ],
    })
    this.contextWarnings = context.warnings
    this.injectionSignals = [...context.injectionSignals]
    if (context.knowledgeUsed.length) {
      this.note(`knowledge: ${context.knowledgeUsed.map((k) => `${k.documentId}${k.stale ? '(stale)' : ''}`).join(', ')}`)
    }

    const llmTools = [
      ...toolRegistry.toLLMTools(Array.from(registered.values())),
      CLARIFY_TOOL,
      ESCALATE_TOOL,
      ...(this.trigger === 'voice' ? [END_CALL_TOOL] : []),
      ...(specialists.size ? [delegateTool(Array.from(specialists.values()))] : []),
      ...workforceTools,
    ]

    const checks = this.contract.definitionOfDone.checks.map((c) => c.type).join(', ') || 'output_present'
    const limits = this.contract.limits
    this.note(
      `plan: tools=[${Array.from(registered.keys()).join(', ')}] dod=[${checks}] limits={iterations:${this.maxIterations()},toolCalls:${limits.maxToolCalls},wallClockMs:${limits.maxWallClockMs}}`
    )
    // Voice turns: how to talk on a call, cached just before the per-request block (time of day).
    const systemBlocks = this.trigger === 'voice'
      ? [...context.systemBlocks.slice(0, -1), { text: VOICE_STYLE, cache: true }, ...context.systemBlocks.slice(-1)]
      : context.systemBlocks
    const systemPrompt = this.trigger === 'voice' ? systemBlocks.map((b) => b.text).join('\n\n') : context.systemPrompt
    return { registered, llmTools, systemPrompt, systemBlocks, specialists, workforce: new Set(workforceTools.map((t) => t.name)) }
  }

  private maxIterations(): number {
    const fromContract = this.contract.limits.maxIterations
    return this.options.maxIterations ? Math.min(this.options.maxIterations, fromContract) : fromContract
  }

  // ------------------------------------------------------------------ ACT
  private async act(assembled: {
    registered: Map<string, RegisteredTool>
    llmTools: LLMTool[]
    systemPrompt: string
    systemBlocks: LLMSystemBlock[]
    specialists: Map<string, Specialist>
    workforce: Set<string>
  }): Promise<RunAgentResult> {
    this.enter('act')
    const limits = this.contract.limits
    const candidates = selectModelCandidates(this.agent, this.contract, this.options.tier)
    if (!candidates.length) return this.finish('blocked', { error: 'No model candidates satisfy the contract privacy policy' })

    const messages: LLMMessage[] = [{ role: 'user', content: this.input }]
    const failureCounts = new Map<string, number>()
    let toolCallCount = 0

    for (let iteration = 0; iteration < this.maxIterations(); iteration++) {
      this.iterations = iteration + 1
      if (await this.cancelled()) return this.finish('cancelled', { error: 'Run cancelled' })
      if (Date.now() - this.startedAt > limits.maxWallClockMs) {
        return this.finish('failed', { error: `Wall-clock limit of ${limits.maxWallClockMs}ms reached` })
      }

      let completion
      try {
        completion = await completeWithFallback({
          candidates,
          // Same agent → same stable prefix: one cache key per agent (OpenAI routing; Anthropic matches by prefix).
          request: {
            system: this.modelSettings().thinking === 'off' && this.trigger === 'voice' ? [...assembled.systemBlocks, { text: VOICE_NOTE }] : assembled.systemBlocks,
            thinking: this.modelSettings().thinking,
            messages,
            tools: assembled.llmTools,
            cacheKey: `agent:${this.agent.id}`,
            onTextDelta: this.options.onTextDelta ? (delta: string) => this.options.onTextDelta!(delta, iteration) : undefined,
          },
          modelConfig: this.modelSettings(),
          maxRetries: limits.maxRetries,
          deps: { createClient: this.options.deps?.createClient, sleep: this.options.deps?.sleep },
          onAttempt: (attempt) => this.modelAttempts.push(attempt),
        })
      } catch (error) {
        if (error instanceof ModelUnavailableError) return this.finish('failed', { error: error.message })
        throw error
      }

      const { response, candidate } = completion
      this.modelUsed = { provider: candidate.provider, model: candidate.model }
      if (candidate.role === 'fallback') this.note(`fell back to ${candidate.provider}/${candidate.model}`)
      this.usage.input += totalInputTokens(response.usage)
      this.usage.output += response.usage.outputTokens
      this.usage.cacheRead += response.usage.cacheReadTokens ?? 0
      this.usage.cacheWrite += response.usage.cacheWriteTokens ?? 0
      const callCost = estimateCostUsd(candidate.model, response.usage)
      if (callCost !== null) {
        this.ownCost += callCost
        this.costKnown = true
      }

      this.recordStep({
        kind: 'model',
        text: response.content ? redactString(response.content, 1500) : undefined,
        thinking: readableThinking(response.providerContent),
        calls: response.toolCalls.length ? response.toolCalls.map((c) => ({ tool: c.name, input: redact(c.input, { maxStringLength: 300 }) })) : undefined,
      })

      if (!response.toolCalls.length) {
        return this.assess(response.content)
      }

      if (this.spentUsd() >= this.budgetUsd) {
        return this.finish('blocked', { error: `Cost budget exhausted ($${this.spentUsd().toFixed(4)} of $${this.budgetUsd.toFixed(4)})` })
      }

      messages.push({ role: 'assistant', content: response.content ?? undefined, toolCalls: response.toolCalls, providerContent: response.providerContent })
      const toolResults: NonNullable<LLMMessage['toolResults']> = []

      for (const call of response.toolCalls) {
        toolCallCount++
        if (toolCallCount > limits.maxToolCalls) {
          return this.finish('failed', { error: `Tool call limit of ${limits.maxToolCalls} reached` })
        }
        if (await this.cancelled()) return this.finish('cancelled', { error: 'Run cancelled' })

        // ---- platform tools
        if (call.name === CLARIFY_TOOL.name) {
          const questions = asStringArray(call.input.questions)
          return this.finish('needs_clarification', {
            clarificationQuestions: questions.length ? questions : ['The agent needs more information to continue.'],
            output: response.content,
          })
        }
        if (call.name === END_CALL_TOOL.name && this.trigger === 'voice') {
          // The goodbye is this reply's text; checked like any answer.
          this.endCall = true
          return this.assess(response.content?.trim() ? response.content : 'Thanks for calling. Have a great day!')
        }
        if (call.name === ESCALATE_TOOL.name) {
          const reason = typeof call.input.reason === 'string' && call.input.reason.trim() ? call.input.reason : 'Agent requested human help'
          const severity = typeof call.input.severity === 'string' ? call.input.severity : 'medium'
          return this.finish('escalated', {
            // The hand-off is what the person acts on: keep a full findings list (Casey's sweeps run to ~2,000 chars).
            escalation: { reason: redactString(reason, ESCALATION_REASON_MAX_CHARS), severity, destination: this.contract.escalation.destination },
            output: response.content,
          })
        }
        if (call.name === 'platform__delegate' && assembled.specialists.size) {
          const outcome = await this.delegate(call.input, assembled.specialists)
          if ('terminal' in outcome) return outcome.terminal
          toolResults.push({ toolCallId: call.id, name: call.name, output: outcome.text, isError: outcome.isError })
          continue
        }

        if (assembled.workforce.has(call.name)) {
          const outcome = await this.runWorkforceTool(call.name, call.input)
          toolResults.push({ toolCallId: call.id, name: call.name, output: outcome.text, isError: outcome.isError })
          continue
        }

        // ---- registered tools
        const registered = assembled.registered.get(call.name)
        if (!registered) {
          this.toolCalls.push({ toolName: call.name, input: redact(call.input), error: 'Unknown or unavailable tool', status: 'error' })
          toolResults.push({ toolCallId: call.id, name: call.name, output: { error: `Tool "${call.name}" is not available to you.` }, isError: true })
          continue
        }

        const failureKey = `${call.name}|${canonicalJson(call.input)}`
        const result = await this.runTool(registered, call.input, response.content)
        if ('terminal' in result) return result.terminal
        toolResults.push({ toolCallId: call.id, name: call.name, output: result.text, isError: result.isError })

        if (result.isError) {
          const count = (failureCounts.get(failureKey) ?? 0) + 1
          failureCounts.set(failureKey, count)
          if (count >= 2) {
            return this.finish('failed', { error: `Repeated identical failure of ${call.name}; stopping instead of looping.` })
          }
        }
      }

      for (const r of toolResults) this.recordStep({ kind: 'tool', tool: r.name, ok: !r.isError, result: summarizeToolOutput(r.output) })
      messages.push({ role: 'user', toolResults })
    }

    return this.finish('failed', { error: `Agent exceeded max iterations (${this.maxIterations()}) without a final answer` })
  }

  private async runTool(
    registered: RegisteredTool,
    rawInput: Record<string, unknown>,
    rationale: string | null
  ): Promise<{ text: string; isError: boolean } | { terminal: RunAgentResult }> {
    const toolName = registered.toolName
    const killSwitch = readKillSwitch(this.agent.tenant.settings)

    let authorized
    try {
      authorized = await authorizeToolCall({
        agentId: this.agent.id,
        registered,
        input: rawInput,
        stage: this.stage,
        allowedTools: this.contract.allowedTools ?? null,
        disabledTools: killSwitch.disabledTools,
      })
    } catch (error) {
      const message = error instanceof ToolInputValidationError ? error.message : safeErrorMessage(error)
      this.toolCalls.push({ toolName, input: redact(rawInput), error: message, status: 'error' })
      return { text: JSON.stringify({ error: message }), isError: true }
    }

    const { decision, profile, input } = authorized
    switch (decision.kind) {
      case 'deny': {
        this.toolCalls.push({ toolName, input: redact(input), status: 'denied', reason: decision.reason })
        await this.audit('AGENT_TOOL_DENIED', { tool: toolName, reason: decision.reason })
        return { text: JSON.stringify({ error: `Denied: ${decision.reason}` }), isError: true }
      }
      case 'propose': {
        this.toolCalls.push({ toolName, input: redact(input), status: 'proposed', reason: decision.reason })
        this.proposedActions.push({ toolName, input: redact(input), reason: decision.reason })
        await this.audit('AGENT_TOOL_PROPOSED', { tool: toolName, input, reason: decision.reason })
        return {
          text: JSON.stringify({ notExecuted: true, note: `${decision.reason}. Describe the proposed action in your final answer; do not claim it was done.` }),
          isError: false,
        }
      }
      case 'approval': {
        this.toolCalls.push({ toolName, input: redact(input), status: 'approval_required', reason: decision.reason })
        let approvalId: string | undefined
        if (!this.options.dryRun) {
          approvalId = await createToolApproval({
            tenantId: this.agent.tenantId,
            agentId: this.agent.id,
            agentVersion: this.agent.version,
            runId: this.runId,
            workflowRunId: this.options.workflowRunId,
            workflowStepId: this.options.workflowStepId,
            toolName,
            adapterName: registered.adapter.name,
            input,
            level: decision.level,
            profile,
            rationale,
            policyReason: decision.reason,
            ttlHours: this.contract.approvals.ttlHours,
            userId: this.options.userId,
          })
        }
        return { terminal: await this.finish('approval_required', { approvalId, pendingTool: { toolName, input: redact(input) }, output: rationale }) }
      }
      case 'execute': {
        const outcome = await runAuthorizedTool(registered, input, profile, {
          tenantId: this.agent.tenantId,
          agentId: this.agent.id,
          runId: this.runId,
          userId: this.options.userId,
          workflowRunId: this.options.workflowRunId,
          timeoutMs: this.contract.limits.toolTimeoutMs,
          dryRun: this.options.dryRun,
          liveReads: this.options.liveReads,
          toolFixtures: this.options.toolFixtures,
          executeTool: this.options.deps?.executeTool,
          level: decision.level,
        })
        switch (outcome.kind) {
          case 'completed':
          case 'simulated': {
            this.toolCalls.push({ toolName, input: redact(input), output: redact(outcome.output), status: outcome.kind })
            const wrapped = wrapUntrusted(`tool:${toolName}`, outcome.output)
            if (wrapped.signals.length) this.injectionSignals.push({ source: `tool:${toolName}`, signals: wrapped.signals })
            return { text: wrapped.text, isError: false }
          }
          case 'duplicate_suppressed': {
            this.toolCalls.push({ toolName, input: redact(input), status: 'duplicate_suppressed', reason: `identical call already ran in run ${outcome.prior.runId}` })
            return {
              text: JSON.stringify({
                notExecuted: true,
                duplicate: true,
                note: `An identical ${toolName} call already succeeded at ${outcome.prior.at.toISOString()}; it was not repeated.`,
              }),
              isError: false,
            }
          }
          case 'unknown_outcome': {
            this.toolCalls.push({ toolName, input: redact(input), status: 'unknown_outcome', error: outcome.reason })
            return {
              terminal: await this.finish('escalated', {
                escalation: { reason: outcome.reason, severity: 'high', destination: this.contract.escalation.destination },
              }),
            }
          }
          case 'error': {
            this.toolCalls.push({ toolName, input: redact(input), error: outcome.message, status: 'error' })
            return { text: JSON.stringify({ error: outcome.message }), isError: true }
          }
        }
      }
    }
  }

  private readonly workforceCounts = new Map<string, number>()

  /** Self-management platform tools. Proposals only enter the revision pipeline; nothing here edits an agent. */
  private async runWorkforceTool(name: string, input: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const outcome = await executeWorkforceTool(name, input, {
      tenantId: this.agent.tenantId,
      agentId: this.agent.id,
      runId: this.runId,
      stage: this.stage!,
      contract: this.contract,
      dryRun: this.options.dryRun === true,
      counts: this.workforceCounts,
    })
    const isError = outcome.status === 'error' || outcome.status === 'denied'
    this.toolCalls.push({
      toolName: name,
      input: redact(input),
      output: WORKFORCE_READ_TOOLS.has(name) ? undefined : redact(outcome.output),
      status: outcome.status,
      reason: outcome.reason,
      error: isError ? JSON.stringify(redact(outcome.output)).slice(0, 1000) : undefined,
    })
    if (outcome.status === 'proposed') {
      this.proposedActions.push({ toolName: name, input: redact(input), reason: outcome.reason ?? 'proposal only' })
    }
    // Agent definitions, run outputs and suggestions originate partly from external content: data, not instructions.
    if (WORKFORCE_READ_TOOLS.has(name) && !isError) {
      const wrapped = wrapUntrusted(`platform:${name}`, outcome.output)
      if (wrapped.signals.length) this.injectionSignals.push({ source: `platform:${name}`, signals: wrapped.signals })
      return { text: wrapped.text, isError: false }
    }
    return { text: JSON.stringify(outcome.output), isError }
  }

  // ------------------------------------------------------------------ DELEGATION
  private async delegate(
    rawInput: Record<string, unknown>,
    specialists: Map<string, Specialist>
  ): Promise<{ text: string; isError: boolean } | { terminal: RunAgentResult }> {
    const specialistId = typeof rawInput.specialistAgentId === 'string' ? rawInput.specialistAgentId : ''
    const task = typeof rawInput.task === 'string' ? rawInput.task.trim() : ''
    const deny = (reason: string) => {
      this.toolCalls.push({ toolName: 'platform__delegate', input: redact(rawInput), status: 'denied', reason })
      return { text: JSON.stringify({ error: `Delegation denied: ${reason}` }), isError: true }
    }

    if (!specialists.has(specialistId)) return deny(`"${specialistId}" is not an allowed specialist`)
    if (!task) return deny('task is empty')
    const depth = (this.options.parent?.depth ?? 0) + 1
    if (depth > Math.min(this.contract.delegation.maxDepth, MAX_DELEGATION_DEPTH)) return deny(`max delegation depth ${this.contract.delegation.maxDepth} reached`)
    const chain = [...(this.options.parent?.chain ?? []), this.agent.id]
    if (chain.includes(specialistId)) return deny('delegation cycle')
    if (this.childRuns.length >= this.contract.delegation.maxChildren) return deny(`max ${this.contract.delegation.maxChildren} child runs per task reached`)
    const remaining = this.budgetUsd - this.spentUsd()
    if (remaining <= 0) return deny('no budget left for a child run')

    const child = await runAgent(specialistId, task, {
      trigger: 'delegation',
      parent: { runId: this.runId, rootRunId: this.rootRunId, chain, depth },
      budgetUsd: Number.isFinite(remaining) ? remaining : undefined,
      userId: this.options.userId,
      workflowRunId: this.options.workflowRunId,
      workflowStepId: this.options.workflowStepId,
      signal: this.options.signal,
      isCancelled: this.options.isCancelled,
      dryRun: this.options.dryRun,
      liveReads: this.options.liveReads,
      toolFixtures: this.options.toolFixtures,
      deps: this.options.deps,
    })
    this.childCost += child.costUsd ?? 0
    this.childRuns.push({ agentId: specialistId, runId: child.runId, status: child.status, costUsd: child.costUsd, dodPassed: child.dod?.passed })
    this.toolCalls.push({ toolName: 'platform__delegate', input: redact({ specialistAgentId: specialistId, task }), status: child.status === 'completed' ? 'completed' : 'error', reason: `child ${child.runId}: ${child.status}` })

    if (child.status === 'approval_required') {
      return {
        terminal: await this.finish('approval_required', { approvalId: child.approvalId, pendingTool: child.pendingTool, output: `${specialists.get(specialistId)?.name ?? specialistId} has prepared this and it is waiting for your approval.` }),
      }
    }
    // The manager must not blindly trust specialists: only a completed run whose
    // Definition of Done passed is handed back as a usable result.
    if (child.status !== 'completed' || child.dod?.passed !== true) {
      return {
        text: JSON.stringify({
          error: `Specialist ${specialistId} did not complete its Definition of Done (status: ${child.status}).`,
          detail: child.error ?? child.clarificationQuestions ?? child.escalation?.reason ?? null,
        }),
        isError: true,
      }
    }
    const wrapped = wrapUntrusted(`agent:${specialistId}`, child.output ?? '')
    if (wrapped.signals.length) this.injectionSignals.push({ source: `agent:${specialistId}`, signals: wrapped.signals })
    return { text: wrapped.text, isError: false }
  }

  // ------------------------------------------------------------------ ASSESS
  private async assess(output: string | null): Promise<RunAgentResult> {
    this.enter('assess')
    const evidenceCalls = this.toolCalls.map((c) => ({ toolName: c.toolName, status: c.status === 'simulated' ? 'completed' : c.status }))
    const dod = assessDefinitionOfDone(
      this.contract.definitionOfDone.checks,
      { output, toolCalls: evidenceCalls, costUsd: this.costKnown ? this.ownCost : null },
      this.contract.outputs
    )
    for (const r of dod.results) this.note(`${r.passed ? 'PASS' : 'FAIL'} ${r.check.type}: ${r.detail}`)
    // Voice agents hold conversations: ending a turn with a question is how they work.
    const conversational = this.trigger === 'voice' || readVoiceConfig(this.agent.config).voice.enabled
    this.qualitySignals = detectQualitySignals(output, this.toolCalls, { conversational })
    for (const signal of this.qualitySignals) this.note(`quality signal: ${signal}`)

    if (dod.passed) return this.finish('completed', { output, dod })
    const madeProgress = Boolean(output?.trim()) || this.toolCalls.some((c) => c.status === 'completed')
    const failed = dod.results.filter((r) => !r.passed).map((r) => r.detail)
    return this.finish(madeProgress ? 'partial' : 'failed', { output, dod, error: `Definition of Done not met: ${failed.join('; ')}` })
  }

  // ------------------------------------------------------------------ TERMINAL
  async finish(
    status: RunAgentStatus,
    extra: Partial<Pick<RunAgentResult, 'output' | 'dod' | 'error' | 'approvalId' | 'pendingTool' | 'clarificationQuestions' | 'escalation'>> & { skipAudit?: boolean } = {}
  ): Promise<RunAgentResult> {
    if (this.finished) return this.finished
    const costUsd = this.costKnown ? this.ownCost : this.usage.input + this.usage.output > 0 ? null : 0
    const result: RunAgentResult = {
      runId: this.runId,
      status,
      output: extra.output ?? null,
      toolCalls: this.toolCalls,
      tokensUsed: this.usage,
      costUsd,
      childCostUsd: this.childCost,
      durationMs: Date.now() - this.startedAt,
      agentVersion: this.agent.version,
      stage: this.stage,
      model: this.modelUsed,
      modelAttempts: this.modelAttempts,
      iterations: this.iterations,
      phases: this.phases,
      dod: extra.dod,
      proposedActions: this.proposedActions,
      clarificationQuestions: extra.clarificationQuestions,
      escalation: extra.escalation,
      childRuns: this.childRuns,
      contextWarnings: this.contextWarnings,
      injectionSignals: this.injectionSignals,
      qualitySignals: this.qualitySignals,
      reasoning: this.reasoning,
      approvalId: extra.approvalId,
      pendingTool: extra.pendingTool,
      endCall: this.endCall || undefined,
      error: extra.error ? redactString(extra.error, 1000) : undefined,
    }
    this.finished = result

    if (costUsd) await this.accrueDeploymentCost(costUsd)
    if (!extra.skipAudit) {
      await this.audit(AUDIT_ACTION[status], {
        status,
        trigger: this.trigger,
        input: this.input,
        output: result.output,
        error: result.error,
        agentVersion: this.agent.version,
        stage: this.stage,
        dryRun: this.options.dryRun === true,
        model: this.modelUsed,
        modelAttempts: this.modelAttempts.length,
        fallbackUsed: this.modelAttempts.some((a) => a.ok && a.role === 'fallback'),
        tokensUsed: this.usage,
        costUsd,
        childCostUsd: this.childCost,
        durationMs: result.durationMs,
        iterations: this.iterations,
        toolCalls: this.toolCalls.map((c) => ({ tool: c.toolName, status: c.status, reason: c.reason, error: c.error })),
        dodPassed: result.dod?.passed,
        dodResults: result.dod?.results.map((r) => ({ type: r.check.type, passed: r.passed, detail: r.detail })),
        proposedActions: this.proposedActions.length,
        approvalId: result.approvalId,
        clarificationQuestions: result.clarificationQuestions,
        escalation: result.escalation,
        endCall: result.endCall,
        childRuns: this.childRuns,
        contextWarnings: this.contextWarnings,
        injectionSignals: this.injectionSignals,
        qualitySignals: this.qualitySignals,
        phases: this.phases,
        reasoning: this.reasoning,
        parentRunId: this.options.parent?.runId,
        rootRunId: this.rootRunId,
      })
    }
    // A hand-off is work for a person: give it a record someone can find, act on and close.
    if (status === 'escalated' && result.escalation && !this.options.dryRun && !this.agent.isCandidate) {
      await prisma.handover
        .upsert({
          where: { runId: this.runId },
          update: {},
          create: {
            tenantId: this.agent.tenantId,
            agentId: this.agent.id,
            runId: this.runId,
            task: redactString(this.input, 4000),
            reason: result.escalation.reason,
            severity: result.escalation.severity,
            destination: result.escalation.destination,
          },
        })
        .catch((error) => console.error('Failed to record handover:', safeErrorMessage(error)))
    }
    if (status === 'completed' || status === 'partial') agentHeartbeatSafe(this.agent.id)
    if (status === 'failed') agentFailureSafe(this.agent.id, result.error)
    return result
  }

  private conversationFields(): Record<string, unknown> {
    const c = this.options.conversation
    if (!c || !isConversationId(c.id)) return {}
    return { conversationId: c.id, message: c.message.slice(0, CONVERSATION_MESSAGE_MAX_CHARS) }
  }

  private async audit(action: string, data: Record<string, unknown>): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          action,
          entityType: 'Agent',
          entityId: this.agent.id,
          tenantId: this.agent.tenantId,
          userId: this.options.userId,
          workflowRunId: this.options.workflowRunId,
          newData: redact({ runId: this.runId, ...(action.startsWith('AGENT_RUN_') ? this.conversationFields() : {}), ...data }) as never,
        },
      })
    } catch (error) {
      console.error('Failed to record audit log:', safeErrorMessage(error))
    }
  }

  /**
   * Best-effort accrual onto the agent's running Deployment, so
   * `Deployment.costPerMonth` (operator costs dashboard) reflects real spend.
   * Dry runs (evaluations) still cost real money and are included.
   */
  private async accrueDeploymentCost(costUsd: number): Promise<void> {
    try {
      await prisma.deployment.updateMany({
        where: { agentId: this.agent.id, status: 'running' },
        data: { costPerMonth: { increment: costUsd } },
      })
    } catch (error) {
      console.error('Failed to accrue deployment cost:', safeErrorMessage(error))
    }
  }
}

function agentHeartbeatSafe(agentId: string): void {
  try {
    agentHeartbeat(agentId)
  } catch {
    // monitoring must never break agent execution
  }
}

function agentFailureSafe(agentId: string, error: unknown): void {
  try {
    agentFailure(agentId, error instanceof Error ? error : String(error ?? 'unknown error'))
  } catch {
    // monitoring must never break agent execution
  }
}
