import { test } from 'node:test'
import assert from 'node:assert/strict'
import { supportsSamplingParams, toAnthropicMessages } from './anthropic'

test('temperature is only sent to Claude models that still accept it', () => {
  for (const model of ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'claude-3-5-haiku-20241022']) {
    assert.equal(supportsSamplingParams(model), true, model)
  }
  for (const model of ['claude-sonnet-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-fable-5-1', 'claude-haiku-5-5', 'claude-some-future-model']) {
    assert.equal(supportsSamplingParams(model), false, model)
  }
})

test('Anthropic assistant turns are replayed unchanged for the same model, rebuilt otherwise', () => {
  const original = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'x', input: {} }]
  const messages = [
    { role: 'user' as const, content: 'hi' },
    { role: 'assistant' as const, content: undefined, toolCalls: [{ id: 't1', name: 'x', input: {} }], providerContent: { provider: 'anthropic' as const, model: 'claude-haiku-5-5', content: original } },
  ]
  assert.deepEqual(toAnthropicMessages(messages, 'claude-haiku-5-5')[1].content, original, 'same model: exact blocks, thinking included')
  const rebuilt = toAnthropicMessages(messages, 'claude-sonnet-5-5')[1].content as Array<{ type: string }>
  assert.deepEqual(rebuilt.map((b) => b.type), ['tool_use'], 'fallback model: rebuilt without the other model\'s thinking')
})
