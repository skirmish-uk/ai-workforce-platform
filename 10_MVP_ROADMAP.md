# MVP Roadmap

## Milestone 0 — Repository setup

Deliver:
- chosen stack documented
- local development works
- environment variables documented
- lint/test/build works
- CI basic pipeline

## Milestone 1 — SaaS foundation

Deliver:
- auth
- tenant
- user
- roles
- database
- tenant isolation

Acceptance:
Two test tenants cannot access each other's data.

## Milestone 2 — Customer onboarding

Deliver:
- onboarding form
- business profile
- goals
- workflow selection
- knowledge upload
- integration checklist

## Milestone 3 — Agent registry

Deliver:
- create agent
- configure role
- assign skills
- assign knowledge
- assign tools
- permissions
- status

## Milestone 4 — Skill system

Deliver:
- skill registry
- versioning
- enable/disable
- skill metadata
- evaluation cases

## Milestone 5 — Knowledge

Deliver:
- upload
- indexing
- retrieval
- tenant isolation
- citations/reference metadata

## Milestone 6 — Workflow engine

Deliver:
- triggers
- tasks
- tool calls
- approvals
- retries
- audit events

## Milestone 7 — Runtime adapter

Deliver:
- provision runtime
- deploy configuration
- health
- logs
- restart
- rollback

Start with a mocked provider if necessary, then implement the real provider.

## Milestone 8 — Integrations

Start with:
- email
- calendar
- CRM
- document storage

Use adapters so providers can change.

## Milestone 9 — Monitoring

Deliver:
- dashboard
- health
- errors
- alerts
- watchdog
- operator incident view

## Milestone 10 — Billing

Deliver:
- plans
- subscription
- invoices/status
- webhooks
- entitlement checks

## Milestone 11 — Operator console

Deliver:
- customers
- agents
- runtimes
- incidents
- requests
- approvals
- costs

## Milestone 12 — Production hardening

Deliver:
- security review
- tenant penetration tests
- backup/restore
- audit review
- load tests
- failure tests
- documentation

## MVP principle

Prefer a thin end-to-end system over isolated perfect components.

At every milestone, keep:
- build passing
- tests passing
- migrations reproducible
- local setup documented
