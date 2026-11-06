# Connecting Google (Gmail and Calendar)

Agents use a business's own mailbox and calendar through **Connect Google** on **Integrations**. One Google consent screen covers Gmail and Google Calendar. Until a tenant connects, its Gmail and Calendar connections stay in **sandbox mode**: fictional data, and nothing is read or sent for real.

**Status (2026-10-13):** built and tested up to Google's token exchange, using a fake client: sign-in redirect, signed state, refusals and the error messages. It has **not** yet connected a real Google account, because the project has no Google Cloud OAuth client yet. The steps below create one.

## 1. One-time Google Cloud setup (about 15 minutes)

1. In [console.cloud.google.com](https://console.cloud.google.com), create a project (e.g. "AI Workforce - dev").
2. **APIs & Services → Library:** enable **Gmail API** and **Google Calendar API**.
3. **Google Auth Platform → Branding / Audience** (the OAuth consent screen):
   - user type **External**, publishing status **Testing**;
   - app name, support email, and the developer contact;
   - **Test users:** add every Google account you'll connect (up to 100). Only these accounts can connect while the app is in testing.
4. **Credentials → Create credentials → OAuth client ID → Web application.** Under **Authorised redirect URIs**, add every address the app runs on, exactly:
   - `http://localhost:3000/api/integrations/google/callback`
   - `https://<your-ngrok-url>/api/integrations/google/callback` when sharing a demo. The free ngrok URL changes on each restart, so update this when it does.
   - your staging or production domain later.
   - `http://127.0.0.1:<PORT>/oauth2callback` only if you also use `scripts/gmail-live-test.ts`, which runs its own loopback sign-in (the port is set in that script).
5. Copy the client ID and secret into `.env` (and the copies in `apps/web/.env` and `packages/db/.env`):
   ```bash
   GOOGLE_CLIENT_ID="…apps.googleusercontent.com"
   GOOGLE_CLIENT_SECRET="…"
   GOOGLE_REDIRECT_URI=""   # empty = $NEXTAUTH_URL/api/integrations/google/callback
   ```
   `CREDENTIALS_ENCRYPTION_KEY` must also be set: tokens are only ever stored encrypted.
6. Restart the web server **and** the worker (the worker uses the tokens).

The Integrations page shows the exact redirect URI the server expects if Google isn't configured yet.

## 2. Connecting

As a customer admin: **Integrations → Connect Google** → choose the account → allow Gmail and Calendar. You come back to the Integrations page with "Connected as you@…".

- Google shows an "unverified app" warning while the app is in testing. Continue through it with a test-user account.
- Unticking Gmail or Calendar on Google's screen connects only what was granted; the page says what was left out.
- **Disconnect** clears the stored tokens, turns the connections off and revokes the app's access at Google. Agents then report "not connected" instead of silently using fictional data. On the demo tenant, `npm run demo:reset` restores sandbox mode.

## 3. What changes for the agents

Connected Gmail and Calendar tools work on the real account. Approval rules don't change:
- reads (search the inbox, find free time) run automatically;
- sending email and creating invitations wait in **Approvals**; the agent's autonomy stage decides this, not the connection.

## 4. Limits to know before a pilot

- **Testing-mode tokens expire after 7 days.** Google limits refresh tokens for apps in "Testing" status. Expect to reconnect weekly until the app is published and verified.
- **Verification.** Gmail scopes are *restricted*. Publishing the app for customers outside your test users needs Google verification with a security assessment, which takes weeks (launch plan task "Submit Google OAuth verification"). It needs a public privacy policy first.
- **Scopes.** The app asks for full Calendar access and Gmail read/send/modify/labels (the adapters' `requiredScopes`). Trim these to what the agents actually use before applying for verification; fewer restricted scopes make review easier.
- Refreshed access tokens aren't written back. The Google client refreshes them in memory on every call, which works but costs one extra token request per run.

## 5. Security design

| Threat | Protection |
|---|---|
| A forged or replayed callback link attaching an attacker's account to your tenant | The `state` is HMAC-signed (NEXTAUTH_SECRET), holds the tenant and user who started, expires after 10 minutes, and must match a nonce in an httpOnly cookie set when the flow started. The callback also requires the same signed-in user. |
| Staff connecting company accounts | Connect and Disconnect need `integration:write` (customer admins and platform staff). |
| Token leakage | Tokens go straight from Google's token endpoint to encrypted storage (AES-256-GCM, bound to the tenant). They are never returned by any API, written to the audit log or logged. The audit log records `INTEGRATION_CONNECTED` / `INTEGRATION_DISCONNECTED` with the account email and scopes. |
| A connection that silently breaks after an hour | No refresh token, no connection: the callback refuses to store it and explains how to fix it. |

## 6. Code map

| File | Role |
|---|---|
| `packages/integrations/src/google-oauth.ts` | Services → scopes, consent URL, signed state, code exchange, granted-scope check, revoke |
| `packages/tools/src/connections.ts` | `storeOAuthConnection` (encrypt, leave sandbox) and `removeOAuthConnection` |
| `apps/web/src/app/api/integrations/google/` | `GET` status, `connect`, `callback`, `POST disconnect` |
| `apps/web/src/app/dashboard/integrations/page.tsx` | Google card, outcome messages, Sandbox badges |

Tests: `packages/integrations/src/google-oauth.test.ts` (state tampering, expiry, nonce, scopes, URL) and `packages/executor/src/__tests__/credentials-at-rest.test.ts` (storage replaces the sandbox row encrypted; Disconnect clears and deactivates it).
