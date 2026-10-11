# Architecture / Product Decisions

Record material decisions here.

## Template

### YYYY-MM-DD — Decision title

Context:
Options:
Decision:
Rationale:
Trade-offs:
Revisit when:

---

### 2026-08-18 — Tech Stack Selection

Context:
Need to choose a production-ready stack for the AI Workforce Platform that supports multi-tenancy, background jobs, real-time features, and can scale.

Options:
- Next.js + TypeScript + PostgreSQL + Prisma + NextAuth.js + BullMQ/Redis (chosen)
- Remix + TypeScript + PostgreSQL + Prisma + Custom Auth + BullMQ
- Django + React + PostgreSQL + Django ORM + DRF + Celery
- NestJS + Next.js + PostgreSQL + TypeORM + Passport + BullMQ

Decision:
Use Next.js 14 (App Router) with TypeScript for the web application, PostgreSQL with Prisma ORM for data, NextAuth.js for authentication, BullMQ with Redis for background jobs, and Tailwind CSS for styling. Monorepo structure with Turborepo.

Rationale:
- Next.js App Router provides excellent DX for full-stack TypeScript
- Server Components reduce client bundle size and improve security
- NextAuth.js handles complex auth flows with built-in multi-tenancy support
- Prisma provides type-safe database access with migrations
- BullMQ is battle-tested for durable job queues
- Turborepo enables efficient monorepo builds
- Strong ecosystem and hiring pool

Trade-offs:
- Next.js API routes may need separate scaling for heavy workloads
- Redis adds infrastructure dependency
- App Router still maturing in some areas

Revisit when:
- Traffic patterns justify separating API into dedicated service
- Need for WebSocket-heavy real-time features

---

### 2026-10-10 — Agent contracts, staged autonomy and closed-loop runs

Context:
The agent executor let any AUTOMATIC permission act immediately, had no Definition of Done, run
states, idempotency or approval decisions, and nothing was tested. An implementation brief asked for
contracts, progressive trust, bounded Diagnose → Assemble → Act → Assess runs and approval gating.

Options:
- Adopt an agent framework (LangGraph etc.) — rejected: would replace a working loop and add a dependency.
- New tables for contracts/runs — rejected for now: `Agent.config` JSON + `AuditLog` already exist.
- Extend the existing executor/tools packages in place (chosen).

Decision:
Contract in `Agent.config.contract` (strict Zod schema); autonomy stage as a ceiling over
`AgentPermission`; limited/expanded autonomy gated on a passing Evaluation pinned to `Agent.version`;
default stage approval_gated; approvals persisted for every run type and executed exactly once by a
worker; run trace in `AuditLog`. Tests use Node's built-in runner via `tsx --test` (no new deps).

Rationale:
Smallest change that makes authority enforceable and observable without a rewrite or new services.

Trade-offs:
Run history lives in `AuditLog` JSON (fine at current scale, harder to query than a table);
idempotency is check-then-act; children of a manager run sequentially.

Revisit when:
Run volume makes AuditLog queries slow (add an `AgentRun` table), or concurrent duplicate side
effects are observed (add a unique idempotency ledger).

---

### 2026-10-10 — Self-improving agents via a Workforce Manager and a revision pipeline

Context:
The owner wants agents that improve themselves, build new agents and are managed by another agent,
"fully autonomous". Agents act on customers' real email, calendars and CRMs.

Options:
- Let agents edit their own definitions directly — rejected: one bad edit (or a prompt injection
  that reaches an agent) could remove its own guardrails and act on that immediately.
- Let agents generate and run code — deferred: needs per-agent sandboxing that doesn't exist, makes
  every tenant's integrations unique code to maintain, and the platform carries the liability.
- A manager agent that can only *propose*; an evaluation-gated pipeline that promotes (chosen).

Decision:
Config-only self-building (prompts, playbooks, contracts, permissions, eval cases; registered tools
only). Every proposal → `AgentRevision` → sandbox candidate → validation → evaluation → parity with
live → replay → human approval only for risk-increasing changes (owner's choice: "tests + human") →
promote as a new version → 72 h watch with automatic rollback. Hard limits enforced in code
(`workforce/invariants.ts`); self-management is opt-in per tenant; the manager has no tool that can
promote, approve, change settings or touch kill switches.

Rationale:
Gives the autonomy that is valuable (agents get better and the workforce grows without staff tuning
prompts) while keeping every change tested, reversible and auditable, and risky changes human-approved.

Trade-offs:
Gate quality depends on each agent's evaluation cases; the watch only sees failure/DoD rates;
evaluations cost model calls (bounded by the daily revision limit and tenant spend cap); no UI yet.

Revisit when:
Real-model runs show the manager's proposals are reliably good (consider widening the auto-promote
set), or customers need integrations faster than reviewed connectors ship (connector catalogue /
sandboxed code as an Enterprise add-on).
