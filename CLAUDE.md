# CLAUDE.md — Full Context for AI Workforce Platform

## What This Is

A multi-tenant SaaS platform that lets businesses deploy custom AI employees ("AI agents"). Built as a monorepo with Next.js 15 (App Router, React 19), TypeScript, Prisma, PostgreSQL, Redis, Tailwind CSS, and Turborepo.

**Purpose**: Pitchable demo for investors + foundation for a real product.

---

## Current State

### What Works (Demo-Ready)
- **Authentication** — NextAuth with credentials provider (email/password)
- **Multi-tenant RBAC** — 4 roles: PLATFORM_ADMIN, PLATFORM_OPERATOR, CUSTOMER_ADMIN, CUSTOMER_STAFF
- **CRUD APIs** — Agents, Skills, Workflows, Knowledge Documents, Integrations
- **Operator console** — Platform-wide dashboards (tenants, agents, runtimes, incidents, costs)
- **Customer dashboard** — Agent config, skill management, knowledge base, workflow builder UI, billing UI, onboarding wizard
- **Integration adapters** — Gmail, Google Calendar, HubSpot CRM, Google Drive (OAuth flows written, but no credentials configured)
- **Billing UI** — Stripe subscription management (UI works, no Stripe keys configured)
- **Demo data** — Seeded (with shared memory and hand-offs on for the whole team, `docs/TEAMWORK.md`): 2 tenants, 3 users, 6 agents (Sarah sales, Morgan manager/front desk, Ava client questions + voice, and the showcase team in `packages/db/prisma/seed-showcase.ts`: Riley meeting scheduler (approval_gated), Iris inbox triage and Casey CRM hygiene (both `recommend` stage), and Jordan website enquiries, staged with a flaw for the self-repair moment: DEMO.md "Self-repair", `npm run demo:stage-repair`), their playbooks with test cases, 4 knowledge docs, sandbox Gmail/HubSpot/Google Calendar connections, 1 active subscription. `npm run demo:reset` restores it and deploys the team so every agent shows as live (`npm run demo:deploy`, `scripts/deploy-demo-team.ts`: same validation gate as the Deploy button, run in-process; DEMO.md).
- **Prompt caching** (`packages/llm`) — `buildAgentContext()` returns `systemBlocks`: a stable prefix (policy, identity, behaviour, business context, instructions, playbooks; marked `cache: true`) and a per-request block (retrieved knowledge, current time). Anthropic gets a `cache_control` breakpoint on the stable block plus top-level automatic caching for the growing tool loop (5-minute TTL); OpenAI caches prefixes automatically and gets `prompt_cache_key: agent:<id>`. Usage carries `cacheReadTokens`/`cacheWriteTokens`, priced in `estimateCostUsd()` (reads 0.1x input on Claude unless the table says otherwise, writes 1.25x; OpenAI reads 0.5x) and recorded in `tokensUsed`. Skill/specialist queries are ordered so the prefix is byte-identical between runs — keep anything per-request out of the stable block. Measured 13 Oct: Iris's second run read 7,093 of 7,099 input tokens from cache.
- **Current date and time in every prompt** — `buildAgentContext()` ends the system prompt with the date and time in `Tenant.settings.timeZone` (IANA, default UTC; demo tenant `Australia/Sydney`). Last section on purpose, so the rest of the prompt stays a cacheable prefix.
- **Investor demo presentation** — `/demo` route (animated scroll presentation) + `demo-video.html` (standalone auto-playing slideshow)
- **Database** — Fully migrated and seeded via Prisma
- **LLM invocation** (`packages/llm/`) — Unified Anthropic + OpenAI + Ollama client (`createLLMClient(provider, model, config)`), tool-use aware, used by the agent executor. Throws a clear `LLMConfigError` if the relevant API key isn't set rather than failing silently. Set `Agent.modelProvider = "ollama"` (model = whatever's pulled, e.g. `"llama3.1"`) to run that agent entirely against a local/self-hosted Ollama server (`OLLAMA_BASE_URL`, default `http://localhost:11434/v1`) — no data leaves the customer's infrastructure, and no API key is required. `OllamaLLMClient` reuses `OpenAILLMClient`'s message/tool conversion since Ollama exposes an OpenAI-compatible endpoint; tool-calling reliability with local models varies by model, so verify against a specific skill before relying on it for tool-heavy agents.
- **Tool calling framework** (`packages/tools/`) — `toolRegistry` maps every integration adapter action to an LLM-facing tool name (e.g. `gmail__send_email`), converts Zod input schemas to JSON Schema, and `checkAndExecuteToolCall()` enforces `AgentPermission` (AUTOMATIC/NOTIFY auto-run, CUSTOMER_APPROVAL/OPERATOR_APPROVAL pause for approval, PROHIBITED denied) before calling the adapter.
- **Agent executor** (`packages/executor/`) — `runAgent()` is the real observe → think → act → observe loop: assembles the system prompt from `Agent.systemPrompt` + enabled skills + relevant knowledge, calls the LLM with resolved tools, executes permitted tool calls, feeds results back, loops until a final answer or an approval-required pause. `executeWorkflow()` drives `WorkflowRun` through PENDING → RUNNING → COMPLETED/FAILED/APPROVAL_REQUIRED, executing `agent_task` / `condition` / `approval` / `delay` / `transform` / `parallel` steps (conditions are a structured `{path, operator, value}` shape, not `eval`'d expressions).
- **RAG / Knowledge retrieval** (`packages/knowledge/`) — pgvector-backed: `KnowledgeChunk.embedding vector(1536)` (OpenAI `text-embedding-3-small`), documents are chunked/embedded via a queue job on upload, `searchKnowledge()` does cosine-similarity search optionally scoped to one agent's attached documents. Falls back to the original SQL `LIKE` search when `OPENAI_API_KEY` isn't set, so the feature degrades instead of breaking.
- **Background job queue** (`packages/queue/`) — BullMQ + Redis. Queues: `agent-run`, `workflow-run`, `embed-document`, `deployment`, `approval-execute`, `agent-evaluation`, `agent-revision`. `packages/queue/src/start-workers.ts` is the worker process entrypoint (run it alongside `next dev`/`next start`; nothing executes inline in an API route).
- **Agent scheduling** — `packages/queue/src/scheduler.ts` polls active `Schedule` rows every 60s, matches cron expressions with `cron-parser`, and enqueues an `agent-run` job with an idempotent job ID. Single-process only today (see Known Gaps).
- **Monitoring** (`packages/monitoring/`) — `runHealthChecks()` checks DB + Redis for real; `GET /api/health` (unauthenticated) and `GET /api/monitoring?type=health` expose it. `evaluateAlertRules()` fires real alerts (as `AuditLog` rows) from Watchdog component health and workflow failure-rate; `Watchdog` is instantiated and started in the worker process and receives heartbeats from every `runAgent()` call and from deployments.
- **Deployment runtime** (`deployment` queue job) — "Deploy" validates the agent (`validateAgentDefinition(..., { forDeployment: true })`: contract present and consistent, playbooks with owner + evaluation cases, registered tools, system prompt; passing evaluation for the current version if the stage is `limited`/`expanded`; model provider/key configured) then marks it PRODUCTION and registers it with the Watchdog; rollback reverts to the previous running deployment or PAUSED. There is no per-agent container/process — see Known Gaps.
- **Cost tracking + per-tenant spend cap** (`packages/llm/src/pricing.ts`, `packages/executor/src/spend-cap.ts`) — every `runAgent()` result carries a real `costUsd` (from a $/token table fetched from provider pricing pages, not guessed), written into the `AGENT_RUN_COMPLETED`/`AGENT_RUN_FAILED` `AuditLog` rows and accrued onto the agent's running `Deployment.costPerMonth`. Before any LLM call, `checkSpendCap()` sums that same `AuditLog` data against `Tenant.settings.costLimits` (`{ "costLimits": { "dailyUsd": 5, "monthlyUsd": 100 } }`, set via `PUT /api/tenants/[id]` — note that route *replaces* `settings` wholesale, so merge client-side) and refuses the run with `AGENT_RUN_BLOCKED_SPEND_CAP` once a tenant hits its cap. No limit configured for a tenant = unlimited (opt-in, doesn't affect tenants that haven't set one).
- **Agent operating system** (full write-up: `docs/AGENT_OPERATING_SYSTEM.md`) — every agent has a validated contract in `Agent.config.contract` (`packages/executor/src/contract.ts`: rationale, Definition of Done checks, scope in/out, tool allowlist, soul, autonomy stage, owner/escalation, limits, model fallbacks/privacy, schedule policy). `runAgent()` is a bounded Diagnose → Assemble → Act → Assess loop with a run ID (= BullMQ job id), explicit terminal statuses (`completed/partial/needs_clarification/escalated/approval_required/blocked/cancelled/failed`), per-LLM-call budget checks, cancellation, idempotency for non-idempotent tools, untrusted-content wrapping and redacted audit rows. Autonomy stages (`observe…expanded`, default `approval_gated`) cap `AgentPermission` via `packages/tools/src/policy.ts`; `limited`/`expanded` only apply with a passing `Evaluation` for the current `Agent.version`. Approvals: `GET /api/approvals`, `POST /api/approvals/[id]` → `approval-execute` worker executes exactly the approved call once and resumes the workflow from its checkpoint. Also: `POST/GET /api/agents/[id]/evaluations`, `PUT /api/tenants/[id]/kill-switch`, `DELETE /api/agents/[id]/run?jobId=` (cancel), `GET /api/monitoring?type=agent-runs`. Kill switches: agent `PAUSED`, tenant `settings.killSwitch` (**Stop all agents** button on `/dashboard/team`), env `AGENTS_DISABLED`/`DISABLED_TOOLS`.
- **Dashboard pages for operating agents** — `/dashboard/approvals` (approve/reject with the exact content, risk and reasoning), `/dashboard/agents/[id]` (give an agent a task and reply to follow up; history is grouped into conversations (refreshes every 10 s while visible, and after each voice turn), typed or voice calls, via `GET /api/agents/[id]/runs?view=conversations`, with each answer's step-by-step trace. Runs carry `conversationId` + the person's own `message` on their audit row (`packages/executor/src/conversations.ts`); a typed follow-up gets the conversation's last 8 exchanges, read server-side from those rows), `/dashboard/improvements` (Workforce Manager proposals, test results, rollback). Read-only tools with no `AgentPermission` row now default to AUTOMATIC (`defaultPermissionLevel()` in `packages/tools/src/permissions.ts`); everything else still defaults to CUSTOMER_APPROVAL.
- **Credentials encrypted at rest** — `Integration.credentials` is AES-256-GCM encrypted with `CREDENTIALS_ENCRYPTION_KEY` (tenant id as AAD; `packages/tools/src/credentials.ts`). Tools decrypt via `getIntegrationForAdapter`; writes refuse plaintext when no key is set; `GET/POST /api/integrations` and audit rows return only `hasCredentials`. Rotation: old key in `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS`, then `npx tsx scripts/encrypt-credentials.ts --apply`. Losing the key means reconnecting every integration.
- **Connect Google** (full write-up: `docs/GOOGLE_CONNECT.md`) — Integrations page → `GET /api/integrations/google/connect` (signed HMAC state + httpOnly nonce cookie, 10-min expiry) → Google consent (Gmail + Calendar, offline) → `/api/integrations/google/callback` (verifies state against the signed-in user, exchanges the code, refuses tokens without a refresh token, stores only granted services encrypted via `storeOAuthConnection`, leaves sandbox mode, audits `INTEGRATION_CONNECTED`). `POST /api/integrations/google/disconnect` clears, deactivates and revokes. Needs `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; redirect URI defaults to `$NEXTAUTH_URL/api/integrations/google/callback`. Not yet run against a real Google account.
- **Approval emails** (`packages/executor/src/notifications/`, details in `docs/AGENT_OPERATING_SYSTEM.md` §7) — the scheduler tick calls `notifyPendingApprovals()`, which claims new PENDING approvals once (`Approval.notifiedAt`) and emails a digest to whoever can decide them: `canApprove` tenant users, platform users for OPERATOR_APPROVAL, `ApprovalPolicy.notifyEmails`, `Tenant.settings.notifications.approvalRecipients`. The email has a summary and a dashboard link only, never the material content or an approve-by-email link. Off unless `SMTP_HOST` + `EMAIL_FROM` are set (audited `APPROVAL_NOTIFICATION_SKIPPED` with who would have been emailed); tenants opt out with `settings.notifications.approvalEmails: false`; reserved domains (`.local`, `.test`, `example.com`) are never mailed, so the demo users get nothing. **`NOTIFY` permission level** now notifies: `runAuthorizedTool` marks the audit row of a NOTIFY-level call that ran (`newData.notify`, never on dry runs) and `notifyAgentActions()` (same tick) emails the tenant's admins + policy addresses afterwards, claimed once via a `Notification` row (unique `kind`+`sourceId`); opt out with `settings.notifications.actionEmails: false`. Verified 15 Oct against a local SMTP catcher; no real SMTP provider used yet. nodemailer is pinned to 10.x (7.x–10.0.5 have SMTP injection advisories).
- **Sandbox connections** — an `Integration` with `config.sandbox = true` runs tools against fictional data (`packages/tools/src/sandbox.ts`): reads return realistic records, writes report what *would* have happened, results are recorded as `simulated` (`AGENT_TOOL_CALL_SIMULATED`), and approvals show a "Sandbox" badge. The seed puts the demo Gmail/HubSpot connections in sandbox mode; `scripts/gmail-live-test.ts auth` switches Gmail out of it when real tokens are stored.
- **Real-model results (2026-10-13)** — Sarah and Morgan have run against the real API. Morgan's first review produced a tested, auto-promoted playbook change (Sarah v2); a human revision moved Sarah to `claude-haiku-5-5` with act-don't-announce instructions (v3, 11/11 tests). Anthropic client: sampling params are only sent to models that accept them (`supportsSamplingParams`; Opus 4.7+/Sonnet 5+/Fable reject `temperature`), and assistant turns are replayed with the model's original content blocks (`LLMMessage.providerContent`). Reseeding no longer overwrites agents a revision has changed (`seedOwned`/`linkSkill` in the seed).
- **Team management** (`docs/WORKFORCE_MANAGER.md` §4a) — quality signals on every finished run (`packages/executor/src/quality.ts`: promised/claimed actions not taken, questions asked in text), automatic repair reviews started by the scheduler every 10 min when an agent crosses `selfManagement.autoReview` thresholds (`workforce/triggers.ts`, one per problem per 24 h, capped per day), Morgan as front desk (`delegation.allowedSpecialists: ["*"]`, managers only; on `claude-sonnet-5-5` with a 5-case `workforce_review` test suite, 25 Oct), and `/dashboard/team` (`GET /api/team`). Verified on the real model: "Ask the team" routed a follow-up to Sarah in 17 s for $0.016.
- **Voice agents** (full write-up: `docs/VOICE.md`) — voice calls in the dashboard: Talk panel on `/dashboard/agents/[id]` (hands-free: in-browser voice detection starts/ends turns; talking over the agent interrupts it, and only a voice does: Silero VAD in the browser (`speech-detector.ts`, `public/vad/`), the agent pausing mid-word to listen and carrying on after a noise; voice turns get `VOICE_STYLE` and can end the call with `platform__end_call` after a goodbye, the page hanging up ~1 s later; each turn sends the call so far as `history`; answers stream sentence by sentence: model text over Redis → per-sentence TTS streamed as PCM with Cartesia word timings → NDJSON to the browser, played with Web Audio and typed out word by word as it is said; greeting/acknowledgement audio cached in Redis; the caller's words are transcribed live as they speak (OpenAI `gpt-live-transcribe` over a browser WebSocket with a short-lived key, `POST /api/agents/[id]/voice/live`, `live-transcriber.ts`), used to time the call (not shown) and sent as text as soon as they end a sentence after the turn ends, with soft "mm-hm" backchannels at pauses during long explanations; at a sentence-end pause the answer is drafted early (`draft` → `/voice/draft` go/drop; the run holds tool calls and records until go, a dropped one leaves only `VOICE_DRAFT_DISCARDED` with its cost); an orb shows who's talking; an upload is the fallback; a slow transcription is retried in parallel after 1 s; low effort for voice, acknowledgement clip if slow; docs/VOICE.md) for agents with `Agent.config.voice.enabled` → `POST /api/agents/[id]/voice` (speech-to-text in `packages/llm/src/speech.ts`: OpenAI, Deepgram or Speechmatics, per agent `voice.sttProvider`, compared side by side with **Compare transcribers** on the agent page → normal agent run in the worker with trigger `voice`, awaited via `waitForAgentRun()` → `spokenReply()` → text-to-speech, OpenAI or Cartesia) → `VOICE_TURN` audit row with usage. Greeting must disclose AI; cloned voices need recorded consent (`voiceConfigSchema`); an agent keeps up to 8 recorded voices and switches between them. Cartesia speech is capped per month (`tts-budget.ts`: `CARTESIA_MONTHLY_CHARACTER_LIMIT` platform-wide, default 100,000; `Tenant.settings.voiceLimits` per tenant, default 50,000 characters and 10 recordings). Seeded **Ava - Client Questions** (`demo-assistant-1`): Knowledge Assistant on `claude-haiku-5-5` with Cartesia's Australian "Bronte" voice, answers from the Services and Packages guide (what each package includes, add-ons, terms) and the FAQ/overview/pricing documents, fully rather than handing off (`maxKnowledgeExcerpts: 8`) and can read the calendar's free time (`google-calendar__find_free_time`, read-only: she offers slots and says a person will confirm, never books). 9 test cases. `scripts/reindex-knowledge.ts` embeds seeded documents once `OPENAI_API_KEY` is set. Phone/real-time (AI Receptionist) is not built.
- **Teamwork and memory** (full write-up: `docs/TEAMWORK.md`) — **Team cases** (`/dashboard/cases`, `GET/POST/PUT /api/cases`): a `TeamCase` is one piece of work moving through the team; each agent's part is an `AgentTask`. Agents pass work on with `platform__hand_off` (contract `handoffs: { enabled, allowedAgents }`): the task is queued for the teammate (`packages/executor/src/handoffs.ts`; the worker runs it as its own run, trigger `handoff`, run id `task-<id>`, with the case so far as untrusted context) and the agent carries on. Bounded per run/case/chain, no ping-pong, never grants permissions. `contract.approvals.mode: "continue"` holds an approval-gated action and lets the run carry on (the run ends `approval_required` with `approvalIds`; the task settles when every approval is decided). A task that asks a question is answered on the case page. **What the team knows** (`/dashboard/memory`, `/api/memory`): shared `Memory` rows (`packages/executor/src/memory.ts`) for agents with `memory.mode: "tenant"`: the best matches go in every prompt (staff-confirmed as facts, the rest as untrusted data), `platform__remember` / `platform__recall`; only a person typing in the dashboard counts as staff (agents are told who they're talking to); team-wide facts from customers or emails wait for a person to confirm; rejecting an approval with a reason becomes a lesson for that agent. The seed (`enableTeamwork`) turns both on for the demo team and adds four staff notes. Verified 24 Oct on the real model: enquiry → Sarah → Riley, inbox → Iris → Sarah → Riley, and a staff note told to Ava used by Riley.
- **Learn from your website** (full write-up: `docs/ONBOARDING_WEBSITE.md`) — Onboarding page: paste a URL → the `website-import` worker reads up to 10 public pages (`packages/knowledge/src/website.ts`: SSRF-safe DNS check on every connection and redirect, robots.txt, size/time limits) → `claude-sonnet-5-5` drafts a JSON profile (services and prices, hours, policies, FAQs, tone, facts, unknowns, suggested agents) → a person edits and applies any of: business profile, knowledge documents (attached to every agent), facts as staff notes; undo takes it all back (`packages/executor/src/onboarding.ts`, `/api/onboarding/website`). ~$0.11 per site.
- **Impact dashboard** (`docs/IMPACT.md`) — the dashboard home (`/dashboard`, `GET /api/impact?days=1|7|30`, `packages/executor/src/impact.ts`) shows real numbers from the audit trail: tasks finished (a voice call counts once), estimated time saved (agent's `taskAssessment.manualEffortMinutes` per finished task, seeded per demo agent), median time to finish, cost per task, a per-day chart, what was learned and improved, what's waiting, latest work and a per-agent table. It replaced hard-coded placeholder stats.
- **Workforce Manager / self-improving agents** (full write-up: `docs/WORKFORCE_MANAGER.md`) — opt-in per tenant (`Tenant.settings.selfManagement.enabled`, set via `PUT /api/tenants/[id]/self-management`; demo tenant opted in by the seed). A manager agent (`contract.management.enabled`, seeded as `demo-manager-1` "Morgan", weekly schedule seeded **inactive**) gets `platform__list_agents` / `inspect_agent` / `propose_agent_change` / `get_revision`; every other agent gets `platform__suggest_improvement`. Proposals become `AgentRevision` rows and go through `packages/executor/src/workforce/revisions.ts`: hard limits (`invariants.ts`: no manager edits, no granting management, autonomy ceiling, registered + tenant-connected tools only, append-only eval cases, rate limit, one open revision per agent) → sandbox candidate agent (`Agent.isCandidate`, hidden everywhere, dry-run only) → deploy validation → evaluation suite → score ≥ live → replay of recent real inputs (dry run, live reads) → human approval if risk-increasing (`Approval` kind `agent_revision`) → promotion as a new version → 72 h watch with automatic rollback. Config-only: no code generation. Also `GET/POST /api/revisions`, `GET /api/revisions/[id]`, `POST /api/revisions/[id]/rollback`.

### Known Gaps / Next Hardening Pass
- **No per-agent compute isolation** — all agents execute inside the shared worker process (`packages/queue`), not their own container/VM. Fine for the current scale; would need real provisioning (Fly Machines, ECS tasks, etc.) before running untrusted or resource-heavy agent code.
- **Scheduler polls from every worker process** — `startScheduler()` is a plain `setInterval`. A second instance can't double-enqueue the same fire minute (deterministic BullMQ jobId, as long as completed jobs are retained), but every instance still polls and writes `lastRunAt`. Move to a BullMQ repeatable job (single leader) before scaling workers horizontally.
- **Pre-existing integration adapter bugs** — `packages/integrations` (Gmail/Calendar/HubSpot/Drive) had several real type errors (now fixed to compile) around a HubSpot SDK version mismatch (`associationsApi` call is cast, unverified) and Google OAuth token shapes. None of these adapters have live credentials configured, so none have been runtime-tested — verify against real HubSpot/Google accounts before relying on them.
- **No APM/infra metrics collector** — `GET /api/monitoring?type=metrics` reports real DB-derived counts (active agents, workflows/hour) but system-level metrics (CPU, latency percentiles) stay at 0 rather than being faked.
- **Idempotency is check-then-act** — duplicate non-idempotent tool calls are suppressed via `AuditLog` lookup (24 h window), but two runs racing on the identical call within milliseconds could both execute. Needs a unique ledger or Redis reservation. Shared business memory is implemented (`docs/TEAMWORK.md`); retrieval is keyword-based, not embeddings, which is fine for hundreds of notes per tenant.
- **Dependency audit (2026-10-24): 9 findings, none critical** — upgraded to Next.js 15.5.28 + React 19 (all Next.js advisories, including the two critical RCEs, are gone; page `searchParams`/route `params` are Promises; one React copy enforced with root `overrides`; lucide-react 0.577, nodemailer 10.2.1; the unused @testing-library packages were removed). Left: postcss inside Next (build-time, only our own CSS; fixed in Next 16), zod 3 memory exhaustion on oversized constrained arrays (needs zod 4, a major change; only reachable by signed-in users behind the site password), uuid via googleapis (unused code path), tailwind/eslint build tooling. The image optimizer stays disabled (`images.unoptimized: true`).
- **Self-management never run against a real model** — the revision pipeline and manager tools are tested with a scripted fake model and smoke-tested live up to evaluation (which failed without an API key, as designed). Review the manager's first real proposals by hand before activating its schedule. Revisions are visible at `/dashboard/improvements`; no notifications yet.
- **Voice: one turn waits for the worker (≤45 s) inside the request** — fine for a browser demo, not for phone calls (AI Receptionist not built). Verified live 15 Oct (OpenAI speech) and 18 Oct (Cartesia "Bronte", Ava on Haiku 5.5): greeting 1.8 s, answers 4.8–7.9 s end to end; not yet heard by a person on a real microphone. Cloned voices: **Use your own voice** on the agent page records a consent-first script in the browser and clones it via Cartesia (`/api/agents/[id]/voice/clone`, docs/VOICE.md §2a); Remove restores the previous voice and deletes the copy at Cartesia.

---

## Architecture

### Monorepo Structure
```
/home/elliot/Documents/ai-workforce-platform/
├── apps/
│   └── web/                          # Next.js 15 App Router
│       ├── src/app/
│       │   ├── page.tsx              # Landing page (links to /demo)
│       │   ├── demo/                 # Investor presentation (animated)
│       │   ├── auth/                 # Sign in / error pages
│       │   ├── dashboard/            # Customer dashboard
│       │   │   ├── agents/
│       │   │   ├── skills/
│       │   │   ├── workflows/
│       │   │   ├── knowledge/
│       │   │   ├── integrations/
│       │   │   ├── billing/
│       │   │   ├── settings/
│       │   │   └── users/
│       │   ├── operator/             # Platform operator console
│       │   │   ├── tenants/
│       │   │   ├── agents/
│       │   │   ├── runtimes/
│       │   │   ├── incidents/
│       │   │   ├── requests/
│       │   │   ├── costs/
│       │   │   └── settings/
│       │   ├── api/                  # API routes (all CRUD, no execution)
│       │   │   ├── auth/             # NextAuth handler
│       │   │   ├── agents/           # CRUD + deploy (DB record only)
│       │   │   ├── skills/           # CRUD
│       │   │   ├── workflows/        # CRUD + run (PENDING only, no execution)
│       │   │   ├── knowledge/        # CRUD + search (SQL LIKE only)
│       │   │   ├── integrations/     # CRUD
│       │   │   ├── operator/         # Platform stats/read-only
│       │   │   ├── billing/          # Stripe webhooks + subscription
│       │   │   ├── agents/[id]/run/     # Enqueue/poll an ad-hoc agent invocation
│       │   │   └── agents/[id]/deploy/  # Creates Deployment, enqueues deployment job
│       │   ├── globals.css           # Tailwind + custom animations
│       │   ├── layout.tsx            # Root layout (Inter font)
│       │   └── providers.tsx         # SessionProvider wrapper
│       ├── tailwind.config.js        # Custom primary/neutral colors
│       └── package.json
├── packages/
│   ├── auth/                         # NextAuth config (credentials provider, JWT, RBAC in session)
│   ├── billing/                      # Stripe: plans, subscriptions, invoices, webhooks, entitlements
│   ├── db/                           # Prisma schema + migrations + seed
│   │   ├── prisma/schema.prisma      # Full schema (see below) — now includes KnowledgeChunk (pgvector)
│   │   ├── prisma/migrations/
│   │   └── prisma/seed.ts            # Demo data seeder
│   ├── domain/                       # RBAC helpers, validation, errors, tenant utilities
│   ├── llm/                          # Anthropic + OpenAI client behind one interface (Phase 1)
│   │   ├── src/types.ts              # LLMMessage, LLMTool, LLMToolCall, LLMResponse
│   │   ├── src/anthropic.ts          # AnthropicLLMClient (tool_use content blocks)
│   │   ├── src/openai.ts             # OpenAILLMClient (function-calling tool_calls)
│   │   └── src/index.ts              # createLLMClient(provider, model, config)
│   ├── tools/                        # Tool registry + permission-checked executor (Phase 2)
│   │   ├── src/registry.ts           # toolRegistry: adapter action -> LLM tool ("gmail__send_email")
│   │   ├── src/permissions.ts        # checkPermission() reads AgentPermission
│   │   ├── src/executor.ts           # checkAndExecuteToolCall(), credential lookup by Integration.name
│   │   └── src/schema.ts             # Zod -> JSON Schema for tool definitions
│   ├── knowledge/                    # RAG pipeline: chunk, embed, pgvector search (Phase 4)
│   │   ├── src/chunker.ts            # chunkText(): ~2000-char overlapping chunks
│   │   ├── src/embedder.ts           # OpenAI text-embedding-3-small
│   │   ├── src/indexer.ts            # indexDocument(): chunk + embed + raw-SQL insert
│   │   └── src/search.ts             # searchKnowledge() (pgvector) + searchKnowledgeKeyword() fallback
│   ├── executor/                     # The agent loop + workflow engine (Phase 3)
│   │   ├── src/context.ts            # buildAgentContext(): system prompt + skills + RAG
│   │   ├── src/agent.ts              # runAgent(): observe -> think -> act -> observe
│   │   ├── src/steps.ts              # WorkflowStep union, safe structured conditions (no eval)
│   │   └── src/workflow.ts           # executeWorkflow(): drives WorkflowRun through its lifecycle
│   ├── queue/                        # BullMQ background jobs + scheduler (Phase 5-6, 8)
│   │   ├── src/queues.ts             # agent-run, workflow-run, embed-document, deployment
│   │   ├── src/workers/              # One worker per queue; deployment.worker.ts is Phase 8
│   │   ├── src/scheduler.ts          # Polls Schedule rows, matches cron via cron-parser
│   │   └── src/start-workers.ts      # Standalone worker process entrypoint (see Running below)
│   ├── integrations/                 # OAuth adapters (Gmail, Calendar, HubSpot, Drive)
│   │   ├── src/base.ts               # BaseIntegrationAdapter interface + Google token helpers
│   │   ├── src/gmail.ts              # GmailAdapter (send, list, get, search, labels, drafts)
│   │   ├── src/calendar.ts           # CalendarAdapter (create, list, update, delete, free/busy)
│   │   ├── src/crm.ts                # HubSpotAdapter (contacts, deals, companies)
│   │   └── src/documents.ts          # DriveAdapter (upload, download, list, search, delete)
│   ├── monitoring/                   # Watchdog, health checks, alerts, metrics — wired up (Phase 7)
│   └── ui/                           # Shared components (Button, Input, Card, Badge, utils)
├── demo-video.html                   # Standalone auto-playing investor presentation
├── start-dev.sh                      # Dev server manager (start/stop/restart/logs/status)
├── compose.yml                       # postgres (pgvector/pgvector:pg16):5433, Redis:6379, MinIO:9000
├── .env                              # Active env file (DATABASE_URL points to localhost:5433)
├── .env.example                      # Template
├── BUSINESS_MODEL.md                 # Full business documentation
├── DEMO.md                           # Demo guide with credentials
├── CLAUDE.md                         # This file
└── package.json                      # Turborepo root
```

### Database Schema (Prisma)
Key models in `packages/db/prisma/schema.prisma`:
- **Tenant** — Multi-tenant root. Has `stripeCustomerId`, settings, industry, geography.
- **User** — With `role` (enum), `passwordHash`, `tenantId`.
- **Agent** — `name`, `role`, `mission`, `systemPrompt`, `modelProvider` (string), `modelName` (string), `modelConfig` (JSON), `status` (DRAFT→EVALUATING→PRODUCTION→PAUSED→ARCHIVED), `version`, `config` (JSON).
- **Skill** — `name`, `version` (semver), `description`, `purpose`, `instructions` (text), `requiredTools` (string[]), `inputs`/`outputs` (JSON Schema), `constraints` (string[]), `failureHandling` (JSON), `evaluationCases` (JSON array), `metadata` (JSON). Unique on `[name, version, tenantId]`.
- **AgentSkill** — Join table: `agentId + skillId + enabled + config`.
- **KnowledgeDocument** — `title`, `content` (text), `contentType`, `metadata` (JSON), `chunkCount`.
- **KnowledgeChunk** — `content`, `chunkIndex`, `embedding` (`Unsupported("vector(1536)")`, pgvector — queried via raw SQL, not the generated client), `documentId`. Populated by `packages/knowledge`.
- **AgentKnowledgeSource** — Join: `agentId + documentId + priority`.
- **Workflow** — `name`, `description`, `trigger` (JSON), `steps` (JSON array), `config`, `retryPolicy` (JSON), `timeout` (seconds), `isActive`.
- **WorkflowRun** — `status` (PENDING→RUNNING→COMPLETED/FAILED/APPROVAL_REQUIRED/CANCELLED), `input` (JSON), `output` (JSON?), `error` (text?), timestamps.
- **Integration** — `name`, `provider`, `config` (JSON), `credentials` (JSON — OAuth tokens), `scopes` (string[]).
- **AgentPermission** — `action` (string), `level` (AUTOMATIC/NOTIFY/CUSTOMER_APPROVAL/OPERATOR_APPROVAL/PROHIBITED), `conditions` (JSON).
- **ApprovalPolicy** — Per-agent approval rules with `notifyEmails`.
- **Approval** — Runtime approval records tied to `workflowRunId`.
- **EscalationRule** — Trigger, condition, contacts for escalation.
- **Schedule** — Cron-based scheduling per agent. Now has `lastRunAt` (set by `packages/queue`'s scheduler).
- **Evaluation** — Test suites with results and scores.
- **Deployment** — Version, config, status, logs, deployedAt, rolledBackAt.
- **Subscription** — Stripe-linked, plan, status, billing interval, trial dates.
- **Invoice** — Stripe-linked, amount, currency, status.
- **Incident** — Severity, status, source, assignee.
- **ChangeRequest** — Type, title, status, assignee.
- **AuditLog** — Action, entityType, entityId, old/new data, IP, userAgent.
- **ApiKey** — Tenant-scoped API keys with hash.

### Key Files to Know
- `packages/auth/src/index.ts` — NextAuth config. Credentials provider validates email/password against `User.passwordHash`. JWT callback stores `role`, `tenantId`, `tenantSlug`. Session callback exposes them. **This is where RBAC is enforced at the session level.**
- `packages/integrations/src/base.ts` — `BaseIntegrationAdapter` class with `authUrl()`, `exchangeCode()`, `refreshToken()`, `validateCredentials()`, `actions[]` (each with `inputSchema`, `outputSchema`, `execute(input, credentials)`).
- `packages/billing/src/subscriptions.ts` — Stripe subscription CRUD using `STRIPE_SECRET_KEY`.
- `packages/billing/src/plans.ts` — Hardcoded plan definitions (Starter $299, Growth $799, Enterprise $2499). Plans are NOT in the database.
- `packages/billing/src/webhooks.ts` — Stripe webhook handler for subscription events.
- `packages/db/prisma/seed.ts` — Creates demo tenants, users, skills, agent, permissions, knowledge docs, integrations, subscription. Run with: `cd packages/db && DATABASE_URL="postgresql://postgres:postgres@localhost:5433/ai_workforce?schema=public" npx tsx prisma/seed.ts`
- `packages/monitoring/src/watchdog.ts` — Heartbeat monitoring class. Instantiated as `globalWatchdog` and started in `packages/queue/src/start-workers.ts`; `runAgent()` and the deployment worker report heartbeats to it.
- `packages/monitoring/src/health.ts` — DB + Redis connectivity checks (ephemeral short-timeout Redis client so a down Redis can't hang the check).
- `packages/llm/src/index.ts` — `createLLMClient(provider, model, config)`. `provider`/`model` come straight from `Agent.modelProvider`/`Agent.modelName`.
- `packages/tools/src/registry.ts` — `toolRegistry`, built once from every adapter in `packages/integrations`. `Skill.requiredTools` entries resolve to tool names via `toolRegistry.resolve()`.
- `packages/executor/src/agent.ts` — `runAgent(agentId, input, options)`, the core loop. `options.workflowRunId` is what lets a tool call needing approval create a persisted `Approval`; without it (an ad-hoc run), approval-required just returns in the result unpersisted.
- `packages/executor/src/workflow.ts` — `executeWorkflow(workflowRunId)`. Conditions are `{path, operator, value}`, not eval'd expressions — see `packages/executor/src/steps.ts`.
- `packages/queue/src/start-workers.ts` — the worker process. Must be running for agent runs, workflow runs, embeddings, and deployments to actually execute (API routes only enqueue).

---

## Demo Credentials

| Role | Email | Password | Tenant |
|------|-------|----------|--------|
| Platform Admin | `admin@platform.local` | `admin123` | `platform` |
| Demo Admin | `admin@demo-agency.local` | `demo123` | `demo-agency` |
| Demo Staff | `staff@demo-agency.local` | `demo123` | `demo-agency` |

---

## Environment & Running

### Start Infrastructure
```bash
docker compose -f compose.yml up -d postgres redis
# If Docker networking fails (common on some systems, including sandboxed dev containers
# without veth/bridge support — that failure mode isn't fixable from inside the sandbox),
# remove containers first:
docker rm -f ai-workforce-postgres ai-workforce-redis 2>/dev/null
docker compose -f compose.yml up -d postgres redis
```
Postgres runs on the `pgvector/pgvector:pg16` image (not plain `postgres:16-alpine`) — required for `packages/knowledge`'s embeddings column. `prisma db push`/`migrate dev` create the `vector` extension automatically via `extensions = [vector]` in `schema.prisma` (preview feature `postgresqlExtensions`).

### Environment Variables (`.env` at project root)
```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/ai_workforce?schema=public"
REDIS_URL="redis://localhost:6379"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="dev-secret-change-in-production"
ANTHROPIC_API_KEY=""          # Fill to run agents with Agent.modelProvider = "anthropic"
OPENAI_API_KEY=""             # Fill to run agents with modelProvider = "openai" — ALSO required
                               # for knowledge embeddings (packages/knowledge) regardless of
                               # which provider an agent uses; without it, knowledge search
                               # falls back to keyword (SQL LIKE) search instead of pgvector.
OLLAMA_BASE_URL=""             # For modelProvider = "ollama". Defaults to http://localhost:11434/v1
                               # if unset — only needed to point at a non-default host/port.
OLLAMA_API_KEY=""              # Usually unnecessary; Ollama doesn't check it. Only set this if
                               # your Ollama server sits behind an auth proxy that requires one.
STRIPE_SECRET_KEY=""          # Must be filled for billing to work
STRIPE_WEBHOOK_SECRET=""
GOOGLE_CLIENT_ID=""           # Must be filled for Gmail/Calendar/Drive OAuth
GOOGLE_CLIENT_SECRET=""
GOOGLE_REDIRECT_URI=""          # empty = $NEXTAUTH_URL/api/integrations/google/callback (docs/GOOGLE_CONNECT.md)
HUBSPOT_CLIENT_ID=""          # Must be filled for HubSpot OAuth
HUBSPOT_CLIENT_SECRET=""
ENABLE_ANTHROPIC=true
ENABLE_OPENAI=true
```

**Important**: Turbo runs commands in each package's directory, so `.env` must be copied to `packages/db/.env` and `apps/web/.env` as well:
```bash
cp .env packages/db/.env
cp .env apps/web/.env
```

### Start Dev Server
```bash
./start-dev.sh start    # Starts on port 3000
./start-dev.sh status   # Check if running
./start-dev.sh logs     # View logs
./start-dev.sh stop     # Stop
./start-dev.sh restart  # Restart
```

### Start Background Workers
The Next.js dev/prod server only *enqueues* jobs (workflow runs, agent runs, embeddings, deployments) — nothing executes until this process is also running:
```bash
npx tsx packages/queue/src/start-workers.ts
# or: npm run start --workspace @ai-workforce/queue
```
This process also starts the Watchdog and the 60s schedule-dispatch poll. Run it in a separate terminal/process from `start-dev.sh`.

### Database Operations
```bash
# Push schema (development — faster, no migration history)
npm run db:push

# Or directly with DATABASE_URL:
cd packages/db
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/ai_workforce?schema=public" \
  npx prisma db push --accept-data-loss

# Seed demo data
cd packages/db
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/ai_workforce?schema=public" \
  npx tsx prisma/seed.ts

# Reset the demo tenant before a demo (see DEMO.md): keeps agent upgrades; --full reseeds from scratch
npm run demo:reset

# Full reset
cd packages/db
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/ai_workforce?schema=public" \
  npx prisma migrate reset --force
npx tsx prisma/seed.ts
```

### Build & Lint
```bash
npm run build     # Turborepo build all packages
npm run lint      # Lint all packages
npm run test      # Test all packages
```

`npm run build` is clean (`next build` + all workspace packages). No known build issues.

### Persistent demo (Docker, behind nginx-proxy)
`Dockerfile` + `compose.prod.yml` + `scripts/demo-deploy.sh up` (full write-up: `docs/DEPLOY.md`). No host ports: `web` joins the external `rproxy` network with `VIRTUAL_HOST`/`LETSENCRYPT_HOST`; Postgres/Redis/worker stay on a private network. Config in `.env.production` (template `.env.production.example`); `SITE_PASSWORD` enables the site-wide Basic auth in `apps/web/src/middleware.ts`.

### Sharing a demo externally (ngrok)
Share the **production** build, not `next dev` (dev compiles each route on first visit: 2.5–3 s, and ships unminified JS; production shows every dashboard page's data in about 0.3–0.6 s). Always put a password on the tunnel: the demo logins are public in this repo and the app runs on real API keys.
```bash
ngrok config add-authtoken YOUR_TOKEN                     # one-time setup
setsid ngrok http 3000 --basic-auth "demo:<strong-password>" --log=stdout > /tmp/ngrok.log 2>&1 &
URL=$(curl -s http://127.0.0.1:4040/api/tunnels | python3 -c "import sys,json; print(json.load(sys.stdin)['tunnels'][0]['public_url'])")
./start-dev.sh stop                                        # free port 3000
npm run build --workspace @ai-workforce/web
(cd apps/web && NEXTAUTH_URL="$URL" setsid nohup npx next start -p 3000 > ../../logs/web-prod.log 2>&1 &)
npx tsx packages/queue/src/start-workers.ts                # in another terminal: nothing runs without it
```
`NEXTAUTH_URL` must be the tunnel URL or sign-in redirects break. The free ngrok URL changes on every restart (redo the last two steps), and visitors see ngrok's one-time "You are about to visit" page first. The production server does not reload on code changes: rebuild and restart it.

---

## Roadmap Status: Phases 1-8 Complete

All 8 phases below were built in this order and are live (see "What Works" and "Known Gaps / Next Hardening Pass" above for what each one actually does and what's still rough):

```
Phase 1: packages/llm/          — DONE. LLM client (Anthropic + OpenAI)
Phase 2: packages/tools/        — DONE. Tool registry + executor + permissions
Phase 3: packages/executor/     — DONE. Agent loop + workflow engine
Phase 4: packages/knowledge/    — DONE. RAG pipeline (pgvector + embeddings, keyword fallback)
Phase 5: packages/queue/        — DONE. BullMQ background jobs + worker process
Phase 6: Scheduler              — DONE. Cron-based agent scheduling (single-instance)
Phase 7: Monitoring wiring      — DONE. Health checks + alerts + Watchdog
Phase 8: Deployment runtime     — DONE. Shared-process runtime, no per-agent isolation
```

If picking this roadmap back up for a *new* phase, the next priorities are the items under "Known Gaps / Next Hardening Pass" above — resume-on-approval-decision, multi-instance-safe scheduling, per-agent compute isolation — roughly in that order of how often a real customer would hit them.

---

## Key Design Decisions

1. **Agent execution is async** — Never block an API route. Use BullMQ queue. API route enqueues job, returns immediately with run ID. Worker processes the job.

2. **Tool calling is the bridge** — The LLM doesn't directly call integrations. It generates tool calls → executor checks permissions → executor calls adapter → result feeds back to LLM. This is the standard ReAct pattern.

3. **System prompt is assembled at runtime** — Don't store the full prompt. Store `systemPrompt` on the agent, then prepend skill instructions and knowledge context dynamically.

4. **Permissions are checked before every tool call** — Read `AgentPermission` model. If `level` is `PROHIBITED`, deny. If `CUSTOMER_APPROVAL`, create `Approval` record and set workflow to `APPROVAL_REQUIRED`. If `AUTOMATIC`, allow.

5. **Knowledge needs pgvector** — Install the pgvector extension on PostgreSQL. Add embedding column. Generate embeddings on document upload. Search via cosine similarity.

6. **Plans are hardcoded in `packages/billing/src/plans.ts`** — Not in DB. The seed creates a subscription with `plan: 'growth'` which matches the plan ID.

7. **Integration credentials are per-tenant** — Stored in `Integration.credentials` as JSON. OAuth tokens from `exchangeCode()` / `refreshToken()` go here. Adapters receive `credentials` as a parameter to `execute()`.

---

## File Conventions

- **TypeScript** everywhere, strict mode
- **Zod** for all input validation (API routes use `zod` schemas)
- **Prisma** for all database access (import from `@ai-workforce/db`)
- **NextAuth session** for auth (`getServerSession(authOptions)` in API routes)
- **RBAC check**: `session.user.role` — check against allowed roles per route
- **Tenant isolation**: All queries filter by `tenantId` from session
- **UI components**: Use `@ai-workforce/ui` (Button, Input, Card, Badge)
- **Icons**: `lucide-react`
- **Styling**: Tailwind CSS with custom `primary` and `neutral` color scales

### API Route Pattern
```typescript
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import { prisma } from '@ai-workforce/db'
import { z } from 'zod'

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const data = await prisma.agent.findMany({
    where: { tenantId: session.user.tenantId }
  })
  return Response.json({ data })
}
```

---

## Testing

```bash
npm run test          # All packages
npm run lint          # Lint all packages
```

Tests use Node's built-in runner via `tsx --test` (files `*.test.ts` next to the source or in `src/__tests__/`): `packages/domain`, `packages/tools`, `packages/queue`, `packages/executor`, `packages/integrations`. The executor suite is DB-backed with fake LLMs/adapters — it needs Postgres and refuses to run unless `DATABASE_URL` points at a `*_test` database (`npm test` there defaults it to `TEST_DATABASE_URL` / `ai_workforce_test`; create it once and `prisma db push` to it). Stop the local worker (`start-workers.ts`) before running the executor suite: it shares Redis with the tests and picks up their queued jobs, which once hung `workforce.test.ts`. Packages without tests have a no-op `test` script (jest was removed — it was unused and carried ~30 audit findings). Add tests alongside source files when changing behaviour.

---

## Business Model Reference

- **Pricing**: Starter $299/mo, Growth $799/mo, Enterprise $2,499/mo (AUD)
- **Target**: Marketing agencies, law firms, insurance agencies, manufacturers, wholesalers, real estate
- **Value prop**: "Deploy AI employees in hours, not months. 70-90% platform, 10-30% custom."
- **Year 1 target**: 100 customers, $1.2M ARR, 82% gross margin
- Full docs: `BUSINESS_MODEL.md`
- Demo guide: `DEMO.md`

---

## When Starting a New Chat

1. Read this file (`CLAUDE.md`) first. Humans joining the project: start with `docs/ONBOARDING.md`.
2. Check `.env` for API keys status (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` — nothing in "What Works" that calls an LLM or generates embeddings will actually run without at least one of these).
3. Check if Docker containers are running: `docker ps --filter name=ai-workforce`
4. Check if the dev server is running: `./start-dev.sh status`
5. Check if the worker process is running (nothing executes without it — see "Start Background Workers" above): `pgrep -fl start-workers`
6. Read `packages/db/prisma/schema.prisma` for the data model.
7. Read `packages/auth/src/index.ts` for auth/RBAC.
8. Read `packages/executor/src/agent.ts` and `workflow.ts` for how execution actually works.
9. See "Known Gaps / Next Hardening Pass" above before starting new work — it's the current priority list.
