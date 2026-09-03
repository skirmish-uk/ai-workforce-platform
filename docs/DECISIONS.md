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
