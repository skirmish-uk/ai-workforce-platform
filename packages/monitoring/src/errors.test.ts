import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errorFingerprint, scrub } from './errors'
import { alertRequest, alertTarget, sendAlert } from './notify'
import { workerCheck } from './health'

test('the same error with different ids, numbers or values is one kind of error', () => {
  const a = errorFingerprint('worker', 'agent-run', 'Agent cmv9x9xkc000dth2yor9hf957 not found after 3 tries for "Ava"')
  const b = errorFingerprint('worker', 'agent-run', 'Agent cmvpu44nk0001tvekko4ww0mg not found after 12 tries for "Riley"')
  assert.equal(a, b)
  assert.notEqual(a, errorFingerprint('worker', 'deployment', 'Agent cmv9x9xkc000dth2yor9hf957 not found after 3 tries for "Ava"'), 'somewhere else is another kind')
  assert.notEqual(a, errorFingerprint('web', 'agent-run', 'Agent cmv9x9xkc000dth2yor9hf957 not found after 3 tries for "Ava"'))
  assert.equal(errorFingerprint('web', 'GET /api/agents/[id]', 'Request 1f0c2b7e-9d3a-4c1e-8f2a-0b1c2d3e4f5a failed'), 'web:GET /api/agents/[id]:Request <id> failed')
})

test('secrets in error messages are taken out', () => {
  assert.equal(scrub('401 for key sk-ant-api03-abcdefghijklmnop'), '401 for key [redacted]')
  assert.equal(scrub('Authorization: Bearer abc.def.ghi rejected'), 'Authorization: [redacted] rejected')
  assert.equal(scrub('nothing secret here'), 'nothing secret here')
})

test('alerts go to ntfy as text with a title, and to Slack and Discord as their JSON', () => {
  assert.equal(alertTarget('https://ntfy.sh/my-topic'), 'text')
  assert.equal(alertTarget('https://hooks.slack.com/services/T/B/x'), 'slack')
  assert.equal(alertTarget('https://discord.com/api/webhooks/1/abc'), 'discord')
  const ntfy = alertRequest('https://ntfy.sh/my-topic', 'Site down', 'Health check failed 3 times')
  assert.equal(ntfy.headers.Title, 'Site down')
  assert.equal(ntfy.body, 'Health check failed 3 times')
  assert.deepEqual(JSON.parse(alertRequest('https://hooks.slack.com/services/T/B/x', 'Site down', 'details').body), { text: 'Site down\ndetails' })
  assert.deepEqual(JSON.parse(alertRequest('https://discord.com/api/webhooks/1/abc', 'Site down', 'details').body), { content: 'Site down\ndetails' })
})

test('with no webhook an alert is only logged; a failing webhook never throws', async () => {
  assert.equal(await sendAlert('t', 'm', {}), false)
  const failing = (async () => { throw new Error('network down') }) as unknown as typeof fetch
  assert.equal(await sendAlert('t', 'm', { ALERT_WEBHOOK_URL: 'https://ntfy.sh/x' }, { fetch: failing }), false)
  let sent: RequestInit | undefined
  const ok = (async (_url: string, init: RequestInit) => { sent = init; return new Response('ok') }) as unknown as typeof fetch
  assert.equal(await sendAlert('Site down', 'm', { ALERT_WEBHOOK_URL: 'https://ntfy.sh/x' }, { fetch: ok }), true)
  assert.equal(sent?.method, 'POST')
})

test('the worker counts as down after about four missed heartbeats, or with none at all', () => {
  const now = 1_000_000
  assert.equal(workerCheck(String(now - 31_000), now).status, 'healthy')
  assert.equal(workerCheck(String(now - 200_000), now).status, 'unhealthy')
  assert.equal(workerCheck(null, now).status, 'unhealthy')
})
