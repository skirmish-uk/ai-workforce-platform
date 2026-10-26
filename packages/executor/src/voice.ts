import { z } from 'zod'
import type { RunAgentResult } from './agent'

/** Who agreed to their voice being cloned, and when. */
const consentSchema = z
  .object({
    consentFrom: z.string().min(2).max(200),
    consentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    consentReference: z.string().max(300).optional(),
  })
  .strict()

/** Cloned voices an agent keeps to switch between (each a private copy at Cartesia). */
export const MAX_SAVED_VOICES = 8

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
    /**
     * Names and terms callers are likely to say (products, people, suburbs), given to
     * speech-to-text as a hint so they are spelled right on poor microphones.
     */
    vocabulary: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
    /** Speech-to-text for this agent's calls; default SPEECH_STT_PROVIDER. Compare them on the agent page first. */
    sttProvider: z.enum(['openai', 'deepgram', 'speechmatics']).optional(),
    /**
     * Transcribe the caller as they speak (default on when OpenAI is configured): their words
     * show as they say them and the answer starts sooner. false sends each turn as a recording.
     */
    liveTranscription: z.boolean().optional(),
    /** Short "mm-hm"s while the caller is talking at length (default on; needs live transcription). */
    backchannels: z.boolean().optional(),
    /** Provider voice: an OpenAI voice name, or a Cartesia voice id. */
    voiceId: z.string().min(1).max(100).optional(),
    /**
     * Required when voiceId is a cloned voice: who consented to their voice being
     * cloned and used by this agent, and when. Cloning without consent is not supported.
     */
    clonedVoice: consentSchema.optional(),
    /**
     * Every cloned voice recorded for this agent, each with its consent record, so the agent can
     * switch between them (and back to a stock voice) without recording again. The one in use is
     * voiceId (with its consent copied into clonedVoice).
     */
    voices: z.array(consentSchema.extend({ voiceId: z.string().min(1).max(100) }).strict()).max(MAX_SAVED_VOICES).optional(),
    /** The stock voice in use before a cloned voice replaced it, restored when switching back to it. */
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
export type SavedVoice = NonNullable<VoiceConfig['voices']>[number]

/**
 * The agent's cloned voices. A voice cloned before there was a list (only `clonedVoice` set) is
 * included, so it isn't lost when another is added.
 */
export function savedVoices(voice: VoiceConfig): SavedVoice[] {
  const list = [...(voice.voices ?? [])]
  if (voice.clonedVoice && voice.voiceId && !list.some((v) => v.voiceId === voice.voiceId)) list.unshift({ voiceId: voice.voiceId, ...voice.clonedVoice })
  return list
}

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
export function spokenReply(result: Pick<RunAgentResult, 'status' | 'output' | 'clarificationQuestions'> & Partial<Pick<RunAgentResult, 'escalation'>>): string {
  const output = result.output?.trim() ?? ''
  switch (result.status) {
    case 'completed':
    case 'partial':
      return output || 'Sorry, I don’t have an answer for that.'
    case 'needs_clarification':
      return result.clarificationQuestions?.length ? result.clarificationQuestions.join(' ') : output || 'Could you tell me a bit more?'
    case 'approval_required':
      // Never promises that someone will get back to them: the caller may not have said how to reach them.
      return 'I’ve passed that to the team to approve.'
    case 'escalated':
      // Only a hand-off that says how to reach the caller (agent.ts adds "Contact: …") promises a call back.
      return /\nContact: /.test(result.escalation?.reason ?? '')
        ? 'Thanks, I’ve passed that on, and the team will get back to you on the details you gave.'
        : 'That’s one for the team, so I’ve passed it on.'
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

/** Cartesia's stock Australian voices offered when creating an agent (no consent record needed). */
export const STOCK_VOICES = [
  { id: '391f4c0a-f1a8-4c21-9aa2-7a07f0a4b0dc', name: 'Bronte', description: 'Australian, female: bright and trustworthy' },
  { id: '12e85709-099c-480a-ba3e-875c41a9611a', name: 'Arlo', description: 'Australian, male: friendly, mid-toned' },
  { id: '79d2cf27-444a-4c3a-9eed-2ad5cf795a3b', name: 'Fraser', description: 'Australian, male: bright and articulate' },
] as const

/**
 * Checks the voice settings a new agent is created with. A cloned voice can't be set here:
 * it only comes from the clone endpoint, which records the speaker's consent.
 */
export function validateNewAgentVoice(config: unknown): string | null {
  const raw = config && typeof config === 'object' ? (config as Record<string, unknown>).voice : undefined
  if (raw === undefined) return null
  const parsed = voiceConfigSchema.safeParse(raw)
  if (!parsed.success) return parsed.error.issues.map((i) => `voice.${i.path.join('.')}: ${i.message}`).join('; ')
  if (parsed.data.clonedVoice || parsed.data.previous || parsed.data.voices?.length) return 'A cloned voice is added after the agent is created, with the speaker’s recorded consent (Use your own voice)'
  if (parsed.data.provider === 'cartesia' && parsed.data.voiceId && !STOCK_VOICES.some((v) => v.id === parsed.data.voiceId)) {
    return 'Choose one of the stock voices, or add your own voice after creating the agent'
  }
  return null
}
