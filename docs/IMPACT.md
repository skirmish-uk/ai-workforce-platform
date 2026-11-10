# Impact (dashboard home)

`/dashboard` shows what the AI team did and what it was worth, for today, 7 or 30 days (`GET /api/impact?days=`, `packages/executor/src/impact.ts`), from the audit trail. It refreshes every 30 s.

**What counts as a task**: a typed request and its run, a team-case task, a scheduled run, and a whole voice call (not each turn). Test runs (evaluations, replays, dry runs) and a manager's delegated sub-tasks don't count as tasks, though delegated sub-tasks' model costs are included in the cost.

| Number | How |
|---|---|
| Tasks finished | runs that ended `completed`, `partial` or `approval_required` (the work is done; a person only approves it). A call counts once if any answer was given. |
| Time saved (estimate) | each finished task × its agent's `contract.taskAssessment.manualEffortMinutes` (the time a person would take; default 10). Handed-to-a-person tasks count half. The page says it is an estimate and how it is worked out. Demo values (seed): Sarah 15, Ava 8 per call, Morgan 15, Riley 10, Iris 20, Casey 30, Jordan 12. |
| Typical time to finish | median seconds from request to answer for finished tasks other than calls; calls show the median answer time separately. |
| Cost per task | model cost (`costUsd` on run audit rows) ÷ tasks finished. |
| Getting better | memories saved in the period (by agents / by staff / lessons from rejected work), revisions promoted or rolled back (with their rationale), team cases. |
| Waiting for you | pending approvals, open hand-overs to a person, memories waiting for confirmation. |

The daily chart is one series (tasks finished per day, in the tenant's time zone) with a hover tooltip and a screen-reader table; bar colour `#0284c7` passes the dataviz palette checks on both the light and dark surfaces.
