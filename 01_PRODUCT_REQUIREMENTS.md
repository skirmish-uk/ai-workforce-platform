# Product Requirements Document

## 1. Product

Working name: AI Workforce Platform

Purpose: deploy and manage business-specific AI employees.

## 2. Personas

### Platform Operator
The company running this service.
Needs:
- see all customers
- manage deployments
- inspect health
- receive alerts
- approve changes
- manage costs
- manage subscriptions
- troubleshoot agents

### Customer Admin
Business owner/executive.
Needs:
- understand what the agent does
- add company knowledge
- approve permissions
- connect systems
- request improvements
- view results and activity
- manage users/billing

### Customer Staff
Uses the AI employee.
Needs:
- interact with agent
- see tasks/results
- approve sensitive actions
- submit requests

## 3. Customer journey

1. Visitor sees outcome-oriented offer.
2. Visitor requests demo.
3. Operator qualifies business.
4. Customer signs agreement.
5. Customer creates workspace.
6. Customer completes onboarding questionnaire.
7. Customer connects approved systems.
8. Customer uploads/imports business knowledge.
9. Operator configures agent.
10. Agent passes evaluation suite.
11. Customer approves production permissions.
12. Agent goes live.
13. Agent performs work.
14. Customer sees activity/results.
15. Monitoring detects issues.
16. Operator fixes/improves agent.
17. Customer requests additional workflows through a controlled queue.

## 4. Customer workspace

Dashboard should show:
- agent status
- key outcomes
- recent completed work
- pending approvals
- recent errors
- requested changes
- integration status
- health
- subscription status

## 5. Agent configuration

An agent consists of:
- identity/name
- system instructions
- model configuration
- skills
- business knowledge
- memory
- tools/integrations
- permissions
- approval policies
- schedules
- communication channels
- evaluation suite
- escalation rules

## 6. Skills

Skills are reusable modules that teach an agent how to perform a repeatable task.

Examples:
- email triage
- lead qualification
- CRM update
- meeting summary
- research
- document extraction
- reporting
- follow-up
- scheduling

Skills must be versioned.

A skill should include:
- name
- purpose
- instructions
- required tools
- inputs
- outputs
- constraints
- failure handling
- evaluation tests
- version

## 7. Business knowledge

Support:
- documents
- markdown
- PDFs
- structured facts
- FAQs
- SOPs
- policies
- terminology
- examples
- people/roles
- products/services

Knowledge should be scoped to a tenant/customer and never accidentally exposed cross-tenant.

## 8. Workflows

A workflow should define:
- trigger
- agent/skill
- inputs
- steps
- tools
- approvals
- output
- retry policy
- timeout
- escalation
- audit events

## 9. Permissions

Use least privilege.

Example actions:
- read email
- send email
- create calendar event
- update CRM
- create document
- delete document
- run shell command
- browse web
- access integration

High-risk actions should require approval.

## 10. Approval levels

Suggested:
- automatic
- notify
- require customer approval
- require operator approval
- prohibited

## 11. Activity

Every meaningful action should be traceable:
- who/what initiated it
- tenant
- agent
- workflow
- tool
- timestamp
- input summary
- output summary
- result
- approval
- error
- cost metadata where available

Never expose secrets in logs.

## 12. Change requests

Customers can submit:
- new skill
- new integration
- workflow change
- knowledge update
- permission request
- bug report

Requests move through:
backlog -> approved -> in progress -> testing -> deployed -> closed

Implement scope controls so "unlimited" marketing does not create unbounded engineering work.

## 13. Operator console

Must support:
- customer list
- tenant health
- agents
- deployments
- incidents
- change requests
- approvals
- integration status
- model configuration
- costs
- audit logs
- subscription status

## 14. Billing

Support:
- setup fee
- monthly plans
- optional add-ons
- subscription status
- invoices
- failed payment status
- cancellation
- plan changes

Pricing should be configurable rather than hard-coded.

## 15. Marketing positioning

Do not lead with:
"AI agents", "tokens", "MCP", "OpenCode", "Claude", etc.

Lead with:
- AI employee
- tailored to your business
- connected to your systems
- managed for you
- measurable business outcomes
- no AI expertise required

## 16. Non-functional requirements

- secure multi-tenancy
- auditability
- reliable background jobs
- retries
- idempotency
- monitoring
- backups
- rollback
- rate limiting
- encrypted secrets
- structured logging
- test coverage for critical paths
- accessible UI
- responsive UI
- clear error states
