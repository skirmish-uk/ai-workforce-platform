# Deploying the demo (Docker behind nginx-proxy)

The persistent demo runs on a Docker host that already has **nginx-proxy + acme-companion** on the external `rproxy` network (the same pattern as the other sites on the VPS). Nothing in this stack publishes a port on the host.

```
Cloudflare → host :80/:443 → nginx-proxy ─(rproxy network, VIRTUAL_HOST)→ web:3000
                                                        internal network: web, worker, setup, postgres, redis
```

| Service | Role |
|---|---|
| `web` | Next.js (`next start`). The only service on `rproxy`; `VIRTUAL_HOST`/`LETSENCRYPT_HOST` = `$DOMAIN,www.$DOMAIN`, `VIRTUAL_PORT=3000` |
| `worker` | BullMQ workers + scheduler (`packages/queue/src/start-workers.ts`). Nothing runs without it |
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

Other commands: `logs`, `ps`, `restart`, `down`, `reset-demo` (clears demo activity, keeps agent upgrades).

## Updating

Copy the new code to the server (git pull or rsync), then `scripts/demo-deploy.sh up`. It rebuilds the image, re-runs `setup`, and restarts `web` and `worker`. Data stays in the volumes.

## Site password

`SITE_PASSWORD` puts HTTP Basic auth in front of the whole app (`apps/web/src/middleware.ts`). Only `/api/health` and the icons stay open. Keep it set on any public deployment: the demo logins are public in the repo and agents spend real API credit.

## Approval emails

Off until `SMTP_HOST` and `EMAIL_FROM` are set in `.env.production` (any SMTP provider: SendGrid, Postmark, SES, Zoho…). Then run `scripts/demo-deploy.sh restart`. The worker emails approvers within a minute of an agent asking. The seeded demo users are `@demo-agency.local` and are never mailed. To receive the emails, give an admin user a real address, or add one to the tenant's `settings.notifications.approvalRecipients`. Details: `docs/AGENT_OPERATING_SYSTEM.md` §7.

## Cloudflare

- **SSL/TLS mode: Full (strict)** once the Let's Encrypt certificate exists. Until then, use **Full**.
- acme-companion validates over HTTP (`/.well-known/acme-challenge/`). If certificate issuance fails while the domain is proxied with "Always Use HTTPS" on, turn that setting off until the certificate is issued, or use a Cloudflare Origin Certificate instead.
- Google sign-in (`docs/GOOGLE_CONNECT.md`): add `https://$DOMAIN/api/integrations/google/callback` as an authorised redirect URI.

## Notes

- One image serves web, worker and setup (`Dockerfile`, ~2 GB: dev dependencies stay because the worker runs TypeScript through `tsx`).
- Secrets are never baked into the image (`.dockerignore` excludes every `.env*` except the example); containers get them from `.env.production` at runtime.
- Backups: `docker compose … exec postgres pg_dump -U postgres ai_workforce > backup.sql`. There are no automatic backups yet (launch plan task "Backups, error tracking, uptime alerts").
