import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicLLMClient, supportsSamplingParams, toAnthropicMessages, toAnthropicSystem } from './anthropic'
import { parseOpenAIChatCompletion, toOpenAIMessages } from './openai'
import { estimateCostUsd } from './pricing'
import { totalInputTokens } from './types'

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

test('prompt caching: breakpoint after the stable system prefix, automatic caching for the conversation', () => {
  const client = new AnthropicLLMClient('claude-haiku-5-5', { apiKey: 'test' })
  const request = client.buildRequest({
    system: [{ text: 'policy + playbooks', cache: true }, { text: 'knowledge + current time' }],
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.deepEqual(request.system, [
    { type: 'text', text: 'policy + playbooks', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'knowledge + current time' },
  ])
  assert.deepEqual(request.cache_control, { type: 'ephemeral' })
  // A plain string system prompt is passed through unchanged.
  assert.equal(client.buildRequest({ system: 'plain', messages: [] }).system, 'plain')
  // Never more than 3 explicit breakpoints (the API allows 4; automatic caching uses one).
  const many = toAnthropicSystem(Array.from({ length: 5 }, (_, i) => ({ text: `b${i}`, cache: true }))) as Array<{ cache_control?: unknown }>
  assert.equal(many.filter((b) => b.cache_control).length, 3)
})

test('cost counts cache reads and writes at their own rates', () => {
  // Haiku 5.5: $0.10 input, $0.50 output; cache read 0.1x ($0.01), write 1.25x ($0.125) per MTok.
  const cost = estimateCostUsd('claude-haiku-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 })!
  assert.ok(Math.abs(cost - (0.1 + 0.5 + 0.01 + 0.125)) < 1e-9, String(cost))
  // Explicit read rate where Anthropic publishes one: Opus 5.5 reads at $0.20.
  assert.ok(Math.abs(estimateCostUsd('claude-opus-5-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })! - 0.2) < 1e-9)
  // OpenAI: cached input at half price, no write premium.
  assert.ok(Math.abs(estimateCostUsd('gpt-4o-mini', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 })! - (0.075 + 0.15)) < 1e-9)
  assert.equal(totalInputTokens({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 1000 }), 1110)
})

test('OpenAI: cached prompt tokens are split out of input tokens', () => {
  const parsed = parseOpenAIChatCompletion({
    id: 'x', object: 'chat.completion', created: 0, model: 'gpt-4o-mini',
    choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'ok', refusal: null } }],
    usage: { prompt_tokens: 2000, completion_tokens: 10, total_tokens: 2010, prompt_tokens_details: { cached_tokens: 1536 } },
  } as never)
  assert.deepEqual(parsed.usage, { inputTokens: 464, outputTokens: 10, cacheReadTokens: 1536 })
  assert.deepEqual(toOpenAIMessages([{ text: 'stable', cache: true }, { text: 'per request' }], [])[0], { role: 'system', content: 'stable\n\nper request' })
})
