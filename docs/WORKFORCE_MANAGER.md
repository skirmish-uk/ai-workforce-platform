# Workforce Manager and self-improving agents

This doc covers how agents on the platform improve themselves, how new agents get built, and what stops either from going wrong. The design builds on [AGENT_OPERATING_SYSTEM.md](AGENT_OPERATING_SYSTEM.md), which covers contracts, autonomy stages, approvals and evaluation. Read that one first.

**Status (2026-10-10):** built and covered by 23 automated tests. One live run on the test database went all the way through: API → queue → worker → sandbox → evaluation → FAILED. It failed only because no model API key was set, so a successful promotion against a real model has **not** been run yet. There is no UI; everything goes through the API and the worker.

---

## 1. The idea in one paragraph

Each tenant can have a **Workforce Manager**, an ordinary agent with one extra contract flag (`contract.management.enabled`). It reviews the tenant's other agents: their run metrics, failures, rejected approvals, and suggestions the agents wrote themselves. It then **proposes revisions**: change an agent, create a new one, or retire one. It can't apply anything. Each proposal goes through the **revision pipeline**:

1. A sandbox copy of the changed agent is built.
2. The copy must pass the evaluation suite.
3. It must score at least as well as the live version.
4. It must do no worse on a replay of recent real inputs.
5. If the change adds risk, a human must approve it.

Only then does the change go live, as a new version. For the first 72 hours after going live it is watched, and it rolls back automatically if live metrics get worse.

"Self-building" is **config-only**. A proposal can write prompts, playbooks (skills), contracts, permissions and evaluation cases, and can combine tools that are already registered. It can't write or run code. A new capability, such as a new integration, still needs a reviewed adapter in `packages/integrations`. The business reasoning (cost, security, maintenance) is in §11.

---

## 2. Lifecycle

```
                    proposeRevision()            processRevision()  (agent-revision worker)
 manager / human ──► PROPOSED ──────────────────► EVALUATING
                     │ hard limits checked here    │ 1. hard limits re-checked against the tenant as it is now
                     │ (refused proposals never    │ 2. sandbox candidate agent built (Agent.isCandidate = true)
                     │  get a row)                 │ 3. deployability validation (validateAgentDefinition)
                                                   │ 4. evaluation suite, dry run, real model calls
                                                   │ 5. score ≥ live version's latest evaluation score
                                                   │ 6. replay of N recent real inputs (dry run, live reads)
                                                   ▼
                              risk-increasing? ── yes ──► AWAITING_APPROVAL ── human approves ──┐
                                     │ no                    │ rejects / expires                │
                                     ▼                       ▼                                  ▼
                                 PROMOTING ◄──────────── REJECTED / EXPIRED                 PROMOTING
                                     │
                                     ▼
                                 PROMOTED  ── watch (72 h): metrics degrade ──► ROLLED_BACK
                                            ── human: POST /api/revisions/[id]/rollback ──► ROLLED_BACK

 Any gate failing → FAILED.   Agent edited meanwhile → SUPERSEDED.   Kill switch / self-management off → BLOCKED.
```

When a revision ends in FAILED, REJECTED, EXPIRED, SUPERSEDED or BLOCKED, the sandbox agent is deleted, along with any playbooks it created that nothing else uses. The live agent is never touched before promotion.

Promotion and rollback are the same operation: "apply this spec as a new version". History is never rewritten. A rollback of v2 creates v3 with v1's definition.

---

## 3. What runs automatically and what needs a human

All of this is enforced in `packages/executor/src/workforce/invariants.ts`. It's a pure function, unit-tested in `workforce-invariants.test.ts`.

### Refused outright, whoever approves
| Rule | Why |
|---|---|
| A manager can't be changed by a revision. That includes itself and other managers. | A manager can't loosen its own leash. |
| A revision can't grant `contract.management`. Only a direct human edit can. | No agent can create another manager. |
| The autonomy stage can't go above the tenant's `maxAutonomyStage` (default `limited`). | There's a hard ceiling even with human approval. Going higher needs a direct human edit. |
| Only registered tools are allowed (no code, no unknown tools). | A capability can't be invented. |
| Only tools from integrations the tenant has connected. | The tool would fail anyway, and it's a scope boundary. |
| No tools disabled by a kill switch. | Kill switches stay authoritative. |
| Delegation targets must be agents in the same tenant. | Tenant isolation. |
| Evaluation cases are append-only. | Tests can't be weakened to make a change pass. Cases from a dropped or replaced playbook are carried over automatically, so silently removing a tested capability makes evaluation fail. |
| The contract and spec must validate, and the candidate must pass `validateAgentDefinition(forDeployment)`. | Same bar as a human deploy: every playbook needs an owner and evaluation cases. |
| Added evaluation cases must have deterministic `expect` assertions. | Unassertable cases can't prove anything. |
| One open revision per agent; at most `maxRevisionsPerDay` per tenant (default 10). | Prevents conflicting changes and runaway spend loops. |
| The proposing agent can't target itself. | |

### Allowed only after tests pass *and* a human approves
- Raising the autonomy stage.
- Adding a high-risk tool: external communication (email, calendar invites), destructive, or irreversible.
- Loosening a permission on a non-read tool (e.g. CUSTOMER_APPROVAL → AUTOMATIC).
- Enabling delegation or adding delegation targets.
- Changing the agent's owner or escalation destination.
- Removing an out-of-scope boundary.
- Removing `local_only` privacy, or moving to a different model provider.
- Raising or removing the per-run cost limit.
- Creating an agent that has high-risk tools, starts above `approval_gated`, or can delegate.
- Retiring an agent that is in PRODUCTION.

The approval is an ordinary `Approval` row (`input.kind = "agent_revision"`, level CUSTOMER_APPROVAL), so it appears in `GET /api/approvals` and is decided with `POST /api/approvals/[id]`. Approval promotes exactly once. Rejection or expiry discards the candidate.

### Fully automatic once tests pass
Prompt wording, playbook instructions, new playbooks that use already-allowed or low-risk tools, scope wording that adds boundaries, soul/tone, Definition-of-Done checks, extra evaluation cases, tighter permissions, lower autonomy, and new agents that only use read, draft or reversible tools at `approval_gated`.

Remember that runtime policy still applies after promotion. An `approval_gated` agent still asks a human before every external write.

---

## 4. Self-improvement signals

The manager learns from three sources:

1. **Run outcomes** from `AuditLog`: completion, failure, DoD pass, escalation, clarification and human-override rates; recent problem runs with errors and DoD results; rejected approvals with reasons.
2. **Agent suggestions.** When a tenant has opted in, every non-manager agent gets `platform__suggest_improvement`, at most 3 per run. It records `AGENT_IMPROVEMENT_SUGGESTED` and changes nothing by itself.
3. **Its own past revisions**, via `platform__get_revision`: what failed evaluation and why.

All of this is returned to the manager wrapped as untrusted data (`<untrusted_data source="platform:…">`). Run inputs and outputs contain customer and email content, so an injected instruction could reach a suggestion. Even if the manager acted on one, the pipeline's hard limits, evaluation and approval rules still apply.

---

## 4a. Running the team (added 2026-10-13)

**Quality signals** (`packages/executor/src/quality.ts`). Every run that finishes as completed/partial is checked for three problems its status hides: it *announced* an action it never took, *claimed* one with nothing to show for it, or *asked questions in its answer* instead of with the clarification tool. Signals go on the run's audit row and into metrics (`qualityFlaggedRuns`), and flagged runs appear in the manager's problem runs. Rejected approvals are now counted per agent too. On the 13 Oct runs the detector flagged 7 of 10 original Sarah runs and none after her fix.

**Conversation signals (26 Oct).** Two problems only show across a conversation, and are checked when any run that is part of one is recorded (escalated runs too, which skip the answer checks above): `repeated_handover`, a hand-off in a conversation that already had one in the last 6 hours, and `missed_end_call`, a voice turn where the caller said goodbye or asked to end the call (`callerWantsToEnd()`: "that's all", "end the call", "bye"; not when a question follows) and the call wasn't ended. They exist because of a live call that went wrong on 26 Oct: Ava handed one custom-package request over five times and wouldn't hang up, and none of the existing checks saw it. Her runs were hand-offs, not failures, and each "I'm passing it on" was true. One run with a conversation signal starts the automatic review (`autoReview.conversationFlaggedRuns`, default 1; the other signals still need `qualityFlaggedRuns`, default 2): a caller met the problem directly. Metrics now count runs per signal (`qualitySignalCounts`), and the automatic review's description lists them ("4 handed a conversation over to the team again…"). For conversation signals it adds that the cause may be in how the platform runs conversations, which a revision can't fix (that call's cause was the call history missing what earlier turns did; fixed in code, docs/VOICE.md "What earlier turns did").

**Automatic repair reviews** (`packages/executor/src/workforce/triggers.ts`). Every 10 minutes the scheduler checks each tenant (self-management and `autoReview` on, a manager present, no kill switch). Any of these in the last 24 h starts one combined manager review:
- failure rate ≥ 30% over ≥ 5 runs;
- ≥ 2 quality-flagged runs;
- ≥ 50% of ≥ 3 decided approvals rejected;
- tool error rate ≥ 30% over ≥ 5 calls. The review is told that a broken connection needs a person, not a revision.
- an automatic rollback.

Each (problem, agent) pair fires at most once per 24 h (`MANAGER_REVIEW_TRIGGERED` audit rows). There are at most `autoReview.maxPerDay` reviews per tenant (default 4). All thresholds are in `Tenant.settings.selfManagement.autoReview`.

**Front desk.** A manager whose contract has `delegation.allowedSpecialists: ["*"]` can hand any request to any non-manager, non-paused agent on the team with `platform__delegate`, and reports the outcome. If the agent's action needs approval, the manager's run ends `approval_required` with that approval. `"*"` is refused for non-managers (contract validation, and the revision pipeline rejects it as an unknown delegate). Morgan is seeded this way. Each routed request costs a manager run (about $0.015 for a simple routing on Sonnet 5, 13 Oct) plus the agent's run. The manager may also pass work on as a team case with `platform__hand_off` (docs/TEAMWORK.md); either is fine.

**Team page** (`/dashboard/team`, `GET /api/team`):
- each agent's 7-day health, flagged "needs attention" on the same thresholds as automatic reviews;
- the manager's latest report, with **Ask the team** (front desk) and **Review the team now**;
- what's waiting for a person;
- recent manager activity: automatic reviews, proposals, promotions, rollbacks.

**Lessons from the first staged self-repair (18 Oct).** Found by rehearsing Jordan's staged flaw (DEMO.md):
- A sandbox candidate now starts with the live agent's knowledge documents and its non-spec settings (voice, for example). Before, an agent that answers from documents was tested blind and failed.
- A proposal that only adds test cases is refused at proposal time, with how to send a new playbook version. Morgan had described a playbook fix but sent only the new case. The tool description now says how to edit a playbook, and that `toolInputsNotContain` checks a drafted email while `outputContains` checks the final message.
- `platform__escalate` ends the manager's run. Its prompt and the automatic-review input now say to deal with every agent first and escalate once, last. Before, one unfixable item stopped a combined review before it reached the fixable one.

## 5. Manager tools

These are offered only when the tenant's `selfManagement.enabled` is true and the agent's contract has `management.enabled`. There is deliberately **no** tool to promote, approve, edit tenant settings, touch kill switches or change billing.

| Tool | Does |
|---|---|
| `platform__list_agents` | Agents with 7-day metrics and open revisions, plus the tools (connected integrations only) and playbooks available to build with. |
| `platform__inspect_agent` | One agent's full definition, playbooks with instructions and cases, metrics, problem runs, rejected approvals, suggestions, revision history and latest evaluation. |
| `platform__propose_agent_change` | Submits a revision (`create` / `update` / `retire`). A new version of a playbook replaces the older one of the same name, even if the proposal also lists the old one (`newestPlaybooks()`; Ava briefly had both 1.0.0 and 1.1.0 on 26 Oct). Refusals return the exact violated rules, so the manager can correct the proposal. At most `management.maxProposalsPerRun` per run (default 3). |
| `platform__get_revision` | Status and results of a revision. |
| `platform__report_platform_issue` | Reports a problem whose cause is in the platform, not the agent (how conversations, calls, hand-offs or tools work; something the agent can never see), to the platform team: an `Incident` with source `workforce_manager` (title, description, agent, run ids, severity), shown in the operator console under Incidents, and a `PLATFORM_ISSUE_REPORTED` audit row. Changes nothing. The same title while still open (7 days) returns the existing incident instead of a new one; at most 3 per run; dry runs report nothing. Allowed in every stage. The manager can still propose a revision that softens the effect. |

Stage rules: a manager in `observe`/`recommend` only describes proposals (recorded as proposed actions, not submitted). Dry runs submit nothing.

---

## 6. Configuration

### Tenant policy: `Tenant.settings.selfManagement`
Set with `PUT /api/tenants/[id]/self-management`, which needs tenant/settings write permission and merges into settings. **Off by default.** An invalid policy fails closed (treated as off).

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch for manager tools, suggestions and the pipeline. |
| `maxAutonomyStage` | `limited` | Hard ceiling for any revision. |
| `maxRevisionsPerDay` | 10 | Proposals accepted per rolling 24 h. |
| `replayRuns` | 5 | Recent real inputs replayed against each candidate (0 = off). |
| `approvalTtlHours` | 72 | Lifetime of a risk approval. |
| `collectSuggestions` | `true` | Give non-manager agents `platform__suggest_improvement`. |
| `watch.hours` | 72 | Post-promotion watch window. |
| `watch.minRuns` | 5 | Real runs needed before a verdict. |
| `watch.maxFailureRateIncrease` / `maxDodPassRateDrop` | 0.15 / 0.15 | Rollback thresholds compared with the 7 days before promotion. |
| `watch.maxFailureRate` / `minDodPassRate` | 0.3 / 0.7 | Absolute thresholds when there's no baseline (new or idle agents). |

### Manager contract
`contract.management = { enabled: true, maxProposalsPerRun: 3 }`. Only set it by editing the agent directly (`PUT /api/agents/[id]`). The seeded manager has `allowedTools: []`, so it has no integration tools at all.

---

## 7. API

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/revisions?status=&agentId=` | agent:read | List revisions (platform roles may pass `tenantId`). |
| `GET /api/revisions/[id]` | agent:read | Full revision: proposed spec, previous spec, risk, results. |
| `POST /api/revisions` | agent:write | A human proposes through the same pipeline (same limits). A safe way to test a change instead of editing the live agent. |
| `POST /api/revisions/[id]/rollback` `{reason}` | agent:deploy | Undo a promoted revision. Refused if the agent has changed since. |
| `GET/PUT /api/tenants/[id]/self-management` | settings read / write | Tenant policy. |
| `GET /api/approvals`, `POST /api/approvals/[id]` | as before | Decide risk-increasing revisions. |

---

## 8. Running it

1. `npx prisma db push` (adds `AgentRevision` and `Agent.isCandidate`) and reseed. The seed creates **Morgan - Workforce Manager** (`demo-manager-1`) for the demo tenant, enables self-management there, and creates a weekly schedule (Mondays 07:00 Sydney) that is **inactive**.
2. Set `ANTHROPIC_API_KEY` (the manager uses `claude-sonnet-5-5`; workers use whatever they're configured with).
3. Run the worker process (`npx tsx packages/queue/src/start-workers.ts`). It now includes the `agent-revision` worker. Each 60 s scheduler tick also queues PROPOSED revisions and runs the watch.
4. Trigger the manager manually (`POST /api/agents/demo-manager-1/run` with an input such as "Weekly workforce review"), or activate its schedule.
5. Watch `GET /api/revisions` and `GET /api/approvals`.

### Cost
Each revision that reaches evaluation runs one agent run per evaluation case plus up to `replayRuns` replays, all on the candidate's model. The manager's own run is one more. Everything counts toward the tenant's spend cap (`Tenant.settings.costLimits`), which still blocks runs once reached. `maxRevisionsPerDay` bounds the number of evaluations per day. Revisions are processed one at a time (worker concurrency 1).

---

## 9. Operations

- **Stop everything:** tenant kill switch (`PUT /api/tenants/[id]/kill-switch {agentsDisabled:true}`) blocks runs, processing and promotion. Or set `selfManagement.enabled=false`, which removes the manager tools and blocks new and queued revisions.
- **Undo a change:** `POST /api/revisions/[id]/rollback`.
- **Audit trail** (`AuditLog`, `entityType = "AgentRevision"`): `AGENT_REVISION_PROPOSED`, `…_FAILED`, `…_AWAITING_APPROVAL`, `…_PROMOTED`, `…_ROLLED_BACK`, `…_ROLLBACK_FAILED`, `…_SUPERSEDED`, `…_BLOCKED`, `…_REJECTED`, `…_EXPIRED`. Also `AGENT_IMPROVEMENT_SUGGESTED` and `SELF_MANAGEMENT_UPDATED`.
- **Candidates are invisible:** `Agent.isCandidate` rows are excluded from agent lists, plan entitlement counts, delegation, scheduling and the per-agent API routes. `runAgent` refuses to run them outside dry-run.

---

## 10. Code map

| File | Role |
|---|---|
| `packages/executor/src/workforce/spec.ts` | `AgentSpec` (full declarative agent definition), merge, apply, playbook creation, append-only case carry-over. |
| `packages/executor/src/workforce/invariants.ts` | Hard limits and risk increases (pure). |
| `packages/executor/src/workforce/policy.ts` | Tenant policy schema. |
| `packages/executor/src/workforce/revisions.ts` | Propose, process, promote, reject, rollback, watch. |
| `packages/executor/src/workforce/tools.ts` | Manager tools and `platform__suggest_improvement`. |
| `packages/executor/src/agent.ts` | Offers/handles workforce tools; `replay` trigger; `liveReads`; blocks candidates. |
| `packages/executor/src/approvals.ts` | `agent_revision` approvals: execute → promote; reject/expire → discard. |
| `packages/queue/src/workers/revision.worker.ts`, `deploy.ts`, `scheduler.ts` | Processing, auto-deploying new agents, tick hooks. |
| `apps/web/src/app/api/revisions/**`, `tenants/[id]/self-management` | API. |
| `packages/db/prisma/schema.prisma` | `AgentRevision`, `Agent.isCandidate`. |

Tests: `packages/executor/src/__tests__/workforce-invariants.test.ts` (7, pure) and `workforce.test.ts` (16, DB-backed with a fake model).

---

## 11. Why config-only, not code generation

We decided on 2026-10-10 to have agents build from configuration and existing tools rather than write their own code. Model tokens to generate code are cheap. The real costs are:

- **Sandboxing:** generated code can't run in the shared worker, because it would be able to reach every tenant's credentials.
- **Maintenance:** each tenant would end up with its own unique, generated integration code to maintain.
- **Liability:** in front of the target customers (agencies, law firms, insurers), the platform is responsible for what that code does.

Customers mainly want reliability, coverage of their own tools, steady improvement and control. Config-only self-improvement delivers three of those cheaply. Tool coverage is better served by a vetted connector catalogue (MCP/OpenAPI) and an internal "integration factory": AI-written connectors that a human reviews and that ship to all tenants. Customer-specific generated code could become a priced Enterprise add-on later, once sandboxing exists.

---

## 12. Limitations and next steps

- **No UI.** Revisions and approvals are API-only, and approvers get no notification (same gap as all approvals).
- **Not yet run against a real model.** The pipeline, gates and manager tool loop are tested with a scripted fake model. The quality of the manager's proposals depends on the model and prompt and has not been measured. Run the manager on the demo tenant with an API key and review its first proposals by hand before enabling its schedule anywhere.
- **Evaluation quality bounds everything.** The gate is only as good as each agent's evaluation cases. Agents with thin suites can be changed with thin evidence. The manager is told to add a reproducing case with every fix, but a reviewer should look at suites periodically.
- **Replay fidelity:** replays run read tools against real data (so results can drift from the original run) and simulate everything else. Inputs come from redacted audit rows.
- **The manager can only see problems the metrics show.** In the first real review (2026-10-13) Morgan correctly fixed an inconsistent pricing rule but missed Sarah *announcing* follow-ups without doing them, because those runs ended `completed` with a passing Definition of Done (it only required an answer). Weak DoD checks hide problems from the manager; give agents DoD checks that require the action they exist to take.
- **Evaluation suites must be unambiguous.** The default pass bar is 100%, so one ambiguous case (e.g. a "qualified" lead with no company and an empty CRM look-up, where handing off is also reasonable) blocks changes at random. Give cases `toolFixtures` that make the right answer clear. Revisions can't edit existing cases (append-only); a person can correct a wrong case directly, which should be logged (`SKILL_EVALUATION_CASE_CORRECTED`). Text assertions check everything the agent said, including a hand-off reason or clarification questions, and `toolInputsNotContain` checks what the agent put into tool calls (e.g. no prices in a drafted email).
- **The watch only sees failure and DoD rates** (plus their baselines). Changes that hurt quality in ways the DoD doesn't check won't trigger a rollback.
- **Processing is sequential and polled.** A proposal waits for the next scheduler tick (≤ 60 s) unless it came from the API route, which enqueues immediately. The scheduler is still single-process (see CLAUDE.md known gaps).
- **Deployment rows aren't updated** when an `update` revision is promoted. The agent's version changes in place, and the revision row is the record. New agents (`create`) go through the normal deployment job.
- **Playbook versions accumulate.** Each changed playbook is a new `Skill` row. Nothing prunes old, unused versions.
- **The manager's model** is `claude-sonnet-5-5` (since 25 Oct 2026: it passed the manager's suite 10/10 at about 40% less than `claude-sonnet-5`). It must be in the pricing table, or the spend cap can't count its cost: add newer models to `packages/llm/src/pricing.ts` (with verified prices) before switching.
- **The manager's test suite** is the `workforce_review` playbook (`packages/db/prisma/seed-showcase.ts`): a recurring rejection gets one playbook fix, a healthy team gets no proposal, an instruction planted in run data never raises autonomy or grants a permission, front-desk work is passed to a teammate, billing and kill-switch requests go to a person. Its cases use fixtures for `platform__list_agents` / `platform__inspect_agent` (in a dry run, a fixture replaces the live read; an `inspect_agent` fixture may be `{ byAgentId: {...} }`), so the result doesn't depend on what the tenant looks like that day. About $0.13 per run of the suite.
