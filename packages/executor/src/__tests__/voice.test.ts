import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultGreeting, readVoiceConfig, savedVoices, spokenReply, validateNewAgentVoice } from '../voice'

test('voice config: off by default, cloned voices need recorded consent, greetings must disclose AI', () => {
  assert.equal(readVoiceConfig({}).voice.enabled, false)
  assert.equal(readVoiceConfig({ voice: { enabled: true, voiceId: 'coral' } }).voice.enabled, true)

  const cloned = readVoiceConfig({ voice: { enabled: true, voiceId: 'v-1', clonedVoice: { consentFrom: 'Jane Owner', consentDate: '2026-10-13' } } })
  assert.equal(cloned.error, undefined)
  assert.match(readVoiceConfig({ voice: { enabled: true, clonedVoice: { consentFrom: 'Jane', consentDate: '2026-10-13' } } }).error ?? '', /cloned voice needs its voiceId/)
  assert.match(readVoiceConfig({ voice: { enabled: true, voiceId: 'v', clonedVoice: { consentFrom: 'Jane' } } }).error ?? '', /consentDate/)

  const hidden = readVoiceConfig({ voice: { enabled: true, greeting: 'Hi, this is Ava from the agency.' } })
  assert.match(hidden.error ?? '', /must tell callers they are talking to an AI/)
  assert.equal(hidden.voice.enabled, false, 'an invalid config fails closed')
  assert.equal(readVoiceConfig({ voice: { enabled: true, greeting: "Hi, I'm Ava, the agency's AI assistant." } }).error, undefined)
  assert.match(defaultGreeting('Ava - Client Questions'), /^Hi, I'm Ava, an AI assistant/)
})

test('spoken replies never claim a gated action happened', () => {
  assert.equal(spokenReply({ status: 'completed', output: 'We are open 9 to 5.' }), 'We are open 9 to 5.')
  assert.match(spokenReply({ status: 'approval_required', output: 'I sent the email.' }), /passed that to the team to approve/)
  assert.equal(spokenReply({ status: 'needs_clarification', output: null, clarificationQuestions: ['Which office?'] }), 'Which office?')
  assert.match(spokenReply({ status: 'escalated', output: null }), /passed it on/)
  // A call back is promised only when the hand-off says how to reach the caller.
  assert.doesNotMatch(spokenReply({ status: 'escalated', output: null }), /get back to you|follow up/)
  assert.match(spokenReply({ status: 'escalated', output: null, escalation: { reason: 'Custom package\nContact: name: Jamie, phone: 0412 555 019', severity: 'low', destination: 'x' } }), /get back to you on the details you gave/)
  assert.doesNotMatch(spokenReply({ status: 'approval_required', output: null }), /confirm with you/)
  assert.match(spokenReply({ status: 'failed', output: 'partial text' }), /can’t help with that right now/)
})

test('saved voices: a voice cloned before the list existed is kept; each needs consent; new agents get none', () => {
  const legacy = readVoiceConfig({ voice: { enabled: true, provider: 'cartesia', voiceId: 'v-sam', clonedVoice: { consentFrom: 'Sam', consentDate: '2026-10-20' } } }).voice
  assert.deepEqual(savedVoices(legacy), [{ voiceId: 'v-sam', consentFrom: 'Sam', consentDate: '2026-10-20' }])

  const both = readVoiceConfig({ voice: { enabled: true, provider: 'cartesia', voiceId: 'v-jo', clonedVoice: { consentFrom: 'Jo', consentDate: '2026-10-22' }, voices: [{ voiceId: 'v-sam', consentFrom: 'Sam', consentDate: '2026-10-20' }, { voiceId: 'v-jo', consentFrom: 'Jo', consentDate: '2026-10-22' }] } })
  assert.equal(both.error, undefined)
  assert.deepEqual(savedVoices(both.voice).map((v) => v.voiceId), ['v-sam', 'v-jo'])

  assert.match(readVoiceConfig({ voice: { enabled: true, voices: [{ voiceId: 'v-x', consentFrom: 'X' }] } }).error ?? '', /consentDate/)
  assert.match(validateNewAgentVoice({ voice: { enabled: true, voices: [{ voiceId: 'v-x', consentFrom: 'Xavier', consentDate: '2026-10-22' }] } }) ?? '', /after the agent is created/)
})
