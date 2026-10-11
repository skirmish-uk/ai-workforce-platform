# CLAUDE.md — Full Context for AI Workforce Platform

## What This Is

A multi-tenant SaaS platform that lets businesses deploy custom AI employees ("AI agents"). Built as a monorepo with Next.js 14 (App Router), TypeScript, Prisma, PostgreSQL, Redis, Tailwind CSS, and Turborepo.

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
- **Demo data** — Seeded: 2 tenants, 3 users, 1 agent ("Sarah - Sales Assistant"), 2 skills, 3 knowledge docs, 1 active subscription
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
- **Agent operating system** (full write-up: `docs/AGENT_OPERATING_SYSTEM.md`) — every agent has a validated contract in `Agent.config.contract` (`packages/executor/src/contract.ts`: rationale, Definition of Done checks, scope in/out, tool allowlist, soul, autonomy stage, owner/escalation, limits, model fallbacks/privacy, schedule policy). `runAgent()` is a bounded Diagnose → Assemble → Act → Assess loop with a run ID (= BullMQ job id), explicit terminal statuses (`completed/partial/needs_clarification/escalated/approval_required/blocked/cancelled/failed`), per-LLM-call budget checks, cancellation, idempotency for non-idempotent tools, untrusted-content wrapping and redacted audit rows. Autonomy stages (`observe…expanded`, default `approval_gated`) cap `AgentPermission` via `packages/tools/src/policy.ts`; `limited`/`expanded` only apply with a passing `Evaluation` for the current `Agent.version`. Approvals: `GET /api/approvals`, `POST /api/approvals/[id]` → `approval-execute` worker executes exactly the approved call once and resumes the workflow from its checkpoint. Also: `POST/GET /api/agents/[id]/evaluations`, `PUT /api/tenants/[id]/kill-switch`, `DELETE /api/agents/[id]/run?jobId=` (cancel), `GET /api/monitoring?type=agent-runs`. Kill switches: agent `PAUSED`, tenant `settings.killSwitch`, env `AGENTS_DISABLED`/`DISABLED_TOOLS`.
- **Dashboard pages for operating agents** — `/dashboard/approvals` (approve/reject with the exact content, risk and reasoning), `/dashboard/agents/[id]` (give an agent a task, watch the run, step-by-step trace from `GET /api/agents/[id]/runs`), `/dashboard/improvements` (Workforce Manager proposals, test results, rollback). Read-only tools with no `AgentPermission` row now default to AUTOMATIC (`defaultPermissionLevel()` in `packages/tools/src/permissions.ts`); everything else still defaults to CUSTOMER_APPROVAL.
- **Workforce Manager / self-improving agents** (full write-up: `docs/WORKFORCE_MANAGER.md`) — opt-in per tenant (`Tenant.settings.selfManagement.enabled`, set via `PUT /api/tenants/[id]/self-management`; demo tenant opted in by the seed). A manager agent (`contract.management.enabled`, seeded as `demo-manager-1` "Morgan", weekly schedule seeded **inactive**) gets `platform__list_agents` / `inspect_agent` / `propose_agent_change` / `get_revision`; every other agent gets `platform__suggest_improvement`. Proposals become `AgentRevision` rows and go through `packages/executor/src/workforce/revisions.ts`: hard limits (`invariants.ts`: no manager edits, no granting management, autonomy ceiling, registered + tenant-connected tools only, append-only eval cases, rate limit, one open revision per agent) → sandbox candidate agent (`Agent.isCandidate`, hidden everywhere, dry-run only) → deploy validation → evaluation suite → score ≥ live → replay of recent real inputs (dry run, live reads) → human approval if risk-increasing (`Approval` kind `agent_revision`) → promotion as a new version → 72 h watch with automatic rollback. Config-only: no code generation. Also `GET/POST /api/revisions`, `GET /api/revisions/[id]`, `POST /api/revisions/[id]/rollback`.

### Known Gaps / Next Hardening Pass
- **No per-agent compute isolation** — all agents execute inside the shared worker process (`packages/queue`), not their own container/VM. Fine for the current scale; would need real provisioning (Fly Machines, ECS tasks, etc.) before running untrusted or resource-heavy agent code.
- **Scheduler polls from every worker process** — `startScheduler()` is a plain `setInterval`. A second instance can't double-enqueue the same fire minute (deterministic BullMQ jobId, as long as completed jobs are retained), but every instance still polls and writes `lastRunAt`. Move to a BullMQ repeatable job (single leader) before scaling workers horizontally.
- **Approvals have no notification** — the dashboard has an Approvals inbox (`/dashboard/approvals`, refreshes every 15 s) but nobody is emailed when an agent is waiting.
- **`NOTIFY` permission level doesn't notify** — it auto-executes (correctly) but there's no email/webhook side effect yet, despite `SMTP_*` env vars existing.
- **Pre-existing integration adapter bugs** — `packages/integrations` (Gmail/Calendar/HubSpot/Drive) had several real type errors (now fixed to compile) around a HubSpot SDK version mismatch (`associationsApi` call is cast, unverified) and Google OAuth token shapes. None of these adapters have live credentials configured, so none have been runtime-tested — verify against real HubSpot/Google accounts before relying on them.
- **No APM/infra metrics collector** — `GET /api/monitoring?type=metrics` reports real DB-derived counts (active agents, workflows/hour) but system-level metrics (CPU, latency percentiles) stay at 0 rather than being faked.
- **Idempotency is check-then-act** — duplicate non-idempotent tool calls are suppressed via `AuditLog` lookup (24 h window), but two runs racing on the identical call within milliseconds could both execute. Needs a unique ledger or Redis reservation. **Persistent agent memory is not implemented** (`contract.memory.mode` only accepts `none`).
- **Dependency audit (2026-10-10): 21 findings remain, all needing major upgrades** — Next.js 14.2.35 is the last 14.x release and still has advisories fixed only in 15.5.24+, including two critical image-optimizer/Windows RCEs. The image optimizer is disabled (`images.unoptimized: true` in `apps/web/next.config.js`, verified to return 404) because nothing uses `next/image`; keep it that way until upgrading to Next 15.5.x (React 19). The rest are build/lint-time only (tailwindcss 3, typescript-eslint 6, eslint-config-next) or not reachable (googleapis → uuid buffer bug).
- **Self-management never run against a real model** — the revision pipeline and manager tools are tested with a scripted fake model and smoke-tested live up to evaluation (which failed without an API key, as designed). Review the manager's first real proposals by hand before activating its schedule. Revisions are visible at `/dashboard/improvements`; no notifications yet.
- **No prompt caching** — the full system prompt (skills + knowledge) is resent on every LLM call and every loop iteration. Anthropic/OpenAI both support prompt caching at a fraction of the cost; wiring it into `packages/llm` would meaningfully cut real spend for knowledge-heavy agents.

---

## Architecture

### Monorepo Structure
```
/home/elliot/Documents/ai-workforce-platform/
├── apps/
│   └── web/                          # Next.js 14 App Router
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
GOOGLE_REDIRECT_URI="http://localhost:3000/api/integrations/google/callback"
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

### ngrok (for sharing demo externally)
```bash
ngrok config add-authtoken YOUR_TOKEN   # One-time setup
setsid ngrok http 3000 --log=stdout > /tmp/ngrok.log 2>&1 &   # Use setsid to survive shell exit
# Get URL:
curl -s http://127.0.0.1:4040/api/tunnels | python3 -c "import sys,json; print(json.load(sys.stdin)['tunnels'][0]['public_url'])"
```

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

Tests use Node's built-in runner via `tsx --test` (files `*.test.ts` next to the source or in `src/__tests__/`): `packages/domain`, `packages/tools`, `packages/queue`, `packages/executor`, `packages/integrations`. The executor suite is DB-backed with fake LLMs/adapters — it needs Postgres and refuses to run unless `DATABASE_URL` points at a `*_test` database (`npm test` there defaults it to `TEST_DATABASE_URL` / `ai_workforce_test`; create it once and `prisma db push` to it). Packages without tests have a no-op `test` script (jest was removed — it was unused and carried ~30 audit findings). Add tests alongside source files when changing behaviour.

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
