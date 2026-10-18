import { getToolRiskProfile } from '@ai-workforce/tools'

/**
 * Quality signals: problems a run can have even when it "completed" and passed its
 * Definition of Done. Recorded on the run's audit row and counted in metrics so the
 * Workforce Manager can see them (it missed exactly this on 2026-10-13: an agent that
 * announced follow-ups it never made). Heuristic and conservative: a signal flags a run
 * for review; it never changes the run's status.
 */
export type QualitySignal = 'announced_without_action' | 'claimed_without_evidence' | 'asked_in_text'

const PROMISE = /\b(?:i['’]ll|i will|i am going to|i['’]m going to|let me|now i['’]ll|next,? i['’]ll)\s+(?:now\s+|go ahead and\s+|then\s+)?(?:draft|send|email|write|reply|follow up|update|create|add|log|book|schedule|escalate|forward|label|reach out|set up)\b/i
const ASKS = /\?\s*(?:\*\*)?\s*$|\b(?:could you|can you|please (?:confirm|provide|share|let me know)|do you want me to|should i|would you like me to)\b[^.!]*\?/i
const CLAIM = /\b(?:i['’]ve|i have|i)\s+(?:just\s+|already\s+)?(?:sent|emailed|updated|created|added|logged|booked|scheduled|forwarded|labelled|labeled|replied)\b/i

export interface SignalToolCall {
  toolName: string
  status: string
}

/** True when the run took (or put up for approval) at least one action that changes something. */
function actedOnSomething(toolCalls: SignalToolCall[]): boolean {
  return toolCalls.some(
    (c) =>
      !c.toolName.startsWith('platform__') &&
      getToolRiskProfile(c.toolName).risk !== 'read' &&
      ['completed', 'simulated', 'approval_required', 'proposed', 'duplicate_suppressed'].includes(c.status)
  )
}

/**
 * Detects signals on a run that finished as completed/partial (questions there should have used
 * the clarification tool). A conversational agent (voice, or a chat with a client) ends turns
 * with questions by design ("Which time suits you?"), so `conversational` skips that signal; the
 * promised/claimed-action checks still apply.
 */
export function detectQualitySignals(output: string | null, toolCalls: SignalToolCall[], options: { conversational?: boolean } = {}): QualitySignal[] {
  const text = output ?? ''
  if (!text.trim()) return []
  const signals: QualitySignal[] = []
  if (!actedOnSomething(toolCalls)) {
    if (PROMISE.test(text)) signals.push('announced_without_action')
    if (CLAIM.test(text)) signals.push('claimed_without_evidence')
  }
  // Ending on questions for the requester means the run is really waiting on an answer.
  if (!options.conversational && ASKS.test(text.trim().slice(-400))) signals.push('asked_in_text')
  return signals
}

export const QUALITY_SIGNAL_LABELS: Record<QualitySignal, string> = {
  announced_without_action: 'said it would do something but did not',
  claimed_without_evidence: 'said it did something with no action to show for it',
  asked_in_text: 'asked the requester questions in its answer instead of using the clarification tool',
}
