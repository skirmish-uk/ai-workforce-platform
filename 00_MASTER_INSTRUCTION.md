# AI Workforce Platform — Master Build Instruction

## Mission

Build a production-ready SaaS + managed-service platform for deploying highly customised AI agents ("AI employees") for businesses.

The customer should not need to understand models, tokens, infrastructure, agent runtimes, authentication, monitoring, or maintenance. They should experience a simple product: their AI employee is configured around their business, performs useful work, reports status, and continuously improves.

This is NOT a generic chatbot product and NOT a marketplace of generic prompts.

The core commercial proposition is:

> We deploy and manage a tailored AI employee for your business, connected to your systems and trained on your workflows, for a recurring monthly fee.

## Important product principle

Each customer needs a genuinely tailored agent. However, the platform must maximise reuse:

- shared platform infrastructure
- reusable agent architecture
- reusable skills
- reusable integrations
- reusable evaluation framework
- customer-specific knowledge
- customer-specific rules
- customer-specific workflows
- customer-specific permissions
- customer-specific integrations

Target roughly 70–90% reusable platform capability and 10–30% customer-specific configuration where practical.

Do not build every customer as a completely bespoke codebase.

## Initial target

Start with a flexible platform capable of serving:
- marketing agencies
- law firms
- insurance agencies
- manufacturers
- wholesalers
- real estate agencies

Do not hard-code the product to one vertical. Build the data model so vertical-specific templates/skills can be added later.

Avoid healthcare and finance as initial verticals because of regulatory complexity.

## Core commercial model

- setup/onboarding fee: configurable
- recurring monthly subscription: configurable
- plans should support a managed-service model rather than token/credit pricing
- the customer buys outcomes and an operational AI employee, not raw model usage
- internal cost controls must exist even if the external offer feels simple

Do NOT expose token counts as the primary customer-facing pricing concept.

## Required product areas

1. Public marketing website
2. Lead capture / demo booking
3. Customer onboarding
4. Customer workspace
5. Agent dashboard
6. Agent configuration
7. Business knowledge base
8. Skills library
9. Workflow builder
10. Integrations
11. Permissions
12. Approval policies
13. Agent activity/audit log
14. Monitoring/health
15. Errors/incidents
16. Requests/change queue
17. Usage/cost controls
18. Billing/subscriptions
19. Admin/operator console
20. Agent deployment lifecycle
21. Evaluation/testing
22. Documentation/help
23. Security controls
24. Multi-tenant isolation

## Build philosophy

Use an "agent builds agents" workflow where useful, but do not make autonomous changes to production without explicit policy gates.

Agents can:
- inspect documentation
- propose changes
- write code/configuration
- run tests
- create deployment plans
- prepare changes for approval

Production changes should be governed by:
- permissions
- audit logs
- tests
- approval policies
- rollback capability

## Definition of done

The system is not considered complete when a demo agent works.

It is complete when:
- a new customer can be onboarded
- a customer can provide business context
- a tailored agent can be configured
- integrations can be connected securely
- permissions can be defined
- the agent can perform approved actions
- activity is observable
- failures generate alerts
- changes are auditable
- production configuration can be rolled back
- the operator can manage many customers from one console
- customer data is isolated
- billing can be managed
- the system can support multiple agent types and models

## Build order

Phase 1: foundation
Phase 2: authentication + tenancy
Phase 3: customer onboarding
Phase 4: agent/skill/knowledge system
Phase 5: integrations and permissions
Phase 6: execution runtime
Phase 7: monitoring/evaluations
Phase 8: operator console
Phase 9: billing
Phase 10: polished marketing site
Phase 11: security hardening
Phase 12: deployment/documentation

Do not attempt to build everything in one giant implementation. Work in small vertical slices and keep the app runnable after every milestone.

## Critical instruction to OpenCode

Before coding:
1. inspect this entire repository
2. inspect all files in /docs
3. create a technical implementation plan
4. identify assumptions
5. identify security risks
6. identify missing decisions
7. then implement Phase 1

Do not invent unsupported product requirements when a document is silent. Put uncertain decisions in docs/OPEN_QUESTIONS.md.

When you make a material architecture decision, document it in docs/DECISIONS.md.
