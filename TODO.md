# Things only you can do

Written 27 Oct 2026. Everything here needs your accounts, your money, your judgement or another person. Claude can do the code side of each one once you've done your part (noted under **Then**). Progress on the bigger items is also tracked in the launch plan: https://claude.ai/artifact/A3TaaXNL9CHNKnF8mwXKhB

## Before the showcase (30 Oct) and the dry runs (1 and 4 Nov)

- [ ] **Turn on alerts.** Pick an ntfy topic (e.g. `https://ntfy.sh/<something-long-and-random>`), install the ntfy app and subscribe to it, then add `ALERT_WEBHOOK_URL=<that url>` to `/srv/demo/.env.production` and run `scripts/demo-deploy.sh restart`. A Slack or Discord webhook works too. Until then, "site down", "backup missed" and "new server error" alerts only go to the server logs.
- [ ] **Add an outside uptime check** (free tier on UptimeRobot or Better Stack) on `https://khkewhglkw.site/api/health`. Give it the site's Basic auth login (`demo` + the site password). The built-in monitor runs on the same server, so it can't tell you when the whole server is down.
- [ ] **Listen to Ava on a real microphone** at least once (Talk panel on her agent page): greeting, a question, interrupting her, hanging up.
- [ ] **Rehearse the full showcase twice, timed** (launch plan `w5-rehearse`), using the in-app Demo guide, with a plan for a slow approval email. Run `npm run demo:reset` on the server before each one (`scripts/demo-deploy.sh reset-demo`).
- [ ] **Re-record the self-repair fallback video with a voice-over.** `marketing/recordings/self-repair-fallback.mp4` is still the old silent one.
- [ ] **Align `/demo` with BUSINESS_MODEL.md** (launch plan `w2-deck`): AUD pricing, target markets, margins. Cut anything you can't back up.
- [ ] **Write the demo story** (`w1-script`): one agency, one week.
- [ ] **Merge PR #1 into `main`** when you're happy with it. CI is green. (Ultrareview refused the whole branch because it is too big, 282 files and 45k lines. To review just the latest work, run `/ultrareview <base>` with a recent commit or a branch made from one.)

## Accounts and providers (each one unlocks a feature that is already built)

- [ ] **Business domain and mailbox** (`w1-domain`): domain, Zoho Mail Lite, MX/SPF/DKIM/DMARC records.
  **Then:** the email connector for any mailbox (IMAP/SMTP, task 5) can be tested against it.
- [ ] **SMTP provider** (Zoho, Postmark, SES…): put `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `EMAIL_FROM` in `.env.production`.
  **Then:** approval and "agent did something" emails switch on. Give an admin user a real address, because the demo users are never mailed.
- [ ] **Google Cloud project in testing mode** (`w3-gcp`): Gmail and Calendar APIs, consent screen, your test accounts as test users. Add `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`. The steps are in `docs/GOOGLE_CONNECT.md`.
  **Then:** Claude runs the live email test (`w3-gmail`): send, receive and threaded reply through approvals.
- [ ] **Test accounts** (`w3-accounts`): a test Gmail/Workspace mailbox and a HubSpot developer test portal (plus a HubSpot app for `HUBSPOT_CLIENT_ID`/`SECRET`).
  **Then:** realistic demo data goes into them (`w5-data`), and the HubSpot adapter gets its first real run.
- [ ] **Submit Google OAuth verification** (`w7-google`) once the OAuth app and a public privacy policy exist. It takes weeks.
- [ ] **Stripe:** test keys first, then live keys and AUD prices (`w7-stripe`).
  **Then:** one real subscription end to end, then refund it.
- [ ] **Off-server backup storage:** an S3-compatible bucket (Backblaze B2, Cloudflare R2…) and an access key.
  **Then:** nightly backups get copied off the VPS. Today they only live on the VPS (14 days, restore-tested).
- [ ] **Cartesia plan** with enough characters for the demos and pilot. Live is capped at 200k characters a month platform-wide and 150k for the demo tenant.
- [ ] **Twilio number**, only when you want the AI Receptionist phone prototype (`v-reception`).

## Business (people outside the team, start early)

- [ ] **Company setup** (`w6-company`): Pty Ltd and ABN, business bank, Stripe Australia account.
- [ ] **Lawyer** (`w7-legal` → `w7-legal-final`): privacy policy, terms and DPA under the Australian Privacy Principles, published on the site. Include voice: AI disclosure, call-recording consent by state, transcripts (`v-legal`).
- [ ] **Insurance** (`w7-insurance` → `w7-insurance-bound`): professional indemnity and cyber quotes, then cover in place.
- [ ] **Design partners** (`w7-partners` → `w7-partners-signed`): outreach to 2–3 agencies; sign #1 with goals, a time-saved metric and a weekly feedback call, before the pilot on 9 Nov.

## Decisions for you (Claude won't do these on its own)

- [ ] **Morgan's weekly review schedule** is seeded *inactive*. Turn it on only after you've read a few of his proposals by hand.
- [ ] **Raising any agent's autonomy** is always your click in Approvals. Sarah and Iris went to `limited` on 27 Oct; Casey is still at `recommend`.
- [ ] **Go-ahead for the next build items:** task 5 (IMAP/SMTP email connector) and task 6 (dry runs on 1 and 4 Nov).
