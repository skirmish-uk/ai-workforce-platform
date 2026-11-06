import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideToolAction, AUTONOMY_STAGES, type ToolDecisionInput } from './policy'
import { getToolRiskProfile, knownToolRiskProfiles } from './risk'
import { toolRegistry } from './registry'

const base: ToolDecisionInput = {
  toolName: 'gmail__send_email',
  stage: 'limited',
  risk: 'external_communication',
  permissionLevel: 'AUTOMATIC',
  allowlisted: true,
}

test('every registered tool has an explicit risk profile (no silent "unknown" defaults)', () => {
  const profiles = knownToolRiskProfiles()
  const missing = toolRegistry.all().filter((t) => !(t.toolName in profiles)).map((t) => t.toolName)
  assert.deepEqual(missing, [])
})

test('unknown tools are classified as irreversible, non-idempotent writes', () => {
  assert.deepEqual(
    { risk: getToolRiskProfile('acme__wire_money').risk, idempotent: getToolRiskProfile('acme__wire_money').idempotent },
    { risk: 'write_irreversible', idempotent: false }
  )
})

test('PROHIBITED, kill switch and out-of-allowlist are denied in every stage, even when pre-approved', () => {
  for (const stage of AUTONOMY_STAGES) {
    assert.equal(decideToolAction({ ...base, stage, permissionLevel: 'PROHIBITED', preApproved: true }).kind, 'deny')
    assert.equal(decideToolAction({ ...base, stage, disabled: true, preApproved: true }).kind, 'deny')
    assert.equal(decideToolAction({ ...base, stage, allowlisted: false, preApproved: true }).kind, 'deny')
  }
})

test('reads follow AgentPermission in every stage', () => {
  for (const stage of AUTONOMY_STAGES) {
    assert.equal(decideToolAction({ ...base, stage, risk: 'read', permissionLevel: 'AUTOMATIC' }).kind, 'execute')
    assert.equal(decideToolAction({ ...base, stage, risk: 'read', permissionLevel: 'CUSTOMER_APPROVAL' }).kind, 'approval')
  }
})

test('observe denies writes; recommend proposes; draft only executes draft-class tools', () => {
  assert.equal(decideToolAction({ ...base, stage: 'observe', risk: 'write_reversible' }).kind, 'deny')
  assert.equal(decideToolAction({ ...base, stage: 'recommend', risk: 'write_reversible' }).kind, 'propose')
  assert.equal(decideToolAction({ ...base, stage: 'recommend', risk: 'draft' }).kind, 'propose')
  assert.equal(decideToolAction({ ...base, stage: 'draft', risk: 'draft' }).kind, 'execute')
  assert.equal(decideToolAction({ ...base, stage: 'draft', risk: 'external_communication' }).kind, 'propose')
})

test('approval_gated forces approval for every write even when AgentPermission says AUTOMATIC', () => {
  for (const risk of ['draft', 'write_reversible', 'external_communication', 'destructive'] as const) {
    const d = decideToolAction({ ...base, stage: 'approval_gated', risk, permissionLevel: 'AUTOMATIC' })
    assert.equal(d.kind, 'approval', risk)
    assert.equal(d.level, 'CUSTOMER_APPROVAL')
  }
  // An explicit OPERATOR_APPROVAL row is never weakened to CUSTOMER_APPROVAL.
  assert.equal(
    decideToolAction({ ...base, stage: 'approval_gated', risk: 'write_reversible', permissionLevel: 'OPERATOR_APPROVAL' }).level,
    'OPERATOR_APPROVAL'
  )
})

test('limited autonomy auto-runs explicitly AUTOMATIC low-risk writes but still gates high-risk ones', () => {
  assert.equal(decideToolAction({ ...base, risk: 'write_reversible', permissionLevel: 'AUTOMATIC' }).kind, 'execute')
  assert.equal(decideToolAction({ ...base, risk: 'external_communication', permissionLevel: 'AUTOMATIC' }).kind, 'approval')
  assert.equal(decideToolAction({ ...base, risk: 'destructive', permissionLevel: 'AUTOMATIC' }).kind, 'approval')
  assert.equal(decideToolAction({ ...base, risk: 'write_irreversible', permissionLevel: 'NOTIFY' }).kind, 'approval')
})

test('expanded autonomy honours AgentPermission exactly', () => {
  assert.equal(decideToolAction({ ...base, stage: 'expanded', permissionLevel: 'AUTOMATIC' }).kind, 'execute')
  assert.equal(decideToolAction({ ...base, stage: 'expanded', permissionLevel: 'CUSTOMER_APPROVAL' }).kind, 'approval')
})

test('pre-approval converts an approval decision into execution, but never a proposal', () => {
  assert.equal(decideToolAction({ ...base, stage: 'approval_gated', preApproved: true }).kind, 'execute')
  assert.equal(decideToolAction({ ...base, stage: 'recommend', preApproved: true }).kind, 'propose')
  assert.equal(decideToolAction({ ...base, stage: 'observe', preApproved: true }).kind, 'deny')
})

test('legacy dotted skill tool names still resolve', () => {
  const resolved = toolRegistry.resolve(['gmail.send_email', 'hubspot-crm.search_contacts'])
  assert.deepEqual(
    resolved.map((t) => t.toolName),
    ['gmail__send_email', 'hubspot-crm__search_contacts']
  )
})
