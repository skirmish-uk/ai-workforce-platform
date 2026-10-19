import { z } from 'zod'
import type { RunAgentResult } from './agent'

/**
 * Voice settings for an agent, in Agent.config.voice (outside the contract: they change
 * how the agent sounds, not what it is allowed to do). See docs/VOICE.md.
 */
export const voiceConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Spoken when a conversation starts. Must say the caller is talking to an AI. */
    greeting: z.string().max(300).optional(),
    provider: z.enum(['openai', 'cartesia']).optional(),
    /** Provider voice: an OpenAI voice name, or a Cartesia voice id. */
    voiceId: z.string().min(1).max(100).optional(),
    /**
     * Required when voiceId is a cloned voice: who consented to their voice being
     * cloned and used by this agent, and when. Cloning without consent is not supported.
     */
    clonedVoice: z
      .object({
        consentFrom: z.string().min(2).max(200),
        consentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
        consentReference: z.string().max(300).optional(),
      })
      .strict()
      .optional(),
    /** The voice in use before a cloned voice replaced it, restored when the clone is removed. */
    previous: z
      .object({ provider: z.enum(['openai', 'cartesia']).optional(), voiceId: z.string().min(1).max(100).optional() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.clonedVoice && !value.voiceId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['voiceId'], message: 'A cloned voice needs its voiceId' })
    }
    if (value.greeting && !/\b(ai|a\.i\.|artificial intelligence|virtual assistant|automated)\b/i.test(value.greeting)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['greeting'], message: 'The greeting must tell callers they are talking to an AI' })
    }
  })

export type VoiceConfig = z.infer<typeof voiceConfigSchema>

export function readVoiceConfig(config: unknown): { voice: VoiceConfig; error?: string } {
  const raw = config && typeof config === 'object' ? (config as Record<string, unknown>).voice : undefined
  const parsed = voiceConfigSchema.safeParse(raw ?? {})
  if (parsed.success) return { voice: parsed.data }
  return { voice: { enabled: false }, error: parsed.error.issues.map((i) => `voice.${i.path.join('.')}: ${i.message}`).join('; ') }
}

export function defaultGreeting(agentName: string): string {
  const first = agentName.split(/\s+[-–]\s+|\s+/)[0] || 'your assistant'
  return `Hi, I'm ${first}, an AI assistant. How can I help?`
}

/**
 * What the agent says out loud for each way a run can end. Never claims an action
 * happened: an approval-gated action is described as passed on, not done.
 */
export function spokenReply(result: Pick<RunAgentResult, 'status' | 'output' | 'clarificationQuestions'>): string {
  const output = result.output?.trim() ?? ''
  switch (result.status) {
    case 'completed':
    case 'partial':
      return output || 'Sorry, I don’t have an answer for that.'
    case 'needs_clarification':
      return result.clarificationQuestions?.length ? result.clarificationQuestions.join(' ') : output || 'Could you tell me a bit more?'
    case 'approval_required':
      return 'I’ve passed that to the team to approve, and someone will confirm with you shortly.'
    case 'escalated':
      return 'That’s one for a colleague. I’ve passed it on, and someone will follow up with you.'
    case 'cancelled':
    case 'blocked':
    case 'failed':
    default:
      return 'Sorry, I can’t help with that right now. I’ve let the team know.'
  }
}

/**
 * What the speaker reads when recording a voice to clone: the consent statement first (so the
 * recording itself carries it), then everyday front-desk sentences that cover a natural range
 * of sounds. About 30–40 seconds read at a normal pace; Cartesia needs at least 10.
 */
export function cloneScript(speakerName: string, businessName: string): string[] {
  const name = speakerName.trim() || 'the speaker'
  return [
    `My name is ${name}, and I agree to my voice being used for ${businessName}'s AI assistant.`,
    "Thanks for calling. We're open Monday to Friday, from nine in the morning until half past five.",
    "I can check which times are free this week and pass your details on to the team.",
    "Our office is just around the corner, and there's parking out the back if you're driving in.",
    "If it's urgent, leave your name and number and someone will call you back this afternoon.",
    'Have a great day, and thanks again for getting in touch.',
  ]
}
