import { test } from 'node:test'
import assert from 'node:assert/strict'
import { followUpInput, groupConversations, isConversationId, runMessage } from '../conversations'

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 20, 9, minutes)).toISOString()

test('groups runs by conversation id, oldest turn first, latest conversation first', () => {
  const groups = groupConversations([
    { runId: 'a2', at: at(5), conversationId: 'conv-aaaa', message: 'And Saturdays?', trigger: 'api', costUsd: 0.002 },
    { runId: 'b1', at: at(30), conversationId: 'conv-bbbb', message: 'Draft a reply', trigger: 'api', costUsd: 0.01 },
    { runId: 'a1', at: at(1), conversationId: 'conv-aaaa', message: 'What are your hours?', trigger: 'api', costUsd: 0.001 },
  ])
  assert.deepEqual(groups.map((g) => g.id), ['conv-bbbb', 'conv-aaaa'])
  assert.deepEqual(groups[1].runs.map((r) => r.runId), ['a1', 'a2'])
  assert.equal(groups[1].title, 'What are your hours?')
  assert.equal(groups[1].recorded, true)
  assert.ok(Math.abs(groups[1].costUsd - 0.003) < 1e-9)
})

test('older runs: close voice turns become one call, typed tasks stand alone', () => {
  const voice = (n: number) => `This is a live voice call. The conversation so far, most recent last:\nCaller: hi\n\nThe caller now says: "question ${n}"\n\nReply to what the caller just said, in the context of the call. Don't greet them again.`
  const groups = groupConversations([
    { runId: 'v1', at: at(0), trigger: 'voice', input: voice(1) },
    { runId: 'v2', at: at(3), trigger: 'voice', input: voice(2) },
    { runId: 't1', at: at(4), trigger: 'api', input: 'Follow up the new lead' },
    { runId: 'v3', at: at(5), trigger: 'voice', input: voice(3) },
    { runId: 'v4', at: at(40), trigger: 'voice', input: voice(4) },
  ])
  assert.deepEqual(groups.map((g) => g.runs.map((r) => r.runId)), [['v4'], ['v3'], ['t1'], ['v1', 'v2']])
  assert.equal(groups[3].kind, 'voice')
  assert.equal(groups[3].title, 'question 1')
  assert.equal(groups[3].recorded, false)
  assert.equal(groups[2].kind, 'text')
})

test("a run's message is the person's own words", () => {
  assert.equal(runMessage({ message: 'Hello', input: 'long prompt' }), 'Hello')
  assert.equal(runMessage({ input: 'Plain task' }), 'Plain task')
})

test('a follow-up carries the recent exchanges; a first message goes as typed', () => {
  assert.equal(followUpInput([], 'Find me a time on Tuesday'), 'Find me a time on Tuesday')
  const input = followUpInput([{ message: 'Who is Priya?', answer: 'A new lead.' }], 'Email her', 'Sarah - Sales')
  assert.match(input, /Person: Who is Priya\?\nSarah: A new lead\./)
  assert.match(input, /The person now says:\nEmail her/)
})

test('conversation ids are short safe strings', () => {
  assert.equal(isConversationId('6f1c2d3e-aaaa-bbbb-cccc-123456789abc'), true)
  assert.equal(isConversationId('x'), false)
  assert.equal(isConversationId('a b c d e f g h'), false)
  assert.equal(isConversationId(42), false)
})
