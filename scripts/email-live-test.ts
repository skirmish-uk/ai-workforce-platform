/**
 * End-to-end test of the IMAP/SMTP mailbox tools (packages/integrations/src/email.ts) against a
 * real mail server, through the tool registry's validation (no LLM, no cost, no database).
 *
 * Local server (nothing leaves your machine), GreenMail with two test mailboxes:
 *   docker run -d --name aiw-greenmail -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 \
 *     -Dgreenmail.users=office:office-pass@agency.test,maria:maria-pass@client.test -Dgreenmail.users.login=email' \
 *     -p 127.0.0.1:993:3993 -p 127.0.0.1:465:3465 -p 127.0.0.1:143:3143 -p 127.0.0.1:587:3025 greenmail/standalone:2.1.3
 *   EMAIL_ALLOW_LOCAL_SERVERS=true npx tsx scripts/email-live-test.ts
 *
 * Exits non-zero on the first failed check.
 */
import assert from 'node:assert/strict'
import { emailAdapter, testMailbox, resolveMailHost, type MailboxCredentials } from '@ai-workforce/integrations'
import { toolRegistry, executeToolCall } from '@ai-workforce/tools'

const HOST = process.env.EMAIL_TEST_HOST ?? '127.0.0.1'
const office: MailboxCredentials = { email: 'office@agency.test', password: 'office-pass', fromName: 'Demo Agency', imap: { host: HOST, port: 993 }, smtp: { host: HOST, port: 465 }, saveSentCopy: true }
const maria: MailboxCredentials = { ...office, email: 'maria@client.test', password: 'maria-pass', fromName: 'Maria Gonzalez' }

type Result = Record<string, any>
async function tool(name: string, input: unknown, creds: MailboxCredentials): Promise<Result> {
  const registered = toolRegistry.get(`email__${name}`)
  assert.ok(registered, `email__${name} is registered`)
  return (await executeToolCall(registered, input, creds as unknown as Record<string, unknown>)) as Result
}

let step = 0
async function check(what: string, fn: () => Promise<void>) {
  step++
  const started = Date.now()
  await fn()
  console.log(`  ok ${String(step).padStart(2)}  ${what} (${Date.now() - started} ms)`)
}

async function main() {
  if (!emailAdapter.actions.length) throw new Error('no actions')
  console.log(`Mail server ${HOST} (IMAP 993, SMTP 465)\n`)

  await check('both mailboxes log in over IMAP and SMTP', async () => {
    for (const creds of [office, maria]) {
      const r = await testMailbox(creds)
      assert.ok(r.ok, JSON.stringify(r))
    }
  })

  await check('a wrong password is reported as a refused login, without the password', async () => {
    const r = await testMailbox({ ...office, password: 'not-the-password' })
    assert.equal(r.ok, false)
    assert.match(r.imap.error ?? '', /refused the login/)
    assert.ok(!JSON.stringify(r).includes('not-the-password'))
  })

  await check('folders the agents use exist (created on a bare test server)', async () => {
    const { withImap, parseMailboxCredentials } = await import('@ai-workforce/integrations')
    await withImap(parseMailboxCredentials(office as unknown as Record<string, unknown>), async (client) => {
      const have = new Set((await client.list()).map((f) => f.path))
      for (const f of ['Sent', 'Drafts', 'Archive']) if (!have.has(f)) await client.mailboxCreate(f)
    })
    const r = await tool('list_folders', {}, office)
    const uses = Object.fromEntries(r.folders.map((f: Result) => [f.specialUse, f.path]))
    assert.equal(uses.Sent, 'Sent')
    assert.equal(uses.Drafts, 'Drafts')
  })

  const subject = `SEO proposal for CloudNine? ${Date.now()}`
  await check('a client emails the agency (SMTP send, saved to her Sent folder)', async () => {
    const r = await tool('send_email', { to: ['office@agency.test'], subject, body: 'Hi, could you send a proposal for SEO and LinkedIn ads? Budget is around $8k a month.\n\nMaria' }, maria)
    assert.deepEqual(r.accepted, ['office@agency.test'])
    assert.equal(r.savedToSent, 'no Sent folder found', 'maria has no Sent folder on the test server, and the send still counts')
    assert.match(r.messageId, /^<.+@.+>$/)
  })

  let id = ''
  await check('the agency finds it with a Gmail-style search (is:unread from:maria)', async () => {
    const r = await tool('list_emails', { query: `is:unread from:maria subject:"${subject.split(' ').slice(-1)[0]}"` }, office)
    assert.equal(r.messages.length, 1, JSON.stringify(r))
    const m = r.messages[0]
    assert.match(m.id, /^INBOX:\d+$/)
    assert.ok(m.labelIds.includes('UNREAD') && m.labelIds.includes('INBOX'))
    assert.match(m.snippet, /proposal for SEO/)
    assert.match(m.from, /Maria Gonzalez <maria@client.test>/)
    id = m.id
  })

  let original: Result = {}
  await check('reading the email gives the whole body and threading ids, and leaves it unread', async () => {
    original = await tool('get_email', { id }, office)
    assert.match(original.body, /Budget is around \$8k a month/)
    assert.match(original.messageId, /^<.+>$/)
    assert.equal(original.subject, subject)
    const again = await tool('search_emails', { query: `is:unread ${subject.split(' ').slice(-1)[0]}` }, office)
    assert.equal(again.messages.length, 1, 'still unread after reading')
  })

  await check('labels: Lead and STARRED added, UNREAD removed; custom labels are searchable', async () => {
    const r = await tool('modify_labels', { id, addLabelIds: ['Lead', 'STARRED'], removeLabelIds: ['UNREAD'] }, office)
    assert.ok(r.labelIds.includes('Lead') && r.labelIds.includes('STARRED') && !r.labelIds.includes('UNREAD'), JSON.stringify(r.labelIds))
    const byLabel = await tool('list_emails', { query: 'label:Lead' }, office)
    assert.ok(byLabel.messages.some((m: Result) => m.id === id))
  })

  await check('a Gmail-only label change (removing INBOX) is refused with what to do instead', async () => {
    await assert.rejects(tool('modify_labels', { id, removeLabelIds: ['INBOX'] }, office), /move_email/)
  })

  let draftId = ''
  await check('a reply is saved as a draft in Drafts, not sent', async () => {
    const r = await tool('create_draft', { to: ['maria@client.test'], subject: `Re: ${subject}`, body: 'Draft reply', inReplyTo: original.messageId }, office)
    assert.match(r.id, /^Drafts:\d+$/)
    draftId = r.id
    const inbox = await tool('list_emails', { query: 'Draft reply' }, maria)
    assert.equal(inbox.messages.length, 0, 'drafts are not delivered')
  })

  await check('the threaded reply is sent, lands with Maria, and a copy is kept in Sent', async () => {
    const r = await tool('send_email', { to: ['maria@client.test'], bcc: ['office@agency.test'], subject: `Re: ${subject}`, body: 'Hi Maria, thanks for getting in touch. An Account Executive will call you to talk it through.', inReplyTo: original.messageId }, office)
    assert.equal(r.savedToSent, true)
    assert.equal(r.threadId, original.messageId)
    const got = await tool('list_emails', { query: `from:office subject:"Re: SEO"` }, maria)
    const reply = await tool('get_email', { id: got.messages[0].id }, maria)
    assert.equal(reply.inReplyTo, original.messageId, 'joins the same conversation')
    assert.deepEqual(reply.references, [original.messageId])
    assert.ok(!reply.cc, 'no Cc')
    const sent = await tool('list_emails', { mailbox: 'Sent', query: 'Account Executive' }, office)
    assert.equal(sent.messages.length, 1)
    const copy = await tool('get_email', { id: sent.messages[0].id }, office)
    assert.ok(!/office@agency.test/.test(copy.to) && !('bcc' in copy), 'the Bcc is not in the saved headers')
  })

  await check('header injection in a subject is refused before anything is sent', async () => {
    await assert.rejects(tool('send_email', { to: ['maria@client.test'], subject: 'Hi\r\nBcc: everyone@client.test', body: 'x' }, office), /line breaks/)
  })

  await check('the email is filed in Archive and gets its new id there', async () => {
    const r = await tool('move_email', { id, folder: 'archive' }, office)
    assert.equal(r.folder, 'Archive')
    assert.match(r.id, /^Archive:\d+$/)
    const moved = await tool('get_email', { id: r.id }, office)
    assert.equal(moved.subject, subject)
    await assert.rejects(tool('get_email', { id }, office), /wasn't found/)
  })

  await check('a missing folder is reported with the folders that exist', async () => {
    await assert.rejects(tool('move_email', { id: draftId, folder: 'Clients/Nope' }, office), /There is no folder "Clients\/Nope"\. Folders: .*INBOX/)
  })

  await check('without EMAIL_ALLOW_LOCAL_SERVERS: private addresses and other ports are refused', async () => {
    const strict = { NODE_ENV: 'production', EMAIL_ALLOW_LOCAL_SERVERS: 'true' }
    await assert.rejects(resolveMailHost('127.0.0.1', strict), /private or reserved/)
    await assert.rejects(resolveMailHost('localhost', strict), /isn't a mail server name|private or reserved/)
    const r = await testMailbox({ ...office, imap: { host: HOST, port: 3993 } }, strict)
    assert.match(r.imap.error ?? '', /port 3993 isn't allowed/)
  })

  console.log(`\nAll ${step} checks passed.`)
}

main().catch((error) => {
  console.error('\nFAILED:', error instanceof Error ? error.stack ?? error.message : error)
  process.exit(1)
})
