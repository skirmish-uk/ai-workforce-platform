/**
 * Conversations: the runs a person had with an agent, grouped the way they happened.
 *
 * Every run started from the dashboard (a typed task and its follow-ups, or the turns of a
 * voice call) carries a `conversationId` and the person's own words (`message`) on its audit
 * row. Runs from before conversations existed are grouped by best guess: consecutive voice
 * turns close together are one call; anything else stands alone.
 */

export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/
/** How much of a person's message is kept on the run's audit row. */
export const CONVERSATION_MESSAGE_MAX_CHARS = 4000
/** Exchanges replayed to the agent when a typed conversation continues. */
export const FOLLOW_UP_HISTORY_EXCHANGES = 8
/** Older voice turns this close together are taken to be one call. */
const LEGACY_CALL_GAP_MS = 10 * 60 * 1000
/** Ids of conversations guessed from runs that had none start with this. */
export const LEGACY_CONVERSATION_PREFIX = 'run-'

export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID_PATTERN.test(value)
}

export interface ConversationRunLike {
  runId: string
  at: string | Date
  trigger?: string
  input?: string
  output?: string | null
  status?: string
  costUsd?: number | null
  conversationId?: string
  message?: string
}

export interface Conversation<R extends ConversationRunLike = ConversationRunLike> {
  id: string
  /** True for a conversation recorded with an id; false for one guessed from older runs. */
  recorded: boolean
  kind: 'voice' | 'text'
  title: string
  startedAt: string
  lastAt: string
  costUsd: number
  /** Oldest first. */
  runs: R[]
}

const LEGACY_VOICE_INPUT = /The caller now says: "([\s\S]*)"\s*\n\nReply to what the caller just said/

/** What the person actually said or typed in this run. */
export function runMessage(run: Pick<ConversationRunLike, 'message' | 'input'>): string {
  if (run.message) return run.message
  const voice = run.input ? LEGACY_VOICE_INPUT.exec(run.input) : null
  return voice ? voice[1] : run.input ?? ''
}

/** The task given to the agent when a typed conversation continues: the exchanges so far, then the new message. */
export function followUpInput(history: Array<{ message: string; answer: string }>, message: string, agentName?: string): string {
  const recent = history.slice(-FOLLOW_UP_HISTORY_EXCHANGES)
  if (!recent.length) return message
  const you = agentName?.split(' ')[0] ?? 'You'
  const lines = recent.flatMap((h) => [`Person: ${h.message}`, `${you}: ${h.answer}`])
  return `This continues an earlier conversation with you. The conversation so far, most recent last:\n${lines.join('\n')}\n\nThe person now says:\n${message}\n\nReply in the context of the conversation.`
}

/** Groups runs (any order) into conversations, most recently active first. */
export function groupConversations<R extends ConversationRunLike>(runs: R[]): Array<Conversation<R>> {
  const ordered = [...runs].sort((a, b) => time(a.at) - time(b.at))
  const groups = new Map<string, { recorded: boolean; runs: R[] }>()
  let legacyCall: { key: string; lastAt: number } | null = null
  for (const run of ordered) {
    let key: string
    let recorded = true
    if (run.conversationId) {
      key = run.conversationId
    } else {
      recorded = false
      const at = time(run.at)
      if (run.trigger === 'voice' && legacyCall && at - legacyCall.lastAt <= LEGACY_CALL_GAP_MS) {
        key = legacyCall.key
      } else {
        key = `${LEGACY_CONVERSATION_PREFIX}${run.runId}`
      }
      legacyCall = run.trigger === 'voice' ? { key, lastAt: at } : null
    }
    const group = groups.get(key) ?? { recorded, runs: [] }
    group.runs.push(run)
    groups.set(key, group)
  }
  return Array.from(groups, ([id, g]) => {
    const first = g.runs[0]
    const last = g.runs[g.runs.length - 1]
    return {
      id,
      recorded: g.recorded,
      kind: g.runs.some((r) => r.trigger === 'voice') ? 'voice' as const : 'text' as const,
      title: runMessage(first).trim() || '(no message)',
      startedAt: new Date(first.at).toISOString(),
      lastAt: new Date(last.at).toISOString(),
      costUsd: g.runs.reduce((sum, r) => sum + (typeof r.costUsd === 'number' ? r.costUsd : 0), 0),
      runs: g.runs,
    }
  }).sort((a, b) => time(b.lastAt) - time(a.lastAt))
}

function time(at: string | Date): number {
  return new Date(at).getTime()
}
