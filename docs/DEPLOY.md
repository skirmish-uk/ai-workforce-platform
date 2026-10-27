# Deploying the demo (Docker behind nginx-proxy)

The persistent demo runs on a Docker host that already has **nginx-proxy + acme-companion** on the external `rproxy` network (the same pattern as the other sites on the VPS). Nothing in this stack publishes a port on the host.

```
Cloudflare → host :80/:443 → nginx-proxy ─(rproxy network, VIRTUAL_HOST)→ web:3000
                                                        internal network: web, worker, setup, postgres, redis
```

| Service | Role |
|---|---|
| `web` | Next.js (`next start`). The only service on `rproxy`; `VIRTUAL_HOST`/`LETSENCRYPT_HOST` = `$DOMAIN,www.$DOMAIN`, `VIRTUAL_PORT=3000` |
| `worker` | BullMQ workers + scheduler (`packages/queue/src/start-workers.ts`). Nothing runs without it. Can be scaled (`--scale worker=2`): only one worker at a time runs the scheduler tick (a Redis lead, `packages/queue/src/leader.ts`), handed over at the next tick when it stops, within ~2.5 min if it dies |
| `setup` | One-off on every `up`: `prisma db push` (never drops data) + the idempotent seed |
| `postgres` | `pgvector/pgvector:pg16`, volume `postgres` |
| `redis` | `redis:7-alpine` with AOF, volume `redis` (separate from any Redis on the host) |

## First deploy

On the server, in the project directory (e.g. `/srv/demo`):

```bash
cp .env.production.example .env.production && chmod 600 .env.production
# fill in DOMAIN, POSTGRES_PASSWORD, NEXTAUTH_SECRET, CREDENTIALS_ENCRYPTION_KEY, SITE_PASSWORD, API keys
scripts/demo-deploy.sh up
```

`scripts/demo-deploy.sh` wraps `docker compose -p ai-workforce-demo -f compose.prod.yml --env-file .env.production`. Always use it (or pass `--env-file .env.production` yourself): without it, compose would read `${DOMAIN}` etc. from the development `.env`.

Other commands: `logs`, `ps`, `restart` (recreates web and worker so `.env.production` edits take effect; plain `docker compose restart` keeps the old environment), `down`, `reset-demo` (clears demo activity, keeps agent upgrades), `evaluate` (every agent's test suite on the real model), and the backup commands below.

## Updating

Copy the new code to the server (git pull or rsync), then `scripts/demo-deploy.sh up`. It rebuilds the image, re-runs `setup`, and restarts `web` and `worker`. Data stays in the volumes.

## Site password

`SITE_PASSWORD` puts HTTP Basic auth in front of the whole app (`apps/web/src/middleware.ts`). Only `/api/health` and the icons stay open. Keep it set on any public deployment: the demo logins are public in the repo and agents spend real API credit.

## Approval emails

Off until `SMTP_HOST` and `EMAIL_FROM` are set in `.env.production` (any SMTP provider: SendGrid, Postmark, SES, Zoho…). Then run `scripts/demo-deploy.sh restart`. The worker emails approvers within a minute of an agent asking. The seeded demo users are `@demo-agency.local` and are never mailed. To receive the emails, give an admin user a real address, or add one to the tenant's `settings.notifications.approvalRecipients`. Details: `docs/AGENT_OPERATING_SYSTEM.md` §7.

## Backups and alerts

Three things run inside the stack (added 27 Oct; launch plan "Backups, error tracking, uptime alerts"):

- **Nightly backups** (`backup` service, `scripts/ops/backup.sh`): a custom-format `pg_dump` at `BACKUP_HOUR_UTC` (default 16 = 3 am Sydney in daylight saving), plus one on start if the newest is over 25 h old, kept `BACKUP_KEEP_DAYS` (14) in the `backups` volume. Each dump has the row counts of 13 key tables taken just before and after it (`.before`/`.after`).
  - `scripts/demo-deploy.sh restore-test` restores the newest dump into a scratch database, checks each table's count lies between those two, and drops the scratch copy. First run on the live site, 27 Oct: passed, 13/13 tables.
  - `backup-now`, `backups` (list), `backup-logs`.
  - To restore for real: stop web and worker, `docker compose … exec backup pg_restore --clean --if-exists --no-owner -d ai_workforce /backups/<file>.dump`, start them again.
  - The backups live on the same server. Copying them off it (S3, Backblaze, another machine) needs a storage account: not set up yet.
- **Uptime and backup monitor** (`monitor` service, `scripts/ops/monitor.sh`): every minute, `/api/health` (database, Redis and now the worker: the worker writes a Redis heartbeat every 30 s and is "unhealthy" after 150 s without one, because nothing runs without it) and the age of the newest backup. Alerts once when the site has failed 3 checks in a row or the newest backup is over `BACKUP_MAX_AGE_HOURS` (26) old, and once on recovery. It runs on the same server, so it can't report the server itself being down: add an outside check (UptimeRobot, Better Stack…) on `https://$DOMAIN/api/health` for that.
- **Error tracking** (`packages/monitoring/src/errors.ts`): uncaught errors in web requests (`apps/web/src/instrumentation.ts`, `onRequestError`) and failed background jobs become Incidents in the operator console (platform admin → Incidents), one per kind of error with a count and when it was last seen, secrets scrubbed; a new kind sends an alert. Errors an API route catches and turns into a 500 itself are logged, not tracked.

**Where alerts go:** `ALERT_WEBHOOK_URL` in `.env.production`, then `scripts/demo-deploy.sh up`. An ntfy topic URL (`https://ntfy.sh/<long random name>`, then subscribe to it in the ntfy phone app; no account), a Slack incoming webhook or a Discord webhook. Empty: alerts are only logged (`backup-logs`).

## Cloudflare

- **SSL/TLS mode: Full (strict)** once the Let's Encrypt certificate exists. Until then, use **Full**.
- acme-companion validates over HTTP (`/.well-known/acme-challenge/`). If certificate issuance fails while the domain is proxied with "Always Use HTTPS" on, turn that setting off until the certificate is issued, or use a Cloudflare Origin Certificate instead.
- Google sign-in (`docs/GOOGLE_CONNECT.md`): add `https://$DOMAIN/api/integrations/google/callback` as an authorised redirect URI.

## Notes

- One image serves web, worker and setup (`Dockerfile`, ~2 GB: dev dependencies stay because the worker runs TypeScript through `tsx`).
- Secrets are never baked into the image (`.dockerignore` excludes every `.env*` except the example); containers get them from `.env.production` at runtime.
- Backups: see "Backups and alerts" above.
