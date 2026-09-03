# Security Requirements

Security is a first-class product feature.

## Threat model

Assume:
- malicious customer input
- prompt injection
- compromised integration
- stolen credential
- malicious document
- accidental cross-tenant query
- agent hallucination
- tool misuse
- runtime compromise
- supply-chain compromise

## Mandatory controls

### Tenant isolation
Every request and job must carry tenant identity.

### Authorization
Use role-based and resource-based authorization.

### Secrets
Use a secure secret store. Encrypt at rest and in transit.

### Tool permissions
Every tool action must be checked against policy.

### External actions
Support approval gates.

### Audit
Record security-relevant actions.

### Logging
Redact secrets and sensitive payloads.

### Prompt injection
Treat retrieved documents and external web content as untrusted data, not instructions.

### File uploads
Scan/validate files and restrict dangerous file types.

### Runtime
Sandbox customer agents as much as practical.

### Network
Restrict outbound access where practical.

### Web browsing
Treat external pages as untrusted.

### Model output
Validate structured outputs before execution.

### Idempotency
Prevent duplicate external actions.

### Rate limits
Apply per tenant and per integration.

### Backups
Back up customer configuration and important data.

### Deletion
Support customer data deletion and tenant offboarding.

## High-risk actions

Examples:
- sending external email
- financial transactions
- deleting records
- changing permissions
- publishing content
- legal commitments
- modifying production infrastructure

These should be approval-controlled by default.

## Security checklist before production

- [ ] tenant isolation tests
- [ ] auth tests
- [ ] permission tests
- [ ] secret redaction tests
- [ ] prompt injection tests
- [ ] cross-tenant access tests
- [ ] webhook verification
- [ ] rate limiting
- [ ] audit logging
- [ ] backup/restore
- [ ] incident response process
