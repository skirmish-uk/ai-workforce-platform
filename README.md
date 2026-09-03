# AI Workforce Platform

A production-ready SaaS + managed-service platform for deploying highly customised AI agents ("AI employees") for businesses.

## Overview

The AI Workforce Platform enables businesses to deploy tailored AI employees that:
- Know their business (knowledge, processes, terminology)
- Connect to their systems (email, CRM, calendar, documents)
- Perform real work with appropriate permissions and approvals
- Are fully managed (deployment, monitoring, improvements, security)

## Architecture

```
apps/
├── web/          # Next.js 14 frontend (customer & operator dashboards)
└── api/          # Backend API (to be implemented)

packages/
├── db/           # Prisma schema & database client
├── auth/         # NextAuth.js configuration
├── ui/           # Shared React components
├── domain/       # Core domain logic (to be implemented)
├── agents/       # Agent runtime & configuration
├── skills/       # Skill system
├── knowledge/    # Knowledge base & retrieval
├── integrations/ # Integration adapters
├── workflows/    # Workflow engine
├── billing/      # Billing & subscriptions
└── observability/# Monitoring & audit
```

## Tech Stack

- **Frontend**: Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS
- **Backend**: Next.js API Routes (initially), Node.js
- **Database**: PostgreSQL 16 with Prisma ORM
- **Auth**: NextAuth.js (Credentials + OAuth)
- **Queue**: BullMQ with Redis
- **Monorepo**: Turborepo
- **Testing**: Jest + React Testing Library
- **CI/CD**: GitHub Actions

## Getting Started

### Prerequisites

- Node.js 20+
- npm 10+
- Docker & Docker Compose (for local services)

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start local services:
   ```bash
   docker-compose up -d
   ```
4. Set up environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```
5. Generate Prisma client and run migrations:
   ```bash
   npm run db:generate
   npm run db:migrate
   ```
6. Seed the database (optional):
   ```bash
   npm run db:seed
   ```
7. Start development servers:
   ```bash
   npm run dev
   ```

### Demo Credentials

After seeding, you can sign in with:

| Role | Email | Password | Tenant |
|------|-------|----------|--------|
| Platform Admin | admin@platform.local | admin123 | (platform) |
| Demo Admin | admin@demo-agency.local | demo123 | demo-agency |
| Demo Staff | staff@demo-agency.local | demo123 | demo-agency |

## Project Structure

### Milestone 0 (Current) - Repository Setup
- [x] Monorepo with Turborepo
- [x] TypeScript configuration
- [x] ESLint + Prettier
- [x] Prisma schema with multi-tenancy
- [x] NextAuth.js authentication
- [x] Next.js 14 web app with dashboard layout
- [x] Shared UI component library
- [x] Docker Compose for local development
- [x] GitHub Actions CI pipeline

### Upcoming Milestones

1. **Milestone 1** - SaaS Foundation (Auth, Tenancy, Roles)
2. **Milestone 2** - Customer Onboarding
3. **Milestone 3** - Agent Registry
4. **Milestone 4** - Skill System
5. **Milestone 5** - Knowledge Base
6. **Milestone 6** - Workflow Engine
7. **Milestone 7** - Runtime Adapter
8. **Milestone 8** - Integrations
9. **Milestone 9** - Monitoring
10. **Milestone 10** - Billing
11. **Milestone 11** - Operator Console
12. **Milestone 12** - Production Hardening

## Commands

```bash
# Development
npm run dev              # Start all dev servers
npm run dev --filter=web # Start only web app

# Database
npm run db:generate      # Generate Prisma client
npm run db:push          # Push schema changes
npm run db:migrate       # Run migrations
npm run db:studio        # Open Prisma Studio
npm run db:seed          # Seed development data

# Code Quality
npm run lint             # Run ESLint
npm run test             # Run tests
npm run build            # Build all packages

# Docker
docker-compose up -d     # Start services
docker-compose down      # Stop services
docker-compose logs -f   # View logs
```

## Security

- Multi-tenant isolation at database, API, and runtime levels
- Encrypted secrets storage
- Audit logging for all sensitive actions
- Role-based access control (RBAC)
- Approval gates for high-risk actions
- Prompt injection protection

## License

Proprietary - All rights reserved.