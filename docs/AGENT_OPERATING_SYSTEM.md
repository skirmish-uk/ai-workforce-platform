# Agent Operating System — implementation notes

How the "AI Agent Operating System" brief (`claude_ai_agent_implementation_brief.md`) is
implemented in this repository, what is deliberately not implemented, and how to operate it.
Written 2026-10-10. Everything marked **Done** has automated tests (see "Tests") unless noted.

---

## 1. What existed before (baseline, 2026-10-10)

- `packages/executor/src/agent.ts` — a ReAct loop: LLM → tool calls → `AgentPermission` check → adapter.
  No run ID, no explicit states, only a max-iteration bound, no Definition of Done, no idempotency,
  no cancellation, tool output fed back raw, audit rows unredacted.
- `packages/tools` — tool registry + `AgentPermission` levels (AUTOMATIC/NOTIFY/CUSTOMER_APPROVAL/
  OPERATOR_APPROVAL/PROHIBITED; missing row = CUSTOMER_APPROVAL).
- `packages/llm` — Anthropic/OpenAI/Ollama behind one interface; no fallback.
- `packages/queue` — BullMQ workers + a 60 s cron poll; no missed-run policy, no backpressure.
- Approvals were created but **nothing could decide or resume them**; ad-hoc/scheduled runs could not
  persist approvals at all (`Approval.workflowRunId` was required).
- **Security bugs found:** `GET /api/agents/[id]/run?jobId=` returned any tenant's job result to any
  logged-in user; `PUT /api/agents/[id]` let a customer set `status: PRODUCTION`, bypassing deploy
  validation.
- Baseline checks: build ✅, lint ✅ (warnings only), type-check ✅ (after overriding a `rootDir`
  config artefact), **tests: none existed** — every package's `jest` exited 1 with "No tests found".

## 2. Where each concept lives

| Brief concept | Implementation |
|---|---|
| Agent contract (§3) | `Agent.config.contract`, schema `packages/executor/src/contract.ts` (`agentContractSchema`, strict). No new table. |
| IDENTITY.md | `Agent.name/role/mission/systemPrompt` + contract `scope`, `definitionOfDone`, `inputs/outputs`, `allowedTools`, `autonomyStage`, `owner`, `escalation`. **Enforced** by `packages/tools/src/policy.ts`, not only described. |
| SOUL.md | `contract.soul` (tone, values, uncertainty, askWhen, escalateWhen). Rendered *below* identity and platform policy. |
| USER.md | `Tenant.settings.businessContext` (`packages/executor/src/business-context.ts`), shared by all agents in a tenant; includes explicit `unknowns`. |
| Playbooks (§5) | Existing `Skill` rows (versioned, semver). Playbook fields in `Skill.metadata` (`owner`, `lastReviewedAt`, `trigger`, `preconditions`, `sourceOfTruth`, `approvalRequired`, `derivation`); deterministic cases in `Skill.evaluationCases`. |
| Run lifecycle (§7) | `runAgent()` in `packages/executor/src/agent.ts` — `AgentRun` class, phases `diagnose → assemble → act → assess`. |
| Tool policy / autonomy (§9) | `packages/tools/src/policy.ts` (`decideToolAction`), `risk.ts` (per-tool risk class + idempotency). |
| Approvals (§9) | `packages/executor/src/approvals.ts`; API `GET /api/approvals`, `POST /api/approvals/[id]`; worker `approval-execute`. |
| Untrusted content (§6) | `packages/executor/src/untrusted.ts` (`PLATFORM_POLICY`, `wrapUntrusted`, injection heuristics). |
| Redaction (§12) | `packages/domain/src/security/redact.ts`. |
| Model routing (§11) | `packages/executor/src/routing.ts`; config in `contract.model`. |
| Idempotency, kill switch, evidence gate | `packages/executor/src/safety.ts`, `tool-runner.ts`. |
| Evaluation (§13) | `packages/executor/src/evaluation.ts`; `POST/GET /api/agents/[id]/evaluations`; worker `agent-evaluation`. |
| Metrics (§13) | `packages/executor/src/metrics.ts`; `GET /api/monitoring?type=agent-runs`. |
| Delegation (§8) | `platform__delegate` built-in tool inside `agent.ts`; config `contract.delegation`. |
| Scheduling (§10) | `packages/queue/src/scheduler.ts`; policy in `contract.schedule`. |

## 3. The agent contract

Minimal valid contract (everything else has a conservative default):

```json
{
  "contract": {
    "rationale": "Why the agent exists — the business outcome it owns.",
    "definitionOfDone": {
      "summary": "One observable sentence.",
      "checks": [{ "type": "tool_succeeded", "tool": "hubspot-crm__update_contact" }]
    },
    "scope": { "inScope": ["..."], "outOfScope": ["..."] },
    "risk": { "classification": "medium" },
    "owner": { "name": "Sales Ops", "contact": "ops@example.com" },
    "escalation": { "destination": "ops@example.com" }
  }
}
```

Defaults: `autonomyStage: approval_gated`, `memory.mode: none`, `delegation.enabled: false`,
`limits = { maxIterations 8, maxToolCalls 20, maxWallClockMs 120000, maxRetries 2, toolTimeoutMs 30000 }`,
`approvals.ttlHours 72`, `schedule = { missedRunPolicy: skip, maxConcurrentRuns: 1 }`,
`evaluation.minPassRate 1`, `model.privacy any`.

DoD check types: `output_present`, `output_contains`, `output_not_contains`, `output_is_json`,
`output_json_fields`, `tool_succeeded`, `no_tool_errors`, `max_cost_usd`. `outputs.format: "json"`
adds a JSON check automatically. Checks evaluate **recorded tool results**, never the model's claims.

Validation (`validateAgentDefinition`): strict schema (unknown keys rejected); contradictions rejected —
delegation enabled without specialists, `privacy: local_only` with any cloud model, unknown tools in
`allowedTools`, DoD requiring a tool the allowlist forbids. With `forDeployment: true` also: contract
required, system prompt required, every enabled skill needs semver, ≥1 evaluation case, an owner, and
only registered tools. Validated at: agent create/update (400 on invalid), run start (status `blocked`),
deploy (deployment `failed` with the reasons in `Deployment.logs`).

**Legacy agents** (no contract) still run ad hoc with approval-gated defaults, but cannot be deployed.

## 4. Autonomy stages and tool decisions

Effective decision = the stricter of the tool's `AgentPermission` level and the stage ceiling.
PROHIBITED, kill-switched and out-of-allowlist tools are denied in every stage and are **not even
offered** to the model.

| Stage | read | draft (e.g. `gmail__create_draft`) | reversible write (CRM) | high risk (send email, calendar invites, delete, unknown) |
|---|---|---|---|---|
| observe | per permission | denied | denied | denied |
| recommend | per permission | proposal only | proposal only | proposal only |
| draft | per permission | per permission | proposal only | proposal only |
| approval_gated (default) | per permission | approval | approval | approval |
| limited | per permission | per permission | per permission | approval |
| expanded | per permission | per permission | per permission | per permission |

`limited`/`expanded` only take effect when a **passing Evaluation exists for the agent's current
`version`**; otherwise the run is capped to `approval_gated` (noted in the run's phase history). Any
material update via `PUT /api/agents/[id]` (prompt, mission, role, model, modelConfig, config,
skills) increments `Agent.version`, so autonomy drops back until re-evaluated.

## 5. Run lifecycle and terminal states

`runAgent(agentId, input, options)` → `RunAgentResult` with `runId` (= BullMQ job id for queued runs),
`phases[]`, exactly one terminal `status`:

| status | meaning |
|---|---|
| `completed` | final answer + every DoD check passed |
| `partial` | final answer or some tool success, but DoD not met |
| `needs_clarification` | empty input, missing `inputs.requiredFields`, or model called `platform__request_clarification` |
| `escalated` | model called `platform__escalate`, or a non-idempotent tool's outcome is unknown (timeout) |
| `approval_required` | a tool call needs a human; Approval persisted (also for ad-hoc/scheduled runs) |
| `blocked` | invalid contract, kill switch, paused/archived agent, spend cap/budget, input too long |
| `cancelled` | `DELETE /api/agents/[id]/run?jobId=` or AbortSignal |
| `failed` | iteration/tool-call/wall-clock limit, repeated identical tool failure, all models unavailable |

Bounds: iterations, tool calls, wall-clock, per-run USD budget (min of contract `maxRunCostUsd`,
remaining tenant daily/monthly cap, and parent budget for delegated runs — checked after **every**
LLM call, closing the old "spend cap only per run" gap). Identical tool failure twice → stop.
Cancellation is checked before each iteration and each tool call (never mid-call).

Every terminal state writes one AuditLog row (`AGENT_RUN_COMPLETED` / `_FAILED` / `_FINISHED` /
`_ESCALATED`, `newData.status` has the precise state) containing: run/root/parent run IDs, trigger,
agent version, stage, model used + fallback flag, tokens, cost, duration, iterations, tool call
summaries, DoD results, escalation, clarification questions, context warnings, injection signals and
the phase history (a plan summary, not chain-of-thought). All audit payloads are redacted.

## 6. Tools: validation, idempotency, untrusted output

- Arguments are validated against the adapter's Zod schema **before** policy/approval, so approvers
  never see malformed calls.
- Non-idempotent tools (`risk.ts`) get an idempotency key (tenant + agent + tool + canonical args). An
  identical successful call in the last 24 h is suppressed (`duplicate_suppressed`). A call that
  **timed out** is recorded as unknown outcome; the run escalates and an identical later call is
  blocked until a human verifies — never blindly retried.
- Tool results, knowledge excerpts and specialist outputs are redacted and wrapped in
  `<untrusted_data source=…>` (delimiter-spoofing neutralised, heuristic injection flags recorded).
  This is mitigation only; the security boundary is the application-side policy (tests prove an
  injected "send the keys" instruction still ends at an approval gate).
- Dry-run (`options.dryRun`, used by evaluations) never touches adapters and never persists approvals.

## 7. Approvals

1. Run hits an approval → `Approval` row: `status PENDING`, `expiresAt` (contract TTL), `agentId`,
   `runId`, `input = { kind: "tool_call", toolName, arguments, summary }`. The summary (action, target,
   risk class, side effects, redacted material, model rationale, policy reason, evidence) is what
   `GET /api/approvals?status=PENDING` returns; raw arguments are never returned by the API.
2. `POST /api/approvals/[id] {"decision":"approve"|"reject","reason"}` — tenant check, role vs level
   (`canApprove`: CUSTOMER_ADMIN ≥ CUSTOMER_APPROVAL, platform roles ≥ OPERATOR_APPROVAL), not
   expired, still pending (conditional update; a second decision gets 409).
3. Approve → `approval-execute` job: APPROVED→EXECUTING claim (exactly once), **policy re-checked at
   execution time** (kill switch, paused agent, PROHIBITED), executes exactly the stored arguments,
   records `EXECUTED`/`EXECUTION_FAILED`, then resumes the WorkflowRun (if any) from its checkpoint.
4. Reject → workflow `CANCELLED`. Expiry → `EXPIRED` (swept every scheduler tick), workflow `FAILED`.

Workflow resume: completed leaf steps are checkpointed in `WorkflowRun.output.steps` and skipped; the
paused agent step re-runs with a platform note describing the executed approved action (and the
idempotency guard suppresses a repeat). Duplicate/late workflow jobs on finished runs are no-ops.

## 8. Evaluation and promotion

- Case shape (`Skill.evaluationCases[]`): `{ name, category, input, expect: { status, toolsRequested,
  toolsNotExecuted, outputContains, outputNotContains, dodPassed }, toolFixtures }`. Categories:
  normal, edge, ambiguous, missing_input, injection, tool_failure, duplicate, high_risk, regression.
  Cases without `expect` (old `expected` labels) are recorded as unassertable, never as passes; a run
  that ends failed/blocked/cancelled never passes a case unless it expects that status.
- `POST /api/agents/[id]/evaluations` (role with `agent:deploy`) queues the suite. Runs in dry-run at
  the **configured** stage (so limited/expanded behaviour can be evidenced without side effects). It
  makes **real model calls and costs money**. Result: `Evaluation { agentVersion, score, passed }`.
- `GET /api/agents/[id]/evaluations` shows history plus deploy-readiness errors/warnings.
- Model-based quality grading is **not** implemented; all assertions are deterministic. Add human
  review of transcripts (`AuditLog`) for quality judgements.

## 9. Scheduling

Cron + timezone on `Schedule`; per-agent `contract.schedule`. Missed fires (detected from
`lastRunAt`) are dropped (`skip`, default) or run once (`run_once`). `maxConcurrentRuns` gives
backpressure. PAUSED/ARCHIVED agents and invalid contracts are not dispatched. Job IDs are
deterministic per fire minute, so repeated polls — or a second scheduler instance while BullMQ retains
the job — do not double-dispatch. Scheduled runs go through the same policy/approval path, and their
approvals are now persisted. Cadence is whatever the Schedule row says; no default frequency added.

## 10. Model routing

`Agent.modelProvider/modelName` = primary. `contract.model.fallbacks[]` used **only** when a provider
is unavailable (no key, 429/5xx/529, network) after `maxRetries` exponential-backoff retries; a 400/
404/422 is thrown, not masked. `privacy: local_only` removes every non-Ollama model, including
fallbacks. `contract.model.tiers.{simple,standard,complex}` lets a caller request a tier
(`runAgent(..., { tier })`). Per-run model, attempts, tokens, cost and fallback use are audited.
Model IDs/prices are configuration (`packages/llm/src/pricing.ts`) — no model is hard-coded in logic.

## 11. Delegation (manager → specialists)

> Not to be confused with the **Workforce Manager** (`docs/WORKFORCE_MANAGER.md`), which improves
> and creates agents through the revision pipeline rather than delegating tasks at run time.

Enabled per agent: `contract.delegation = { enabled, allowedSpecialists[], maxDepth (≤3), maxChildren }`.
The manager gets `platform__delegate`; only listed, same-tenant, non-paused agents are offered. Each
child runs under its **own** contract/stage (a manager cannot lend authority), shares the parent's
remaining budget, and records `parentRunId`/`rootRunId`. Cycles, depth, fan-out and budget are
enforced. A child result is handed back (as untrusted data) only if it `completed` **and** its DoD
passed; a child needing approval pauses the parent with the child's approval. Children run
sequentially in-process (no parallel fan-out).

## 12. Operations

**Run**
```bash
docker compose -f compose.yml up -d postgres redis
cd packages/db && npx prisma db push          # adds Approval.status/expiresAt/agentId/runId, Evaluation.agentVersion; relaxes Approval.workflowRunId
npx tsx prisma/seed.ts                        # applies the demo agent contract + playbook metadata (overwrites demo agent config/skill evals)
./start-dev.sh start
npx tsx packages/queue/src/start-workers.ts   # now also runs approval-execute and agent-evaluation workers
```

**Monitor** — `GET /api/monitoring?type=agent-runs&days=7[&agentId=…]` (completion/failure/DoD/
escalation/approval/clarification/human-override rates, latency avg/p95, cost per successful run,
tool error rate, denials, proposals, duplicates, unknown outcomes, injection-flagged runs);
`AuditLog` for per-run traces; existing `/api/health` and Watchdog alerts.

**Disable / kill switch** (no deploy needed, effective on the next run/tool call)
- One agent: `PUT /api/agents/[id] {"status":"PAUSED"}`.
- One tenant: `PUT /api/tenants/[id]/kill-switch {"agentsDisabled":true,"reason":"…"}`; revoke tools
  with `{"disabledTools":["gmail__send_email"]}`. Merges into settings; audited.
- Everything: set `AGENTS_DISABLED=true` (and/or `DISABLED_TOOLS=…`) in the worker env and restart it.
- Approved-but-unexecuted actions also respect all three.

**Roll back**
- Agent behaviour: deployment rollback (`POST /api/agents/[id]/deploy/[deploymentId]`, unchanged), or
  set `contract.autonomyStage` lower (takes effect immediately; version bump re-requires evaluation
  for higher stages).
- Code: revert this change set; the schema change is additive except `Approval.workflowRunId` becoming
  nullable. To restore the old schema, first delete/repair approvals with `workflowRunId IS NULL`.

**Rollout plan**
1. Ship with every agent at `approval_gated` (seed default; legacy agents behave the same).
2. Write `expect`-based cases per playbook covering the §13 categories; run the evaluation.
3. Pilot one agent/tenant; review `agent-runs` metrics, approvals and rejections (override rate).
4. Owner approves the evidence → set `autonomyStage: limited` (new version) → re-evaluate → deploy.
5. Re-evaluate after any material change (enforced by the version pin).

## 13. Requirements checklist

| Brief requirement | Status | Where / tests |
|---|---|---|
| §1/§3 contract: ID, version, status, mission, why, DoD, I/O, scope in/out, tools, context refs, playbooks, model + fallback policy, memory policy, triggers/concurrency, risk + approvals, retry/timeout/escalation, eval thresholds, logging, owner | **Done** (context refs = `businessContext` + knowledge sources; logging is platform-wide, not per-contract) | `contract.ts`; `contract.test.ts` |
| §3 validate at startup/deploy, fail safe | **Done** (run start, API create/update, deploy) | `contract.test.ts`, `agent.test.ts` "invalid contract" |
| §2 R-rule assessment | **Partial** — recorded in `contract.taskAssessment` (optional); not enforced | — |
| §4 SOUL/IDENTITY/USER separation; identity enforced by permissions | **Done** | `context.ts`, `policy.ts`; `agent.test.ts` |
| §5 versioned playbooks with owner/review date/evals | **Done** (Skill + metadata; deploy requires owner + cases). Historical-email learning **not implemented** (needs authorised integration + human review) | `contract.test.ts` |
| §6 active/reference/persistent/execution/tools separation | **Partial** — persistent memory **not implemented** (`memory.mode` only accepts `none`) | — |
| §6 tenant ACL during retrieval, provenance, freshness, untrusted data, injection defence, redaction | **Done** | `agent.test.ts` knowledge + injection tests, `units.test.ts` |
| §6 detect missing/conflicting/stale context | **Partial** — missing business context and stale docs are flagged in the run; conflicting-source detection not implemented | `agent.test.ts` |
| §7 task ID, explicit states, DAAA phases, bounds, backoff, no blind retry, cancellation, explicit terminal states | **Done** | `agent.test.ts` loop/cancel/idempotency tests |
| §7 resume from checkpoints | **Done** for workflows; a single agent run is not resumable mid-loop (it re-runs with a note) | `approvals-workflow.test.ts` |
| §7 verify side effects | **Partial** — DoD checks recorded tool results; no read-back of external systems | — |
| §8 manager/specialists, limits, cycles, validation, traceability | **Done** (sequential only) | `agent.test.ts` delegation |
| §9 staged autonomy per agent/tool/risk; evidence-gated promotion; regression on change | **Done** | `policy.test.ts`, `agent.test.ts`, `approvals-workflow.test.ts` |
| §9 approval content, single-action scope, kill switch, revoke tools | **Done** | `approvals-workflow.test.ts`, `units.test.ts` |
| §10 cadence/tz, missed-run, locks/duplicates, backpressure, pause, safe when deps down | **Done**; dead-letter = BullMQ failed set + failed-run audit/alerts (no separate DLQ) | `scheduler.test.ts` |
| §11 configurable routing, tracking, controlled fallback, privacy, budgets | **Done**; budget **alerts** rely on existing alert rules (no new spend alert) | `units.test.ts`, `agent.test.ts` |
| §11 evaluate model changes on same test set | **Done** via version pin (model change = new version = re-evaluation) | — |
| §12 tenant isolation, authn/z on management APIs, audit, safe errors, redaction | **Done** for touched routes; 2 pre-existing isolation bugs fixed | smoke test (below) |
| §12 secret storage/rotation | **Done (2026-10-13)**: credentials are encrypted at rest with AES-256-GCM bound to the tenant; rotation via `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` + `scripts/encrypt-credentials.ts --apply`; API responses and audit rows never include them. Still to do for production: keep the key in a KMS/secret manager rather than `.env`. | `packages/tools/src/credentials.ts` |
| §12 no unrestricted shell/fs/browser/db access | **N/A** — no such tools exist; only the 4 registered adapters | `policy.test.ts` (every tool classified) |
| §13 per-run trace + dashboards metrics | **Done** (API); no UI dashboard added | smoke test |
| §13 eval suite per agent, all categories, deterministic asserts | **Done** (runner + seed cases); model-based grading **not implemented** | `units.test.ts`, `approvals-workflow.test.ts` |
| §13 feedback never auto-rewrites instructions/permissions | **Done** by construction — nothing writes prompts/permissions automatically | — |
| §14 Phase 5 rollout with autonomy off by default | **Done** (approval_gated default) | — |

## 14. Known limitations / remaining risks

- Idempotency is check-then-act on `AuditLog`; two runs issuing the identical non-idempotent call
  within milliseconds could both execute. Fix: a unique ledger table or Redis `SET NX` reservation.
- `NOTIFY` still doesn't notify (pre-existing); approvals have no email/Slack notification — approvers
  must poll `GET /api/approvals`.
- No approval UI; API only. The existing workflow page shows approvals read-only.
- Injection detection is heuristic; it flags, it does not block. The permission/approval layer is
  the control.
- Evaluation cases in the seed are demo cases, not a validated business suite.
- Wall-clock limit is checked between steps; a single hung LLM call is bounded only by the provider SDK
  timeout.
- No per-agent compute isolation (unchanged, see CLAUDE.md).
- `packages/llm/src/pricing.ts` model IDs were not re-verified in this change.

## 15. Tests

```bash
npm run test                      # all packages via turbo
cd packages/executor && npm test  # needs Postgres; uses TEST_DATABASE_URL (default ai_workforce_test)
```

Create the test DB once: `docker exec ai-workforce-postgres psql -U postgres -c 'CREATE DATABASE ai_workforce_test'`
then `cd packages/db && DATABASE_URL=…/ai_workforce_test npx prisma db push`. DB tests refuse to run
against any database whose name does not end in `_test`. All LLM calls and tool adapters in tests are
fakes — no network, no spend.
