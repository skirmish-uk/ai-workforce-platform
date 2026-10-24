# Learn from your website

Onboarding a business from its own public website. **Onboarding** page → "Learn from your website".

1. **Read** (`POST /api/onboarding/website { url }`, admins only, 10 a day per business): a `WebsiteImport` row is created and the `website-import` worker job reads the site (`packages/knowledge/src/website.ts`): the home page, then up to 9 same-site pages ranked by how much they usually say about a business (about, services, pricing, contact, FAQ, team…), as plain text (no scripts, styles, menus or cookie banners).
2. **Draft** (`packages/executor/src/onboarding.ts`, `WEBSITE_IMPORT_MODEL`, default `claude-sonnet-5-5`): the pages (up to 60,000 characters, each wrapped as untrusted data) go to the model, which replies with one JSON profile: name, summary, industry, location, customers, contact, hours, services with prices (only prices the site states), policies, FAQs, tone, 10–20 short facts, what the site doesn't say ("unknowns"), and 2–4 suggested agents. A plain JSON reply, not a tool call: with this many nested lists Sonnet 5.5 broke the tool-call format (24 Oct). One retry if it isn't JSON. About $0.11 and 40–60 s for a 10-page site.
3. **Review**: every field is editable; facts can be unticked; unknowns are listed for staff; each suggested agent links to the new-agent form, filled in (`/dashboard/agents/new?name=&role=&mission=&instructions=`).
4. **Apply** (`PUT /api/onboarding/website/[id] { action: "apply", profile, choices }`), choosing any of:
   - the business profile every agent works from (`Tenant.settings.businessContext`; ticked by default only when the business has none yet),
   - knowledge documents (about and contact, services and prices, FAQ), attached to every agent and embedded in the worker,
   - the ticked facts, as staff-confirmed notes in **What the team knows** (`docs/TEAMWORK.md`).
5. **Undo** (`{ action: "undo" }`): removes the documents and notes and restores the previous business profile.

**Safety.** The crawler runs on the server, so it only talks to public addresses: every DNS answer is checked at connect time (no loopback, private, link-local, cloud metadata or other reserved ranges, IPv4 or IPv6), redirects are followed by hand and checked the same way, only http(s) on ports 80/443, no credentials in URLs, 1.5 MB per page, 10 s per request, 10 pages. robots.txt rules for all crawlers are respected. Page text is data: the model is told to ignore anything addressed to an AI, and nothing is used before a person reviews it.

Tests: `packages/knowledge/src/website.test.ts` (address checks, HTML to text, robots.txt, crawl order), `packages/executor/src/__tests__/onboarding.test.ts` (draft, retry, apply, undo). Verified 24 Oct on basecamp.com: 10 pages, 9 plans with prices, 19 facts, 8 FAQs, 10 open questions (including the site giving four different company ages), 4 suggested agents; applied and undone in the browser.
