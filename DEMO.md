# AI Workforce Platform - Demo Guide

## Quick Start Demo (5 minutes)

### 1. Start the Platform
```bash
cd ai_workforce_opencode_blueprint
./start-dev.sh start
```
Wait for "Server ready at http://127.0.0.1:3000"

### 2. Open the Demo
Open **http://127.0.0.1:3000** in your browser

---

## Demo Scenarios

### Scenario 1: Platform Admin - Full Platform Overview (2 min)

**Login**: `admin@platform.local` / `admin123` (tenant: `platform`)

**What to See**:
1. **Dashboard** - Platform-level metrics across all tenants
2. **Operator Console** → `/operator` - Platform operations view
   - **Tenants** - All 2 tenants (platform + demo-agency) with revenue, agent counts
   - **Agents** - Cross-tenant agent inventory with status
   - **Runtimes** - Live deployment health, uptime, costs
   - **Incidents** - Platform-wide incident tracking
   - **Requests** - Change request queue
   - **Costs** - Revenue vs infrastructure costs
3. **Settings** → Platform configuration

### Scenario 2: Demo Agency Admin - Customer Experience (3 min)

**Login**: `admin@demo-agency.local` / `demo123` (tenant: `demo-agency`)

**What to See**:
1. **Dashboard** - Your agency's metrics (1 active agent, 2 skills, 3 knowledge docs)
2. **Agents** → "Sarah - Sales Assistant" (DRAFT status)
   - Click to configure: role, mission, system prompt, model
   - Skills tab: 2 skills attached (lead_follow_up, email_triage)
   - Knowledge tab: 3 docs attached
   - Permissions: email_send, crm_write, calendar_create
3. **Skills** - 2 pre-built skills with evaluation cases
   - `lead_follow_up` v1.0.0 - Lead qualification workflow
   - `email_triage` v1.0.0 - Email classification
4. **Knowledge** - 3 indexed documents
   - Company Overview, Ideal Customer Profile, Pricing Guidelines
5. **Workflows** - Visual builder (create new workflow)
6. **Integrations** - Gmail & HubSpot configured (OAuth ready)
7. **Billing** - Growth plan active, subscription details
8. **Onboarding** - 5-step wizard (profile, goals, workflows, knowledge, integrations)

### Scenario 3: Demo Staff - Day-to-Day Usage (1 min)

**Login**: `staff@demo-agency.local` / `demo123` (tenant: `demo-agency`)

**What to See**:
- Same dashboard but read-only for configuration
- Can view agents, skills, knowledge
- Can trigger workflows
- Cannot modify agent configuration

---

## API Demo (Postman/curl)

### 1. Login as Platform Admin
```bash
curl -X POST http://127.0.0.1:3000/api/auth/callback/credentials \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "email=admin@platform.local&password=admin123&tenantSlug=platform" \
  -c cookies.txt
```

### 2. Get Platform Stats (Operator)
```bash
curl -b cookies.txt http://127.0.0.1:3000/api/operator/stats
```

### 3. List All Tenants (Operator)
```bash
curl -b cookies.txt http://127.0.0.1:3000/api/operator/tenants
```

### 4. Login as Demo Agency
```bash
curl -X POST http://127.0.0.1:3000/api/auth/callback/credentials \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "email=admin@demo-agency.local&password=demo123&tenantSlug=demo-agency" \
  -c demo_cookies.txt
```

### 5. List Agents (Customer)
```bash
curl -b demo_cookies.txt http://127.0.0.1:3000/api/agents
```

### 6. Create New Agent
```bash
curl -b demo_cookies.txt -X POST http://127.0.0.1:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Support Bot",
    "role": "Customer Support Agent",
    "mission": "Handle tier-1 support tickets",
    "systemPrompt": "You are a helpful support agent...",
    "modelProvider": "anthropic",
    "modelName": "claude-3-sonnet-20240229",
    "modelConfig": {"temperature": 0.3, "maxTokens": 4096}
  }'
```

---

## Key Features to Highlight

| Feature | Where to Find | What to Show |
|---------|---------------|--------------|
| **Multi-tenancy** | `/operator/tenants` | Platform admin sees all; customer sees only their tenant |
| **Agent Config** | `/dashboard/agents/[id]` | Role, mission, prompt, model, skills, knowledge, permissions |
| **Skill Versioning** | `/dashboard/skills/[id]` | Semantic versioning, evaluation cases, constraints |
| **Knowledge RAG** | `/dashboard/knowledge` | Upload → chunk → embed → search |
| **Visual Workflows** | `/dashboard/workflows` | Drag-drop builder with 6 node types |
| **Integrations OAuth** | `/dashboard/integrations` | Gmail, Calendar, HubSpot, Drive |
| **Subscription Mgmt** | `/dashboard/billing` | Plans, subscriptions, invoices |
| **Platform Ops** | `/operator/*` | Tenant mgmt, runtime monitoring, incidents, costs |

---

## Demo Data Included

| Entity | Count | Details |
|--------|-------|---------|
| **Tenants** | 2 | `platform` (admin), `demo-agency` (customer) |
| **Users** | 3 | Platform admin, demo admin, demo staff |
| **Agents** | 6 | Sarah (sales), Morgan (manager / front desk), Ava (client questions, voice), Riley (meeting scheduler), Iris (inbox triage), Casey (CRM hygiene) |
| **Skills** | 7 | `lead_follow_up`, `email_triage`, `answer_client_questions`, `schedule_meeting`, `inbox_triage`, `crm_hygiene` (+ any versions made by revisions) |
| **Knowledge Docs** | 4 | Company overview, ICP, pricing, client FAQ |
| **Integrations** | 3 | Gmail, HubSpot, Google Calendar, all in sandbox mode (fictional data, nothing sent) |
| **Subscription** | 1 | Growth plan, ACTIVE |

### The showcase team

| Agent | Starts at | Try |
|---|---|---|
| Riley - Meeting Scheduler | approval_gated: every invite waits in Approvals | "Book a 30-minute discovery call with Maria Gonzalez (maria@cloudnine-analytics.example) tomorrow at 10am" |
| Iris - Inbox Triage | recommend: reports categories and labels, changes nothing | "Triage my unread inbox" |
| Casey - CRM Hygiene | recommend: reports problems and fixes, changes nothing | "Run a CRM hygiene check" (finds the duplicate Tom Lee record) |

All three are also reachable through Morgan's "Ask the team". Their test suites (4, 3 and 3 cases) passed against `claude-haiku-5-5` on 13 Oct 2026, and again on 18 Oct (`npx tsx scripts/run-evals.ts --all`).

**Ava** (client questions, voice) speaks with Cartesia's Australian "Bronte" voice and runs on `claude-haiku-5-5`. Besides answering from the documents she can check the calendar's free time and offer slots ("Tuesday at 10am or Wednesday at 2pm"); she never books, and says a person will confirm. Try in the Talk panel: "What are your opening hours?", "Could I come in for a chat this week?", "How much is the Growth package?".

### Self-repair (staged)

**Jordan - Website Enquiries** carries a deliberate flaw: its playbook predates the agency's rule that first replies never quote prices, so every draft reply lists the price list. To stage it, at least 10 minutes before the moment and with the worker running:

```bash
npm run demo:reset           # puts Jordan's flaw back (also clears earlier rehearsals)
npm run demo:stage-repair    # Jordan answers 3 enquiries; the admin rejects each draft:
                             # "We don't quote prices in a first reply..."   (~$0.002)
# on the server: scripts/demo-deploy.sh reset-demo && scripts/demo-deploy.sh stage-repair
```

Three rejected approvals out of three crosses the review threshold. On the next 10-minute check the scheduler starts Morgan's automatic repair review; to start it on cue instead, click **Review the team now** on the Team page. Then show:
1. Team page: Jordan "needs attention", Morgan's report.
2. Improvements page: Morgan's proposed playbook change, with a new test case that reproduces the rejected drafts, the evaluation results and the replay, then promotion as Jordan v2.
3. Ask Jordan to answer a new enquiry: the draft offers a call and has no prices.
4. Roll back on the Improvements page (one click), and Jordan is v1 again.

The model can take a different path (for example fix a different detail, or ask a person first), so keep a recording of a good rehearsal as a fallback.

---

## Reset Demo Data

Before every demo, from the repo root:

```bash
npm run demo:reset              # clear runs, approvals, audit trail and anything created during demos;
                                # agents keep their tested upgrades (Sarah stays on her current version)
npm run demo:reset -- --dry-run # show what would be removed first
npm run demo:reset -- --full    # delete the demo tenant and reseed from scratch (agents back to v1,
                                # knowledge re-embedded if OPENAI_API_KEY is set)
```

It only touches the `demo-agency` tenant and refuses to run against a non-local database. Promoted upgrades are kept, except Jordan's: Jordan always goes back to the flawed version 1 so the self-repair moment can be shown again. Restart the worker afterwards if it was running. Clearing the audit trail also resets the demo tenant's spend toward its cost cap.

---

## Demo Talking Points

### For Sales Demos
1. **"70-90% platform, 10-30% custom"** - Show how little config needed
2. **"Deploy in hours, not months"** - Onboarding wizard → deployed agent in 5 steps
3. **"Enterprise-grade from day one"** - RBAC, audit logs, monitoring, billing built-in
4. **"Operator console included"** - Your team manages platform, not customers

### For Technical Demos
1. **Type-safe end-to-end** - Prisma → API → UI
2. **Multi-tenant by default** - Row-level security, zero config
3. **Skill versioning** - Semantic versions, evaluation suites
3. **Visual workflows** - No-code builder with code escape hatches
4. **Production-ready** - Monitoring, alerting, billing, RBAC day one

---

## Files Included in Demo Package

```
ai-workforce-platform-demo.tar.gz (30MB)
├── apps/web/                    # Next.js 14 application
├── packages/
│   ├── auth/                    # NextAuth.js config
│   ├── billing/                 # Stripe integration
│   ├── db/                      # Prisma schema + migrations
│   ├── domain/                  # RBAC, shared types
│   ├── integrations/            # Gmail, Calendar, HubSpot, Drive
│   ├── monitoring/              # Health, alerts, metrics
│   └── ui/                      # Shared UI components
├── docker-compose.yml           # PostgreSQL, Redis, MinIO
├── start-dev.sh                 # Dev server manager
├── BUSINESS_MODEL.md            # Full business documentation
├── DEMO.md                      # This file
└── package.json                 # Turborepo config
```

---

## Support

- **Docs**: `BUSINESS_MODEL.md` (comprehensive)
- **API**: OpenAPI at `/api/openapi.json` (when running)
- **Database**: `yarn db:studio` for Prisma Studio
- **Logs**: `./start-dev.sh logs`

---

*Demo package version 1.0 - Ready for customer presentations*