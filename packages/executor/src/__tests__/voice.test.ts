import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultGreeting, readVoiceConfig, spokenReply } from '../voice'

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
  assert.match(spokenReply({ status: 'failed', output: 'partial text' }), /can’t help with that right now/)
})
