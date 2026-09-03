# Technical Architecture

## Goal

Build a modular multi-tenant SaaS/control plane that can manage isolated customer agent runtimes.

## Conceptual architecture

Web App
  |
API / Application Layer
  |
+-----------------------------+
| Tenant / Identity           |
| Customer / Billing          |
| Agent Registry              |
| Skill Registry              |
| Knowledge Registry          |
| Workflow Engine             |
| Integration Registry        |
| Permission / Policy Engine  |
| Approval Engine             |
| Audit / Activity            |
| Monitoring / Incidents      |
| Evaluation Engine           |
+-----------------------------+
  |
Agent Runtime Adapter
  |
+------------------------------+
| Model Provider Adapter       |
| Tool/MCP Adapter             |
| Runtime/VM Adapter           |
| Channel Adapter              |
+------------------------------+
  |
Customer-isolated agent runtime

## Important architectural principle

Do not hard-code the product around one agent harness or one model.

Create interfaces/adapters so the runtime can evolve.

Example interfaces:

- AgentRuntime
- ModelProvider
- ToolProvider
- IntegrationProvider
- KnowledgeProvider
- ChannelProvider
- BillingProvider
- DeploymentProvider

The initial implementation may use one concrete provider, but the domain model should not depend on it.

## Tenancy

Every customer is a tenant.

All customer-owned entities must have tenant_id.

Never rely solely on UI filtering for tenant isolation.

Enforce isolation in:
- database queries
- service layer
- authorization
- storage
- background jobs
- logs
- runtime credentials

## Agent isolation

Prefer separate customer runtime environments where practical.

Do not share customer credentials between runtimes.

Do not put all customer secrets into a common agent filesystem.

## Secrets

Never store raw credentials in ordinary database columns.

Use a secrets manager or encrypted secret store.

Application logs must redact:
- API keys
- OAuth tokens
- passwords
- cookies
- session tokens
- private keys

## Runtime

The platform should be able to:
- provision runtime
- configure runtime
- deploy agent
- start/stop agent
- restart agent
- inspect health
- stream logs
- run health checks
- roll back configuration
- destroy runtime

## Background execution

Use a durable job queue for:
- onboarding
- document processing
- deployment
- health checks
- scheduled workflows
- evaluation
- notifications
- billing webhooks

Jobs must be:
- retryable
- idempotent
- observable

## Knowledge

Start simple.

Recommended MVP:
- tenant-scoped documents
- metadata
- chunking/indexing
- retrieval API
- citations/references where possible

Do not build an overcomplicated vector architecture until required.

## Observability

Track:
- runtime health
- workflow success/failure
- tool errors
- latency
- retries
- queue depth
- model failures
- integration failures
- deployment status

Provide customer-safe status and operator-level diagnostics separately.

## Evaluation

Each production agent must have tests.

Examples:
- expected classification
- correct tool selection
- prohibited action blocked
- correct response format
- workflow completion
- escalation on uncertainty

Maintain regression suites per agent.

## Suggested repository structure

/apps
  /web
  /api

/packages
  /domain
  /auth
  /db
  /agents
  /skills
  /knowledge
  /integrations
  /workflows
  /billing
  /observability
  /ui

/agent-runtime
/docs
/infrastructure
/scripts
/tests

If the chosen stack differs, document the reason.

## Deployment

Use separate environments:
- local
- development
- staging
- production

Never test destructive runtime changes directly against production.

## Security priority

Customer data and credentials are more important than convenience.

Any feature that allows an agent to take external actions must pass:
- authorization
- permission policy
- audit
- error handling
- approval logic where appropriate
