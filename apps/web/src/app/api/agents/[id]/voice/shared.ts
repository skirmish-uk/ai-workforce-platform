import { NextResponse } from 'next/server'
import { prisma } from '@ai-workforce/db'
import { canAccessTenant, hasPermission } from '@ai-workforce/domain'
import { readVoiceConfig } from '@ai-workforce/executor'
import { UserRole } from '@prisma/client'

/** Shared by the voice routes: the agent, if this user may talk to it and voice is on. */
export async function loadAgent(agentId: string, session: { user: { role: string; tenantId: string } }) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } })
  if (!agent || agent.isCandidate) return { error: NextResponse.json({ error: 'Agent not found' }, { status: 404 }) }
  const role = session.user.role as UserRole
  if (!canAccessTenant(role, session.user.tenantId, agent.tenantId) || !hasPermission(role, 'agent:write')) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  const { voice, error } = readVoiceConfig(agent.config)
  if (error) return { error: NextResponse.json({ error: `Voice settings are invalid: ${error}` }, { status: 409 }) }
  if (!voice.enabled) return { error: NextResponse.json({ error: 'Voice is not enabled for this agent' }, { status: 409 }) }
  return { agent, voice }
}

/** Common capitalised words that are not names, so they stay out of the transcription hint. */
const NOT_NAMES = new Set(['I', 'I’m', "I'm", 'AI', 'OK', 'Okay', 'Sure', 'Yes', 'No', 'Hi', 'Hello', 'Thanks', 'Sorry', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])

/**
 * What the caller is likely to say by name: the agent, the business, the agent's configured
 * vocabulary, and names already said in this call (mid-sentence capitalised words).
 */
export function callVocabulary(agentName: string, tenantName: string | undefined, configured: string[] | undefined, rawHistory: FormDataEntryValue | null): Array<string | undefined> {
  const names: string[] = []
  try {
    const history = typeof rawHistory === 'string' ? JSON.parse(rawHistory) : []
    for (const h of Array.isArray(history) ? history.slice(-8) : []) {
      if (typeof h?.text !== 'string') continue
      for (const m of h.text.slice(0, 400).matchAll(/(?<![.!?]\s|^)\b(\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)*)/gu)) {
        if (!NOT_NAMES.has(m[1])) names.push(m[1])
      }
    }
  } catch { /* a malformed history adds no names */ }
  return [agentName.split(/\s+[-–]\s+/)[0], tenantName, ...(configured ?? []), ...names.slice(-15)]
}

/** Redis keys of a voice draft (route.ts, "draft"): who started it, its go-ahead, and its run. */
export function draftKeys(id: string) {
  return { id, owner: `voice-draft-owner-${id}`, hold: `voice-draft-${id}`, jobId: `voice-draft-${id}` }
}
