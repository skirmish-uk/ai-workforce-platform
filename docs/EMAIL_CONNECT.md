# Connecting any mailbox (IMAP/SMTP)

For businesses whose email isn't Gmail: Zoho Mail, Fastmail, Yahoo, and most web hosts'
mailboxes. Agents read, search, label, file and draft email over IMAP and send over SMTP, with
the account's password or an app password. Microsoft 365 / Outlook.com are not covered (Microsoft
turned off password sign-in for IMAP; that needs its own OAuth adapter).

## 1. Connect it (Integrations page)

**Integrations → Other email → Connect a mailbox.** Pick the provider (fills in the servers),
enter the address and password, then **Test and connect**. The server signs in to IMAP and SMTP
without sending anything and stores the connection only if both work, encrypted like every other
credential (`CREDENTIALS_ENCRYPTION_KEY`, `packages/tools/src/credentials.ts`). The result says
which side failed and why ("refused the login", "couldn't connect"); the password is never logged.
Every attempt is audited as `MAILBOX_CONNECT_ATTEMPT` (account, servers, outcome), at most 10 per
business per hour. **Disconnect** deletes the stored password.

Provider notes:
- **Zoho Mail:** turn on IMAP access (Settings → Mail Accounts → IMAP). Business accounts use
  `imappro.zoho.com` / `smtppro.zoho.com` in the US data centre; other data centres have their own
  (e.g. `imappro.zoho.eu`), shown on that same settings page. Use an app password if two-step
  sign-in is on.
- **Fastmail, Yahoo:** an app password is required.
- **"Keep a copy of sent email in Sent":** most hosts don't file mail sent over SMTP; turn it off
  for one that does, or every email appears twice.

API: `GET/POST/DELETE /api/integrations/email` (status / test-and-connect / disconnect).

## 2. Move the agents onto it

The agents' tools are named after the mailbox they use: `gmail__*` or `email__*` (same actions,
same inputs). Once a mailbox is connected, the card lists the agents set up for Gmail with **Use
this mailbox for them**: a preview of each agent's renamed tools, then **Move them**
(`POST /api/integrations/email/agents { to: "email" | "gmail", apply }`,
`packages/executor/src/mailbox-switch.ts`). It renames the tools everywhere the agent refers to
them: instructions, contract (allowed tools, done checks), playbooks (instructions, required
tools, test cases), permissions (levels kept) and approval policies, as a new version of each
agent, audited `AGENT_MAILBOX_SWITCHED`. Because it is a new version, an agent at `limited` or
`expanded` asks for approval again until its tests pass on that version (Run tests on its page).

It leaves an agent alone, with the reason, when a playbook is shared with other businesses or the
agent uses a tool the other mailbox doesn't have (`email__move_email` and `email__list_folders`
have no Gmail version). **Switch back to Gmail** reverses it. Rolling an agent back to a version
from before the switch brings its old tool names back; run the switch again afterwards.

## 3. What the agents get (`packages/integrations/src/email.ts`)

| Tool | Risk | Notes |
|---|---|---|
| `email__list_emails`, `email__search_emails` | read | Gmail-style queries: `is:unread/read/starred`, `from:`, `to:`, `cc:`, `subject:`, `label:`, `in:<folder>`, `newer_than:7d`, `after:/before:YYYY/MM/DD`, plain words. Terms IMAP can't do (`has:attachment`, `-x`, `OR`) are returned as `ignoredSearchTerms`. Newest first, max 50. |
| `email__get_email` | read | Whole message as text (20,000 characters max), `messageId`/`references` for replies, attachment names. Doesn't mark it read. |
| `email__list_folders` | read | With which folder is Sent, Drafts, Archive, Junk, Trash. |
| `email__modify_labels` | write_reversible | `UNREAD`, `STARRED`, `IMPORTANT` and custom labels (IMAP keywords; spaces become `_`). Mailboxes that don't allow keywords say so, and the agent files email in folders instead. Removing `INBOX` is refused with "use move_email". |
| `email__move_email` | write_reversible | To a folder by name, or `archive`/`junk`/`trash` (the mailbox's own). The email gets a new id there. |
| `email__create_draft` | draft | Saved in Drafts, not sent. |
| `email__send_email` | external_communication | Approval-gated like `gmail__send_email`. Replies: `inReplyTo` (+ `references`) from `get_email`, so it joins the conversation. A copy is filed in Sent; failing to file it doesn't fail the send. Bcc never appears in the headers. |

Email ids are `<folder>:<uid>`, e.g. `INBOX:4521`. A sandbox Email connection (`config.sandbox`)
shows the same fictional inbox as sandbox Gmail.

Some servers only match a whole address in `from:`/`to:`; when such a search finds nothing, the
newest 500 messages matching the rest of the search are checked by sender/recipient instead.

## 4. Safety

The web server and worker connect to a host the customer typed, so:
- the host is resolved once and every address must be public (no loopback, private, link-local,
  metadata or other reserved ranges, `isBlockedAddress` in `@ai-workforce/domain`, shared with the
  website importer); the connection goes to that IP, with TLS still verified against the host name;
- only ports 993/143 (IMAP) and 465/587/2525/25 (SMTP);
- the password never crosses the wire unencrypted: implicit TLS, or STARTTLS required (not merely
  attempted);
- 15 s to connect, 30 s socket timeout, 5 MB per message read.

`EMAIL_ALLOW_LOCAL_SERVERS=true` lifts the address, port and certificate rules for a local test
server. It is ignored when `NODE_ENV=production`, so it can't be switched on in the live stack.

## 5. Testing

- `packages/integrations/src/email.test.ts`: query translation, labels, ids, ports, host checks,
  message headers (unit, no network).
- `packages/executor/src/__tests__/mailbox-switch.test.ts`: the switch (DB-backed).
- `scripts/email-live-test.ts`: 14 end-to-end checks against a real IMAP/SMTP server: a local
  GreenMail container (command in the script's header), no account needed, nothing leaves the
  machine. Covers the login test, a refused password, sending and receiving, Gmail-style search,
  reading without marking read, labels, drafts, a threaded reply with its Sent copy and no Bcc in
  the headers, header injection, moving to Archive, and the address/port rules.

Verified 27 Oct 2026: all of the above, plus the connect form and switch through the web app, and
Iris triaging a real IMAP inbox on the real model (11.6 s, $0.002). Not yet run against a real
provider's mailbox: the first real one should be the business's own Zoho account.
