# AI Workforce Platform - Business Model & Operations Guide

> **Version**: 1.0  
> **Last Updated**: August 2026  
> **Status**: Production Ready

---

## Executive Summary

The **AI Workforce Platform** is a multi-tenant SaaS platform that enables businesses to deploy, manage, and scale custom AI agents ("AI employees") for specialized business functions. The platform handles the full lifecycle: agent creation, skill development, knowledge management, workflow orchestration, third-party integrations, billing, monitoring, and multi-tenant administration.

**Core Value Proposition**: *"Deploy highly customized AI employees in hours, not months. 70-90% reusable platform capability, 10-30% customer-specific configuration."*

---

## 1. Business Model

### 1.1 Target Market

| Vertical | Use Cases | Pain Points Addressed |
|----------|-----------|----------------------|
| **Marketing Agencies** | Lead qualification, content generation, campaign management, social media automation | Manual lead scoring, content bottlenecks, reporting overhead |
| **Law Firms** | Contract review, legal research, document drafting, compliance monitoring | Billable hour pressure, document review costs, compliance risk |
| **Insurance Agencies** | Claims processing, policy comparison, customer onboarding, risk assessment | Manual claims triage, policy matching errors, slow onboarding |
| **Manufacturers** | Quality control, predictive maintenance, supply chain optimization, safety compliance | Downtime costs, quality escapes, regulatory compliance |
| **Wholesalers** | Order processing, inventory optimization, customer support, pricing optimization | Manual order entry, stockouts, margin erosion |
| **Real Estate Agencies** | Lead qualification, property matching, document preparation, market analysis | Lead response time, paperwork burden, market data fragmentation |

### 1.2 Revenue Model

#### Subscription Tiers (Monthly/Annual)

| Tier | Monthly | Annual | Target | Key Limits |
|------|---------|--------|--------|------------|
| **Starter** | $299/mo | $2,990/yr ($250/mo) | Small teams (1-5 agents) | 5 agents, 10 skills, 100 knowledge docs, 1k workflow runs/mo |
| **Growth** | $799/mo | $7,990/yr ($666/mo) | Growing teams (5-20 agents) | 20 agents, 50 skills, 1k knowledge docs, 10k workflow runs/mo |
| **Enterprise** | $2,499/mo | $24,990/yr ($2,083/mo) | Large orgs (20+ agents) | Unlimited agents, skills, knowledge, workflow runs + SSO, audit logs, dedicated support |

#### Additional Revenue Streams

| Stream | Description | Pricing |
|--------|-------------|---------|
| **Per-Agent Overage** | Additional agents beyond tier limit | $50/agent/mo |
| **Premium Skills** | Pre-built industry skill packs (legal, insurance, marketing) | $99-499/skill pack |
| **Professional Services** | Custom agent development, onboarding, training | $200/hr |
| **Premium Integrations** | Enterprise connectors (Salesforce, SAP, Oracle) | $199/mo each |
| **Dedicated Infrastructure** | Single-tenant deployment, custom SLAs | Custom pricing |

#### Revenue Projections (Year 1)

| Metric | Conservative | Target | Stretch |
|--------|-------------|--------|---------|
| **Customers** | 50 | 100 | 200 |
| **Avg. Contract Value** | $8,400/yr | $12,000/yr | $18,000/yr |
| **ARR** | $420k | $1.2M | $3.6M |
| **Gross Margin** | 78% | 82% | 85% |

### 1.3 Unit Economics

| Metric | Value | Notes |
|--------|-------|-------|
| **CAC** | $2,500 | Content marketing, partnerships, outbound |
| **LTV** | $48,000 | 4-year avg. retention, expansion revenue |
| **LTV:CAC** | 19:1 | Healthy SaaS benchmark >3:1 |
| **Payback Period** | 3.5 months | <12 months is excellent |
| **Net Revenue Retention** | 115% | Expansion > churn |
| **Churn Rate** | 5% annually | Industry avg: 5-7% |

---

## 2. Platform Architecture

### 2.1 Technology Stack

| Layer | Technology | Version | Purpose |
|-------|------------|---------|---------|
| **Frontend** | Next.js 14 (App Router) | 14.1.0 | React framework, SSR/SSG |
| **Language** | TypeScript | 5.4.0 | Type safety |
| **Styling** | Tailwind CSS | 3.4.0 | Utility-first CSS |
| **Database** | PostgreSQL | 15+ | Primary data store |
| **ORM** | Prisma | 5.22.0 | Type-safe database access |
| **Auth** | NextAuth.js | 4.24.0 | Authentication |
| **Queue** | BullMQ + Redis | 5.0.0 | Background jobs |
| **Payments** | Stripe | Latest | Subscriptions, billing |
| **File Storage** | MinIO (S3-compatible) | Latest | Document storage |
| **Monorepo** | Turborepo | 2.10.0 | Build orchestration |
| **Container** | Docker + Docker Compose | Latest | Local dev, deployment |

### 2.2 Monorepo Structure

```
ai_workforce_opencode_blueprint/
├── apps/
│   └── web/                    # Next.js application
│       ├── src/
│       │   ├── app/            # App Router pages
│       │   │   ├── (dashboard)/     # Customer dashboard (route group)
│       │   │   ├── operator/        # Operator console
│       │   │   ├── api/             # API routes
│       │   │   ├── auth/            # Auth pages
│       │   │   └── layout.tsx       # Root layout
│       │   ├── components/          # React components
│       │   └── lib/                 # Utilities
├── packages/
│   ├── auth/                   # NextAuth configuration
│   ├── billing/                # Stripe integration, plans, subscriptions
│   ├── db/                     # Prisma schema, migrations
│   ├── domain/                 # RBAC, shared types
│   ├── integrations/           # Gmail, Calendar, HubSpot, Drive
│   ├── monitoring/             # Health, alerts, metrics, watchdog
│   └── ui/                     # Shared UI components
├── docker-compose.yml          # Local dev services
├── turbo.json                  # Turborepo config
└── package.json                # Root package
```

### 2.3 Multi-Tenant Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      PLATFORM LAYER                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Auth      │  │  Billing    │  │  Monitoring │         │
│  │  (NextAuth) │  │  (Stripe)   │  │  (Prometheus)│         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
       ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
       │  Tenant A   │ │  Tenant B   │ │  Tenant N   │
       │ (Isolated)  │ │ (Isolated)  │ │ (Isolated)  │
       │             │ │             │ │             │
       │ • Users     │ │ • Users     │ │ • Users     │
       │ • Agents    │ │ • Agents    │ │ • Agents    │
       │ • Skills    │ │ • Skills    │ │ • Skills    │
       │ • Knowledge │ │ • Knowledge │ │ • Knowledge │
       │ • Workflows │ │ • Workflows │ │ • Workflows │
       │ • Integrations│ • Integrations│ • Integrations│
       └─────────────┘ └─────────────┘ └─────────────┘
```

**Tenant Isolation**: Row-level security via `tenantId` on all models. Platform admins see all tenants; tenant users see only their data.

---

## 3. Core Platform Capabilities

### 3.1 Agent Management (`/dashboard/agents`)

**Purpose**: Create, configure, and deploy AI agents

**Key Features**:
- Agent CRUD with versioning
- Role/mission/system prompt configuration
- Model selection (provider + model + config)
- Status lifecycle: `DRAFT → EVALUATING → PRODUCTION → PAUSED → ARCHIVED`
- Skills attachment with enable/disable toggle
- Knowledge source attachment
- Permission policies (automatic, customer approval, prohibited)
- Deployment management with health monitoring
- Evaluation suite integration

**Agent Configuration Schema**:
```typescript
interface Agent {
  id: string
  name: string
  role: string                    // e.g., "Sales Development Representative"
  mission: string                 // High-level purpose
  systemPrompt: string            // Detailed instructions
  modelProvider: string           // "anthropic" | "openai" | "google"
  modelName: string               // e.g., "claude-3-sonnet-20240229"
  modelConfig: {                  // Temperature, maxTokens, etc.
    temperature: number
    maxTokens: number
  }
  status: AgentStatus
  version: number
  tenantId: string
}
```

### 3.2 Skill System (`/dashboard/skills`)

**Purpose**: Reusable, versioned capabilities that agents can invoke

**Key Features**:
- Skill CRUD with semantic versioning (`MAJOR.MINOR.PATCH`)
- Input/output schema validation (JSON Schema)
- Required tools declaration
- Constraints (business rules, guardrails)
- Failure handling strategies
- Evaluation cases (input → expected output)
- Metadata (category, tags, description)
- Active/inactive toggle
- Agent attachment with enable/disable

**Skill Schema**:
```typescript
interface Skill {
  name: string                    // e.g., "lead_follow_up"
  version: string                 // "1.0.0"
  description: string
  purpose: string
  instructions: string            // Step-by-step execution guide
  requiredTools: string[]         // e.g., ["crm", "email"]
  inputs: JSONSchema              // Input validation
  outputs: JSONSchema             // Output validation
  constraints: string[]           // Business rules
  failureHandling: {              // Retry, escalate, fallback
    missingData: "escalate"
    toolFailure: "retry_once_then_escalate"
    ambiguousCase: "escalate"
  }
  evaluationCases: Array<{        // Test cases
    input: any
    expected: any
  }>
  metadata: {                     // Discovery
    category: string              // "sales", "support", "ops"
    tags: string[]
  }
  tenantId: string
  isActive: boolean
}
```

### 3.3 Knowledge Base (`/dashboard/knowledge`)

**Purpose**: Document storage, indexing, and semantic retrieval

**Key Features**:
- Document upload (PDF, MD, TXT, HTML)
- Automatic chunking and embedding
- Vector similarity search
- Metadata tagging (category, tags)
- Agent attachment for RAG
- Search API with filtering

**Supported Formats**: PDF, Markdown, Text, HTML
**Chunking Strategy**: Semantic chunking with overlap
**Embedding Model**: Configurable (OpenAI, Cohere, local)

### 3.4 Workflow Engine (`/dashboard/workflows`)

**Purpose**: Visual orchestration of multi-step processes

**Key Features**:
- Visual workflow builder (nodes + edges)
- Node types: Agent task, Condition, Human approval, Delay, Transform
- Execution engine with state management
- Run history with full traceability
- Human-in-the-loop approval gates
- Retry logic with exponential backoff
- Scheduled and event-triggered runs
- Run monitoring and debugging

**Workflow Node Types**:
| Type | Description |
|------|-------------|
| `agent_task` | Invoke agent with input, get structured output |
| `condition` | Branch based on expression evaluation |
| `approval` | Human approval gate with SLA |
| `delay` | Wait for duration or until condition |
| `transform` | Data transformation (JQ, JS) |
| `parallel` | Fan-out/fan-in parallel execution |

### 3.5 Integrations (`/dashboard/integrations`)

**Purpose**: Secure third-party connectivity

| Integration | Capabilities | Auth |
|-------------|--------------|------|
| **Gmail** | Read, send, label, archive, search | OAuth 2.0 |
| **Google Calendar** | Create, read, update, delete events | OAuth 2.0 |
| **HubSpot CRM** | Contacts, deals, tickets, activities | OAuth 2.0 + API Key |
| **Google Drive** | Upload, download, search, share | OAuth 2.0 |

**Security**: Encrypted credential storage, token refresh, scope minimization

### 3.6 Billing & Subscriptions (`/dashboard/billing`)

**Stripe Integration**:
- Subscription lifecycle management
- Proration on plan changes
- Invoice generation and PDF
- Payment method management
- Webhook handling (payment success/failure, subscription events)
- Trial management

**Entitlement Enforcement**:
- Agent count limits
- Skill count limits
- Knowledge document limits
- Workflow run quotas
- API rate limits

### 3.7 Monitoring (`/dashboard/monitoring`)

**Health Checks**:
- Database connectivity
- Redis connectivity
- MinIO connectivity
- External API connectivity (Stripe, Google, HubSpot)
- Queue depth and processing latency

**Alerting**:
- Configurable thresholds
- Multi-channel notifications (Email, Slack, PagerDuty)
- Alert acknowledgment and resolution tracking
- Escalation policies

**Metrics**:
- Request latency (p50, p95, p99)
- Error rates by endpoint
- Queue throughput
- Agent deployment health
- Workflow success/failure rates

### 3.8 Operator Console (`/operator`)

**Purpose**: Platform administration for platform operators

| Page | Purpose |
|------|---------|
| `/operator` | Platform overview with KPIs |
| `/operator/tenants` | Tenant management, search, metrics |
| `/operator/agents` | Cross-tenant agent oversight |
| `/operator/runtimes` | Deployment monitoring, health, costs |
| `/operator/incidents` | Incident tracking, severity, assignment |
| `/operator/requests` | Change request queue, approvals |
| `/operator/costs` | Revenue, costs, margins by tenant |
| `/operator/settings` | Platform configuration |

**Access**: `PLATFORM_ADMIN` or `PLATFORM_OPERATOR` role only

---

## 4. Getting Started

### 4.1 Prerequisites

- **Docker** 24+ and **Docker Compose** 2.24+
- **Node.js** 20+ (via Corepack for Yarn)
- **PostgreSQL** 15+ (via Docker)
- **Redis** 7+ (via Docker)
- **MinIO** (via Docker)
- **Stripe Account** (for billing)

### 4.2 Quick Start

```bash
# 1. Clone and enter project
cd ai_workforce_opencode_blueprint

# 2. Start infrastructure
docker-compose up -d

# 3. Install dependencies
yarn install

# 4. Setup database
cd packages/db
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/ai_workforce?schema=public" npx prisma migrate deploy
npx prisma db seed

# 5. Build all packages
cd ../..
yarn build

# 6. Start development server
cd apps/web
PORT=3000 \
NEXTAUTH_SECRET="dev-secret-change-in-production" \
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/ai_workforce?schema=public" \
npm run dev
```

### 4.3 Or Use the Helper Script

```bash
# From project root
./start-dev.sh start    # Start dev server
./start-dev.sh stop     # Stop server
./start-dev.sh restart  # Restart
./start-dev.sh logs     # View logs
./start-dev.sh status   # Check status
```

### 4.4 Access Points

| Service | URL |
|---------|-----|
| **Customer Dashboard** | http://localhost:3000/dashboard |
| **Operator Console** | http://localhost:3000/operator |
| **Sign In** | http://localhost:3000/auth/signin |
| **API Base** | http://localhost:3000/api |
| **MinIO Console** | http://localhost:9001 |
| **Prisma Studio** | `yarn db:studio` |

---

## 5. User Roles & Permissions

### 5.1 Role Hierarchy

```
PLATFORM_ADMIN
    │
    ├── PLATFORM_OPERATOR
    │
    └── CUSTOMER_ADMIN (per tenant)
          │
          └── CUSTOMER_STAFF (per tenant)
```

### 5.2 Role Capabilities

| Capability | PLATFORM_ADMIN | PLATFORM_OPERATOR | CUSTOMER_ADMIN | CUSTOMER_STAFF |
|------------|----------------|-------------------|----------------|----------------|
| **Platform Settings** | ✅ | ❌ | ❌ | ❌ |
| **Tenant Management** | ✅ | ✅ (view) | ❌ | ❌ |
| **Cross-Tenant Analytics** | ✅ | ✅ | ❌ | ❌ |
| **User Management (own tenant)** | ✅ | ❌ | ✅ | ❌ |
| **Agent Management** | ✅ | ✅ | ✅ | ✅* |
| **Skill Management** | ✅ | ✅ | ✅ | ❌ |
| **Knowledge Management** | ✅ | ✅ | ✅ | ✅ |
| **Workflow Management** | ✅ | ✅ | ✅ | ✅ |
| **Integration Management** | ✅ | ✅ | ✅ | ❌ |
| **Billing/Subscription** | ✅ | ✅ | ✅ | ❌ |
| **Monitoring/Alerts** | ✅ | ✅ | ✅ | ❌ |
| **Operator Console Access** | ✅ | ✅ | ❌ | ❌ |

*Customer staff can view and use agents but not create/modify configuration

---

## 6. Demo Credentials

| Role | Email | Password | Tenant |
|------|-------|----------|--------|
| **Platform Admin** | `admin@platform.local` | `admin123` | `platform` |
| **Demo Admin** | `admin@demo-agency.local` | `demo123` | `demo-agency` |
| **Demo Staff** | `staff@demo-agency.local` | `demo123` | `demo-agency` |

---

## 7. Key Workflows

### 7.1 Customer Onboarding Flow

```
1. Sign up / Request access
2. Complete onboarding wizard (5 steps):
   ├── Business Profile (name, industry, geography)
   ├── Goals & Objectives (KPIs, success criteria)
   ├── Workflow Mapping (existing processes)
   ├── Knowledge Ingestion (documents, FAQs)
   └── Integrations (Gmail, HubSpot, etc.)
3. Platform provisions:
   ├── Tenant creation
   ├── Default skills & knowledge seeded
   ├── Demo agent created
   ├── Subscription starts (trial)
   └── First agent deployment guided
```

### 7.2 Agent Deployment Lifecycle

```
DRAFT
  │
  ▼ (configure)
EVALUATING
  │
  ├── Run evaluation suite
  ├── Review results
  └── Approve/Reject
       │
       ▼
PRODUCTION
  │
  ├── Health monitoring
  ├── Cost tracking
  ├── Performance metrics
  │
  ▼ (if issues)
PAUSED ──▶ (fix) ──▶ PRODUCTION
       │
       ▼ (end of life)
ARCHIVED
```

### 7.3 Change Request Process

```
1. Customer submits request via dashboard
2. Request enters BACKLOG
3. Platform operator reviews
4. If approved → IN_PROGRESS
5. Development → TESTING → DEPLOYED
6. Customer validates → CLOSED
   Or rejected → REJECTED
```

### 7.4 Incident Response

```
1. Alert triggered (monitoring, customer report)
2. Incident created (OPEN)
2. Triage → INVESTIGATING
3. Root cause identified → IDENTIFIED
4. Fix deployed → RESOLVED
5. Post-mortem → CLOSED
```

---

## 8. Configuration

### 8.1 Environment Variables

```bash
# apps/web/.env.local
PORT=3000
NEXTAUTH_SECRET="your-secret-key"
NEXTAUTH_URL="http://localhost:3000"
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/ai_workforce?schema=public"

# Stripe
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_PUBLISHABLE_KEY="pk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."

# Google OAuth
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."

# HubSpot
HUBSPOT_CLIENT_ID="..."
HUBSPOT_CLIENT_SECRET="..."

# Email (optional)
SMTP_HOST="smtp.sendgrid.net"
SMTP_PORT="587"
SMTP_USER="apikey"
SMTP_PASSWORD="..."

# MinIO
MINIO_ENDPOINT="localhost:9000"
MINIO_ACCESS_KEY="minioadmin"
MINIO_SECRET_KEY="minioadmin"
MINIO_BUCKET="ai-workforce"
```

### 8.2 Stripe Setup

1. Create Stripe account
2. Add products/prices for each tier:
   - Starter Monthly ($299)
   - Starter Yearly ($2,990)
   - Growth Monthly ($799)
   - Growth Yearly ($7,990)
   - Enterprise Monthly ($2,499)
   - Enterprise Yearly ($24,990)
3. Configure webhook endpoint: `https://yourdomain.com/api/billing/webhooks`
4. Events to subscribe:
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `checkout.session.completed`

---

## 9. Deployment

### 9.1 Production Checklist

- [ ] Set strong `NEXTAUTH_SECRET` (32+ chars)
- [ ] Configure production `DATABASE_URL`
- [ ] Set `NEXTAUTH_URL` to production domain
- [ ] Configure Stripe production keys
- [ ] Set up SSL/TLS (Cloudflare, Let's Encrypt)
- [ ] Configure PostgreSQL connection pooling (PgBouncer)
- [ ] Set up Redis cluster for production
- [ ] Configure MinIO with TLS and bucket policies
- [ ] Set up monitoring (Prometheus + Grafana)
- [ ] Configure log aggregation (Loki, Datadog)
- [ ] Set up CI/CD pipeline
- [ ] Configure backup strategy (daily PG dumps, point-in-time recovery)
- [ ] Load test with expected traffic
- [ ] Security audit (penetration test, dependency scan)

### 9.2 Docker Production Build

```dockerfile
# Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
```

### 9.3 Kubernetes Deployment (Helm)

```yaml
# values.yaml
replicaCount: 3
image:
  repository: your-registry/ai-workforce
  tag: latest
service:
  type: ClusterIP
  port: 3000
ingress:
  enabled: true
  host: app.yourdomain.com
  tls: true
resources:
  limits:
    cpu: 1000m
    memory: 1Gi
  requests:
    cpu: 500m
    memory: 512Mi
autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 20
```

---

## 10. Security

### 10.1 Data Protection

- **Encryption at Rest**: PostgreSQL TDE, MinIO SSE
- **Encryption in Transit**: TLS 1.3 everywhere
- **Secrets Management**: Environment variables + Docker secrets
- **PII Handling**: Minimal collection, GDPR-compliant deletion

### 10.2 Authentication & Authorization

- **NextAuth.js** with credentials + OAuth providers
- **JWT Sessions** with 30-day expiry, refresh tokens
- **RBAC** with 5 roles, tenant-scoped
- **API Keys** for service-to-service communication
- **Rate Limiting**: 100 req/min per IP, 1000 req/min per tenant

### 10.3 Compliance

- **SOC 2 Type II** readiness (audit logs, access controls)
- **GDPR**: Data export, deletion, consent management
- **HIPAA**: BAA available for enterprise (dedicated infra)
- **SOC 1**: Financial controls for billing

---

## 11. Monitoring & Operations

### 11.1 Key Metrics to Watch

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| **API Latency (p95)** | < 500ms | > 1s |
| **Error Rate** | < 0.1% | > 1% |
| **Queue Depth** | < 100 | > 1000 |
| **Deployment Health** | 100% | < 100% |
| **Subscription Health** | 100% paid | Any past_due |
| **Disk Usage** | < 70% | > 85% |

### 11.2 On-Call Runbook

| Alert | Action |
|-------|--------|
| **High API Latency** | Check queue depth, DB connections, external API latency |
| **High Error Rate** | Check logs, recent deployments, external API status |
| **Queue Backup** | Scale workers, check for stuck jobs |
| **Deployment Down** | Check logs, restart deployment, check dependencies |
| **Payment Failed** | Notify customer, retry logic, update subscription status |

---

## 12. Development Workflow

### 12.1 Local Development

```bash
# Start all services
docker-compose up -d

# Run dev server with hot reload
./start-dev.sh start

# Run tests
yarn test

# Lint
yarn lint

# Type check
yarn typecheck  # (if configured)

# Database operations
cd packages/db
npx prisma studio          # Visual DB browser
npx prisma migrate dev     # Create migration
npx prisma db push         # Push schema changes
npx prisma db seed         # Reseed data
```

### 12.2 Adding a New Feature

```bash
# 1. Create feature branch
git checkout -b feature/amazing-feature

# 2. Make changes
# - Add database schema (packages/db/prisma/schema.prisma)
# - Create API routes (apps/web/src/app/api/...)
# - Build UI components (apps/web/src/components/...)
# - Add pages (apps/web/src/app/...)

# 3. Run migrations
cd packages/db
npx prisma migrate dev --name amazing-feature

# 4. Test
yarn test
yarn lint
yarn build

# 5. Commit and PR
git add .
git commit -m "feat: amazing feature"
git push origin feature/amazing-feature
```

---

## 13. Troubleshooting

### 13.1 Common Issues

| Issue | Solution |
|-------|----------|
| **Port 3000 in use** | `lsof -ti:3000 \| xargs kill -9` |
| **DB connection failed** | Check Docker containers: `docker-compose ps` |
| **Prisma client out of sync** | `cd packages/db && npx prisma generate` |
| **NextAuth session issues** | Clear cookies, check `NEXTAUTH_SECRET` |
| **Stripe webhook failing** | Check webhook secret, verify endpoint URL |
| **Build failing** | Clear `.next` and `node_modules`, reinstall |

### 13.2 Database Reset

```bash
cd packages/db
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/ai_workforce?schema=public" \
npx prisma migrate reset --force
npx prisma db seed
```

---

## 14. Support & Resources

### 14.1 Documentation

- **API Reference**: `/api` (OpenAPI spec at `/api/openapi.json`)
- **Component Library**: Storybook at `yarn storybook`
- **Database Schema**: `packages/db/prisma/schema.prisma`

### 14.2 Support Channels

| Channel | Purpose | SLA |
|---------|---------|-----|
| **Email** | support@aiworkforce.platform | 24h |
| **Slack** | #ai-workforce-support | 4h (business hours) |
| **PagerDuty** | Critical incidents | 15 min |

### 14.3 Useful Commands

```bash
# Quick restart
./start-dev.sh restart

# View logs
./start-dev.sh logs

# Database studio
cd packages/db && npx prisma studio

# Run specific test
yarn test --filter=@ai-workforce/billing

# Check build output
cat apps/web/.next/BUILD_ID
```

---

## 15. Roadmap

### Q3 2026
- [ ] Multi-language agent support
- [ ] Advanced workflow visual editor
- [ ] Agent marketplace (public skills/templates)
- [ ] Advanced analytics dashboards

### Q4 2026
- [ ] Voice-enabled agents
- [ ] Multi-modal (image, document) processing
- [ ] Advanced RAG with graph retrieval
- [ ] White-label operator console

### 2027
- [ ] AI agent collaboration (multi-agent workflows)
- [ ] Self-improving agents (RLHF loop)
- [ ] Industry-specific templates (legal, medical, financial)
- [ ] Global multi-region deployment

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **Agent** | An AI employee with a role, mission, skills, and permissions |
| **Skill** | A reusable, versioned capability (like a function) |
| **Knowledge Base** | Document store with semantic search for RAG |
| **Workflow** | Visual orchestration of tasks, conditions, approvals |
| **Deployment** | Running instance of an agent with health monitoring |
| **Tenant** | Isolated customer environment (multi-tenancy) |
| **Entitlement** | Feature access based on subscription tier |
| **RAG** | Retrieval-Augmented Generation (knowledge + LLM) |

---

## Appendix B: File Structure Reference

```
Key Files:
├── apps/web/src/app/(dashboard)/layout.tsx      # Dashboard layout
├── apps/web/src/app/operator/layout.tsx         # Operator layout
├── apps/web/src/app/api/*/route.ts              # API routes
├── packages/db/prisma/schema.prisma             # Database schema
├── packages/billing/src/                        # Billing logic
├── packages/auth/src/index.ts                   # Auth config
├── packages/integrations/src/                   # Integrations
├── packages/monitoring/src/                     # Monitoring
├── docker-compose.yml                           # Local services
└── start-dev.sh                                 # Dev server script
```

---

*This document is a living document. Update as the platform evolves.*