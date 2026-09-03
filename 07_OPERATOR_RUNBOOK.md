# Operator Runbook

## Daily

Check:
- failed workflows
- agent health
- integration failures
- pending approvals
- customer requests
- billing failures
- cost anomalies

## Weekly

For each active customer:
- review outcomes
- review errors
- review top requested improvements
- inspect agent evaluation score
- identify opportunities for automation
- send concise customer update

## Incident severity

P0:
Security breach / cross-tenant exposure / major production outage

P1:
Critical customer workflow unavailable

P2:
Degraded functionality

P3:
Minor defect / improvement

## Incident flow

1. detect
2. contain
3. preserve evidence
4. notify appropriate parties
5. restore service
6. investigate root cause
7. add regression test
8. document
9. communicate resolution

## Watchdogs

Every production runtime should have:
- process health check
- scheduled heartbeat
- restart policy
- failure alert
- operator notification

## Customer request workflow

Customer request
-> triage
-> estimate
-> approve
-> implement
-> test
-> deploy
-> verify
-> close

## Deployment

Never deploy untested agent changes directly to production.

Use:
development -> staging -> evaluation -> approval -> production

## Rollback

Every production agent configuration should have a previous known-good version.
