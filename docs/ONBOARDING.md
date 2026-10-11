# Onboarding: AI Workforce Platform

A briefing for engineers joining the project: what the product is, how the code is organised, how a request actually executes, what is real versus demo, and what changed recently. It takes about 20 minutes to read. Deeper references are linked at the end.

_Last updated 2026-10-10._

---

## 1. What we're building

A multi-tenant SaaS platform where a business deploys **AI employees** ("agents"). Examples are a sales assistant that follows up leads, or an inbox triager. Each agent has:

- a role and a prompt;
- **playbooks** (called "skills" in the code);
- access to the business's tools: Gmail, Google Calendar, HubSpot and Google Drive today;
- explicit limits on what it may do without a human.

Target customers are agencies, law firms, insurers, real estate offices and wholesalers. Pricing runs from Starter ($299/mo) to Enterprise ($2,499/mo). The pitch: "deploy AI employees in hours, not months". See `BUSINESS_MODEL.md`.

The repo is two things at once:
- an **investor demo**, with a seeded tenant, the `/demo` presentation and `demo-video.html`;
- the **foundation of the real product**, with real execution, safety controls and tests.

Keep the difference in mind (see §7).

---

## 2. Repo tour

Turborepo monorepo, TypeScript (strict) everywhere, Node test runner for tests.

```
apps/web            Next.js 14 App Router: dashboards, operator console, ALL API routes
packages/
  db                Prisma schema + seed (Postgres 16 with pgvector)
  auth              NextAuth (credentials) → session carries role + tenantId
  domain            RBAC (hasPermission, canAccessTenant, canApprove), validation, redaction
  llm               One client for Anthropic / OpenAI / Ollama (tool-use aware) + price table
  integrations      Adapters: Gmail, Google Calendar, HubSpot, Google Drive (Zod-typed actions)
  tools             Tool registry (adapter action → "gmail__send_email"), risk classes, policy
  executor          The agent loop, contracts, approvals, evaluation, workflows, self-management
  knowledge         RAG: chunk → embed → pgvector search (keyword fallback without OpenAI key)
  queue             BullMQ queues + the worker process + cron scheduler
  monitoring        Health checks, Watchdog heartbeats, alert rules
  billing           Stripe plans/subscriptions (no keys configured)
  ui                Shared React components
docs/               This file, AGENT_OPERATING_SYSTEM.md, WORKFORCE_MANAGER.md, DECISIONS.md
scripts/            gmail-live-test.ts (manual live email test, needs Google OAuth credentials)
```

Dependencies flow downwards: `web → queue → executor → tools → integrations`, and everything depends on `db`/`domain`. The executor never imports the queue. Work that needs enqueueing (e.g. deploying a newly created agent) is returned to the worker, which does it.

---

## 3. Local setup

```bash
docker compose -f compose.yml up -d postgres redis      # Postgres on 5433 (pgvector), Redis on 6379
cp .env.example .env && cp .env packages/db/.env && cp .env apps/web/.env
npm install
npm run db:push                                          # schema → dev DB (ai_workforce)
cd packages/db && npx tsx prisma/seed.ts && cd ../..     # demo tenant, users, agents
./start-dev.sh start                                     # web on :3000
npx tsx packages/queue/src/start-workers.ts              # worker process (separate terminal)
```

Demo logins: `admin@demo-agency.local` / `demo123` (customer admin), `staff@demo-agency.local` / `demo123` (staff), `admin@platform.local` / `admin123` (platform admin).

Nothing that calls a model works without `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (or a local Ollama). Without a key, runs end `failed` with a clear "model unavailable" error. They never fake success.

**Tests** need a separate database, `ai_workforce_test`. Create it once and `prisma db push` to it. Then `npm run test`. The DB-backed tests refuse to run against any database whose name doesn't end in `_test`.

---

## 4. How a request actually executes

```
Browser / API client
   │  POST /api/agents/{id}/run  {input}
   ▼
apps/web route ── checks session, role, tenant ──► enqueue BullMQ job, return jobId immediately
                                                   (no agent work ever runs inside an API route)
   ▼
worker process (packages/queue) ── agent-run worker ──► runAgent(agentId, input)   packages/executor/src/agent.ts
   │
   ├─ DIAGNOSE  contract valid? kill switch? agent paused? input present? spend cap? effective autonomy stage
   ├─ ASSEMBLE  playbook tools ∩ contract allowlist, minus anything policy would deny; prompt =
   │            system prompt + playbooks + business context + knowledge (RAG) + platform policy
   ├─ ACT       model call (with fallback models) → tool calls → policy decision per call:
   │              execute │ ask a human (Approval row, run pauses) │ record as proposal │ deny
   │            tool output is redacted and wrapped as untrusted data before the model sees it
   └─ ASSESS    Definition-of-Done checks against evidence (tool results, not the model's claims)
   ▼
exactly one terminal status: completed / partial / needs_clarification / escalated /
approval_required / blocked / cancelled / failed  → AuditLog row with the full trace and cost
```

When a human approves an action (`POST /api/approvals/{id}`), the `approval-execute` worker runs **exactly that call, once**, re-checks current policy first, and resumes the paused workflow if there was one.

Other queues: `workflow-run` (multi-step workflows), `embed-document` (RAG indexing), `deployment` (validate and mark an agent PRODUCTION), `agent-evaluation` (dry-run test suites) and `agent-revision` (self-management pipeline). The scheduler ticks every 60 s. Each tick does four things: fires cron schedules, expires stale approvals, queues proposed revisions, and runs the post-promotion watch.

---

## 5. Core concepts (glossary)

| Term | Meaning | Where |
|---|---|---|
| Tenant | A customer business; everything is scoped to one. | `Tenant` |
| Agent | An AI employee. `version` increments on every material change. | `Agent` |
| Skill / playbook | Instructions + required tools + evaluation cases. Versioned (semver). | `Skill`, `AgentSkill` |
| Contract | The agent's enforced definition: rationale, Definition of Done, scope, tool allowlist, soul (tone/values), autonomy stage, owner, escalation, limits, model fallbacks/privacy. Strict Zod schema. | `Agent.config.contract`, `executor/src/contract.ts` |
| Business context | Tenant-wide facts every agent sees, including explicit "unknowns — ask, don't guess". | `Tenant.settings.businessContext` |
| Autonomy stage | `observe → recommend → draft → approval_gated (default) → limited → expanded`. A *ceiling* over per-tool permissions. `limited`/`expanded` only apply with a passing evaluation for the current version. | `tools/src/policy.ts` |
| Permission | Per-agent, per-tool level: AUTOMATIC / NOTIFY / CUSTOMER_APPROVAL / OPERATOR_APPROVAL / PROHIBITED. | `AgentPermission` |
| Risk class | Fixed per tool: read / draft / write_reversible / external_communication / destructive / write_irreversible. Unknown tools are treated as irreversible. | `tools/src/risk.ts` |
| Approval | A pending human decision on one exact action. PENDING → APPROVED/REJECTED/EXPIRED → EXECUTED/EXECUTION_FAILED. | `Approval`, `executor/src/approvals.ts` |
| Evaluation | A dry-run test suite (real model, simulated tools), pinned to an agent version. Evidence for promotion. | `Evaluation`, `executor/src/evaluation.ts` |
| Deployment | Validation gate + PRODUCTION status. No per-agent container (shared worker). | `Deployment`, deployment worker |
| Kill switch | Platform (`AGENTS_DISABLED`, `DISABLED_TOOLS` env), tenant (`settings.killSwitch`), agent (`PAUSED`). | `executor/src/safety.ts` |
| Workforce Manager | An agent that reviews the others and proposes revisions. | `docs/WORKFORCE_MANAGER.md` |
| Revision | A proposed create/update/retire of an agent, going through sandbox → tests → replay → (approval) → promotion → watch. | `AgentRevision`, `executor/src/workforce/` |

---

## 6. The safety model on one page

The one rule: **authority is enforced in code, never by asking the model nicely.**

- **Least privilege.** The model is only offered tools that its playbooks need, that its contract allows, and that policy wouldn't deny anyway.
- **Every tool call is decided by policy:** permission level × autonomy stage × risk class × kill switch. High-risk actions need approval unless the agent has *earned* `limited`/`expanded` through evaluation.
- **Approvals are exact.** Approving one email approves that email with those arguments, once.
- **Idempotency.** Non-idempotent tools (send email, create event) aren't repeated with identical arguments within 24 h. A timeout means "unknown outcome", which goes to a human and is never retried blindly.
- **Untrusted content.** Tool outputs, documents and agent-generated data are wrapped in delimiters, scanned for injection patterns and redacted. They're treated as data, never as instructions.
- **Bounded runs:** limits on iterations, tool calls, wall-clock time and cost per run, plus daily and monthly tenant spend caps.
- **Evidence over claims.** The Definition of Done is checked against tool results. "I sent the email" without a successful send result fails.
- **Self-management stays inside the same fence.** The manager can only *propose*. Proposals face hard limits, evaluation, replay and a human approval for anything that adds risk, then a post-promotion watch with automatic rollback.
- **Audit everything.** Every run, tool call, approval, revision and settings change writes a redacted `AuditLog` row. Metrics are computed from these rows.

---

## 7. What's real and what's demo

| Area | Status |
|---|---|
| Auth, RBAC, tenant isolation, CRUD APIs | Real and smoke-tested. |
| Agent loop, policy, approvals, evaluation, workflows, scheduler, self-management | Real; covered by 114 automated tests (fake model + fake adapters). Not yet run end-to-end against a real model with real integrations. |
| LLM calls | Real clients; need an API key. |
| Gmail / Calendar / HubSpot / Drive adapters | Code paths unit-tested with stubbed Google SDKs. **No live credentials configured; never run against real accounts.** No OAuth callback route exists in the app yet (`scripts/gmail-live-test.ts` does its own loopback OAuth for testing). |
| Billing | UI + Stripe code; no keys configured. |
| Dashboards | Mostly real data from the DB; system metrics (CPU, latency percentiles) intentionally report 0 rather than fake numbers. |
| Approvals UI / notifications | None: API only. |
| Integration credentials | Stored **unencrypted** in `Integration.credentials`. This must be fixed before any real customer connects anything. |

---

## 8. Where to make common changes

- **Add an integration action.** Add it to the adapter in `packages/integrations` (Zod input/output schemas). It registers automatically as `<adapter-slug>__<action>`. Then **add its risk profile** in `packages/tools/src/risk.ts`, otherwise it's treated as an irreversible write. Add a stubbed-SDK test in `packages/integrations/src/adapters.test.ts`.
- **Add an API route.** Follow the pattern in `CLAUDE.md`: session → role check (`hasPermission`) → tenant check (`canAccessTenant`) → Zod validation → enqueue if it does work. Never run agents inline.
- **Change how agents behave.** Prefer the contract, playbooks and prompts (data) over executor code. When changing the executor, add a test in `packages/executor/src/__tests__/` using `scriptedLLM` and `fakeTools` from `helpers.ts`.
- **Change what self-management may do.** Change `workforce/invariants.ts` and its tests. Treat any loosening as a security change and get it reviewed.
- **Schema changes.** Edit `packages/db/prisma/schema.prisma`, then `db push` to both `ai_workforce` and `ai_workforce_test`. The project uses `db push` in development, not migrations.

---

## 9. Testing

```bash
npm run test     # all packages (needs Postgres + the ai_workforce_test DB)
npm run lint     # 0 errors expected (warnings exist in older packages)
npm run build    # Next build + packages
```

| Package | Tests | Kind |
|---|---|---|
| executor | 80 | DB-backed with fake model/adapters + pure unit tests (contract, policy, approvals, workflows, evaluation, capabilities, self-management) |
| integrations | 15 | Adapter request-building with stubbed Google SDK (send/reply threading, availability, reminders) |
| tools | 10 | Policy decision table |
| domain | 5 | Redaction |
| queue | 4 | Scheduler (injected deps) |

No test touches a real external account, sends real email or spends money.

---

## 10. Recent changes (October 2026)

1. **Agent operating system.**
   - Contracts in `Agent.config.contract` and staged autonomy.
   - Bounded Diagnose → Assemble → Act → Assess runs with explicit terminal statuses.
   - Approvals that execute exactly once and resume workflows.
   - Evaluation evidence pinned to agent versions.
   - Kill switches, model fallbacks and privacy routing, idempotency, untrusted-content wrapping, redaction, run metrics.
   - New routes: approvals, evaluations, kill switch, run cancellation, `monitoring?type=agent-runs`.
   - Details in `docs/AGENT_OPERATING_SYSTEM.md`.
2. **Dependency audit, low-risk fixes.**
   - Next.js 14.2.35 (exact pin).
   - Image optimizer disabled (`images.unoptimized`), since nothing uses `next/image` and the remaining critical advisories are in it.
   - Unused jest and axios removed; `npm audit fix` applied.
   - 21 findings remain, all needing major upgrades. The Next 15.5 upgrade is the important one.
3. **Capability tests and a Gmail fix.** Tests for send/receive/reply, availability, and meeting creation with reminders (calendar event reminders; there's no separate reminder tool). `buildMimeMessage` now threads replies (`In-Reply-To`/`References`) and rejects header injection (CR/LF in subjects and headers). There is no Zoom integration; Calendar's Meet links are the nearest substitute.
4. **Gmail live-test script** (`scripts/gmail-live-test.ts`). It sends through the real approval path. It's blocked until Google OAuth client credentials exist, and real email remains unfinished by choice (see §11).
5. **Workforce Manager and self-improving agents.**
   - New: `AgentRevision` model, revision pipeline, manager tools, agent suggestions, tenant self-management policy, rollback and watch.
   - Seeded manager **Morgan** with an inactive weekly schedule.
   - New API: `/api/revisions`, `/api/tenants/[id]/self-management`.
   - Details in `docs/WORKFORCE_MANAGER.md`.

All of the above is currently **uncommitted** on `main`, alongside earlier uncommitted work.

---

## 11. Open decisions and next priorities

1. **Email for real customers (paused).** The recommendation was:
   - a generic IMAP/SMTP adapter, which covers Zoho Mail Lite and most hosts;
   - Microsoft 365 via Graph;
   - Google Workspace via OAuth (the adapter exists; it needs Google app verification at scale);
   - a transactional email provider for platform notifications (SPF/DKIM/DMARC on our domain).
   **Prerequisite: encrypt integration credentials.**
2. **Approvals UI and notifications.** Today nobody is told when an agent is waiting. The fix is to make `NOTIFY` actually notify.
3. **Run the manager against a real model** on the demo tenant and review its first proposals by hand.
4. **Next.js 15.5 upgrade** (React 19) to clear the remaining critical advisories.
5. **Scale hardening:**
   - single-leader scheduler (BullMQ repeatable job);
   - unique idempotency ledger;
   - an `AgentRun` table when `AuditLog` queries slow down;
   - per-agent compute isolation before running untrusted code.
6. **Connector catalogue (MCP/OpenAPI) and an internal "integration factory"** for broader tool coverage.
7. **Seed hygiene:** `integration.createMany` in the seed isn't idempotent, so reseeding adds duplicate Gmail/HubSpot rows. There are also two pre-existing type errors in the seed's permissions block.

---

## 12. Further reading

- `CLAUDE.md`: full project context, environment, commands and known gaps (kept current for AI assistants and humans alike).
- `docs/AGENT_OPERATING_SYSTEM.md`: contracts, autonomy, run lifecycle, approvals, evaluation, operations, requirement checklist.
- `docs/WORKFORCE_MANAGER.md`: self-management design, rules, configuration, API and limitations.
- `docs/DECISIONS.md`: architecture decision records.
- `BUSINESS_MODEL.md`, `DEMO.md`: the business, and how to run the investor demo.
