#!/usr/bin/env node
/**
 * Publishes docs/*.md to the GitHub wiki (https://github.com/skirmish-uk/ai-workforce-platform/wiki).
 * The files in docs/ stay the source of truth: every wiki page says so, and running this again
 * replaces the pages with the current docs.
 *
 *   node scripts/publish-wiki.mjs                 # clone the wiki, update the pages, push
 *   node scripts/publish-wiki.mjs --dry-run       # write the pages to a folder and show it, no push
 *   node scripts/publish-wiki.mjs --ref main      # repository links point at this branch (default: current)
 *
 * The wiki's git repository only exists after its first page has been saved on github.com
 * (Wiki tab → "Create the first page" → Save); this script then replaces that page.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DOCS = path.join(ROOT, 'docs')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
const ref = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : git(ROOT, 'rev-parse', '--abbrev-ref', 'HEAD')
const repoUrl = git(ROOT, 'remote', 'get-url', 'origin')
const slug = /github\.com[:/](.+?)(?:\.git)?$/.exec(repoUrl)?.[1]
if (!slug) throw new Error(`origin is not a GitHub repository: ${repoUrl}`)
const blob = (file) => `https://github.com/${slug}/blob/${ref}/${file}`
const tree = (dir) => `https://github.com/${slug}/tree/${ref}/${dir}`

/** "AGENT_OPERATING_SYSTEM.md" -> "Agent-Operating-System" */
const pageName = (file) => path.basename(file, '.md').toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('-')

/** The first sentence of a paragraph, plain text, for the Home page's table. */
function firstSentence(paragraph) {
  const plain = paragraph.replace(/\s+/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  const sentence = /^.+?[.!?](?=\s|$)/.exec(plain)?.[0] ?? plain
  return sentence.length > 220 ? `${sentence.slice(0, 217).replace(/\s+\S*$/, '')}…` : sentence
}

const docs = fs.readdirSync(DOCS).filter((f) => f.endsWith('.md')).sort()
const pages = docs.map((file) => {
  const text = fs.readFileSync(path.join(DOCS, file), 'utf8')
  const title = (/^#\s+(.+)$/m.exec(text)?.[1] ?? pageName(file)).trim()
  const firstParagraph = text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('#') && !p.startsWith('>') && !p.startsWith('|') && !p.startsWith('```')) ?? ''
  return { file, name: pageName(file), title, text, summary: firstSentence(firstParagraph) }
})
const byFile = new Map(pages.map((p) => [p.file, p]))

/** Links between docs become wiki links; repository paths become GitHub links on `ref`. */
function convert(page) {
  let body = page.text
  // `docs/X.md` or `X.md` (a doc), optionally followed by " §7": a wiki link.
  body = body.replace(/`(?:docs\/)?([A-Z][A-Z_]*\.md)`/g, (whole, file) => (byFile.has(file) ? `[${byFile.get(file).title}](${byFile.get(file).name})` : whole))
  // A doc named in plain text, e.g. docs/VOICE.md "What earlier turns did" (not in code: no backtick or slash before it).
  body = body.replace(/(?<![`/\w(\[])docs\/([A-Z][A-Z_]*\.md)/g, (whole, file) => (byFile.has(file) ? `[${byFile.get(file).title}](${byFile.get(file).name})` : whole))
  // Markdown links to a doc: [text](X.md), [text](docs/X.md), [text](./X.md#anchor)
  body = body.replace(/\]\((?:\.\/|docs\/|\.\.\/docs\/)?([A-Z][A-Z_]*\.md)(#[^)]*)?\)/g, (whole, file, anchor = '') => (byFile.has(file) ? `](${byFile.get(file).name}${anchor})` : whole))
  // Repository files mentioned by name at the root (CLAUDE.md, DEMO.md, BUSINESS_MODEL.md…).
  body = body.replace(/`([A-Z][A-Z_0-9]*\.md)`/g, (whole, file) => (fs.existsSync(path.join(ROOT, file)) ? `[\`${file}\`](${blob(file)})` : whole))
  // Relative markdown links into the repository: [x](../packages/...) -> GitHub.
  body = body.replace(/\]\(\.\.\/([^)#\s]+)(#[^)]*)?\)/g, (whole, rel, anchor = '') => {
    const target = path.join(ROOT, rel)
    if (!fs.existsSync(target)) return whole
    return `](${fs.statSync(target).isDirectory() ? tree(rel) : blob(rel)}${anchor})`
  })
  const note = `> This page is generated from [\`docs/${page.file}\`](${blob(`docs/${page.file}`)}) in the repository. Edit the file there, not here: \`node scripts/publish-wiki.mjs\` replaces this page.\n\n`
  // The wiki shows the page name as the title, so the document's own H1 goes.
  return note + body.replace(/^#\s+.+\n+/, '')
}

const home = [
  '# AI Workforce Platform',
  '',
  'A multi-tenant platform for deploying AI employees: agents with contracts, playbooks and tests, approval-gated actions, teamwork and memory, voice, and a Workforce Manager that improves the team. These pages are the design and operating notes from [`docs/`](' + tree('docs') + '); start with **[Onboarding](Onboarding)**. The overall project guide is [`CLAUDE.md`](' + blob('CLAUDE.md') + ') and the demo script is [`DEMO.md`](' + blob('DEMO.md') + ').',
  '',
  '| Page | What it covers |',
  '|---|---|',
  ...pages.map((p) => `| [${p.title}](${p.name}) | ${p.summary.replace(/\|/g, '\\|')} |`),
  '',
  `_Generated from \`docs/\` on branch \`${ref}\` (${git(ROOT, 'rev-parse', '--short', 'HEAD')}) by \`scripts/publish-wiki.mjs\`._`,
  '',
].join('\n')
const sidebar = ['**[Home](Home)**', '', ...pages.map((p) => `- [${p.title}](${p.name})`), ''].join('\n')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-'))
if (dryRun) {
  for (const p of pages) fs.writeFileSync(path.join(dir, `${p.name}.md`), convert(p))
  fs.writeFileSync(path.join(dir, 'Home.md'), home)
  fs.writeFileSync(path.join(dir, '_Sidebar.md'), sidebar)
  console.log(`Wrote ${pages.length + 2} pages to ${dir} (dry run, nothing pushed).`)
  process.exit(0)
}

const wikiUrl = repoUrl.replace(/(\.git)?$/, '.wiki.git')
try {
  execFileSync('git', ['clone', '-q', wikiUrl, dir], { stdio: ['ignore', 'ignore', 'pipe'] })
} catch {
  console.error(`Could not clone ${wikiUrl}. The wiki's repository only exists after its first page is saved on github.com:\nhttps://github.com/${slug}/wiki → "Create the first page" → Save, then run this again.`)
  process.exit(1)
}
// Pages this script made before but whose doc is gone are removed; anything else on the wiki stays.
const generated = new Set([...pages.map((p) => `${p.name}.md`), 'Home.md', '_Sidebar.md'])
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.md') || generated.has(f)) continue
  if (fs.readFileSync(path.join(dir, f), 'utf8').includes('scripts/publish-wiki.mjs')) fs.rmSync(path.join(dir, f))
}
for (const p of pages) fs.writeFileSync(path.join(dir, `${p.name}.md`), convert(p))
fs.writeFileSync(path.join(dir, 'Home.md'), home)
fs.writeFileSync(path.join(dir, '_Sidebar.md'), sidebar)
git(dir, 'add', '-A')
if (!git(dir, 'status', '--porcelain')) {
  console.log('The wiki is already up to date.')
  process.exit(0)
}
// The clone doesn't inherit this repository's local identity (user.name/email in .git/config).
const identity = ['user.name', 'user.email'].flatMap((k) => ['-c', `${k}=${git(ROOT, 'config', k)}`])
git(dir, ...identity, 'commit', '-q', '-m', `Update from docs/ (${ref} ${git(ROOT, 'rev-parse', '--short', 'HEAD')})`)
git(dir, 'push', '-q', 'origin', 'HEAD')
console.log(`Published ${pages.length} pages + Home and sidebar: https://github.com/${slug}/wiki`)
fs.rmSync(dir, { recursive: true, force: true })
