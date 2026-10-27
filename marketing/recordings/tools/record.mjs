// Records the 8-step demo guide on the live site: node record.mjs <base> <outdir> [steps]
// Env SITE_PASS. Writes the video, events.json (step and wait times, wall clock ms) and the
// browser's audio (Ava's voice; the caller's lines are logged and mixed in afterwards).
// The microphone is faked: getUserMedia returns a stream that plays the caller clips on demand.
import fs from 'node:fs'
import { firefox } from 'playwright-core'
const [base, out, only] = process.argv.slice(2)
const want = only ? new Set(only.split(',')) : null
fs.mkdirSync(out, { recursive: true })
const events = []
const mark = (type, data = {}) => { events.push({ type, t: Date.now(), ...data }); console.log(new Date().toISOString().slice(11, 19), type, JSON.stringify(data).slice(0, 300)) }
const flat = (s, n = 400) => s.replace(/\s+/g, ' ').slice(0, n)
const b64 = (f) => fs.readFileSync(f).toString('base64')

const browser = await firefox.launch({
  executablePath: '/home/elliot/.cache/ms-playwright/firefox-1511/firefox/firefox',
  firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.block-webaudio': false, 'media.navigator.permission.disabled': true },
})
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: out, size: { width: 1280, height: 800 } },
  httpCredentials: { username: 'demo', password: process.env.SITE_PASS },
})
await context.addInitScript(() => {
  document.addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style')
    st.textContent = 'button.fixed.bottom-4.right-4{display:none!important}'
    document.head.appendChild(st)
  })
  const taps = new Map()
  const rec = { chunks: [], startedAt: 0, recorder: null }
  window.__rec = rec
  let mic = null
  const origConnect = AudioNode.prototype.connect
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode && (!mic || this.context !== mic.ctx)) {
      let tap = taps.get(this.context)
      if (!tap) {
        tap = this.context.createMediaStreamDestination()
        taps.set(this.context, tap)
        if (!rec.recorder) {
          rec.recorder = new MediaRecorder(tap.stream)
          rec.recorder.ondataavailable = (e) => rec.chunks.push(e.data)
          rec.recorder.start(1000)
          rec.startedAt = Date.now()
        }
      }
      origConnect.call(this, tap, ...rest)
    }
    return origConnect.call(this, dest, ...rest)
  }
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext()
    mic = { ctx, dest: ctx.createMediaStreamDestination() }
    return mic.dest.stream
  }
  window.__say = async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const buffer = await mic.ctx.decodeAudioData(bytes.buffer)
    const src = mic.ctx.createBufferSource()
    src.buffer = buffer
    origConnect.call(src, mic.dest)
    src.start()
    return { at: Date.now(), duration: buffer.duration }
  }
  window.__dump = async () => {
    if (!rec.recorder) return null
    await new Promise((r) => { rec.recorder.onstop = r; rec.recorder.stop() })
    const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType })
    const buf = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return { startedAt: rec.startedAt, mime: rec.recorder.mimeType, data: btoa(s) }
  }
})

const page = await context.newPage()
mark('video-start')
const pause = (ms = 2500) => page.waitForTimeout(ms)
const go = async (path, ready) => {
  await page.goto(`${base}${path}`)
  if (ready) await ready().catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
}

// Sign in off camera-ish (it's short), then each step.
await page.goto(`${base}/auth/signin`)
await page.fill('#email', 'admin@demo-agency.local')
await page.fill('#password', 'demo123')
await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 60000 }), page.click('button[type=submit]')])
await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
await pause(1500)
const step = async (name, fn) => {
  if (want && !want.has(name)) return
  mark('step', { name })
  await fn()
  mark('step-end', { name })
}

await step('cases', async () => {
  await go('/dashboard/cases', () => page.getByRole('button', { name: /New enquiry from the website/ }).waitFor({ timeout: 60000 }))
  await pause(3000)
  await page.getByRole('button', { name: /New enquiry from the website/ }).click()
  await pause(4000)
  mark('wait-start')
  // The case is done (for now) when nothing is queued or working any more.
  await page.waitForFunction(() => {
    const t = document.querySelector('main')?.innerText ?? ''
    return t.includes('Waiting for your approval') && !t.includes('Working on it') && !t.includes('Picked up next')
  }, null, { timeout: 300000, polling: 1000 })
  mark('wait-end')
  await pause(1500)
  const card = page.locator('main li, main article').filter({ hasText: /Sarah/ }).first()
  await card.scrollIntoViewIfNeeded().catch(() => {})
  await pause(8000)
  mark('case', { text: flat(await page.locator('main').innerText(), 1200) })
})

await step('approvals', async () => {
  await go('/dashboard/approvals', () => page.getByRole('button', { name: 'Approve and run' }).first().waitFor({ timeout: 60000 }))
  await pause(5000)
  const cards = page.locator('main article, main li').filter({ has: page.getByRole('button', { name: 'Approve and run' }) })
  const n = await cards.count()
  mark('approvals', { n, first: n ? flat(await cards.first().innerText(), 800) : '' })
  // Reject Riley's invite with a reason (it fits the reason), approve the rest.
  if (n) {
    const riley = cards.filter({ hasText: 'Meeting Scheduler' })
    const last = (await riley.count()) ? riley.first() : cards.nth(n - 1)
    await last.scrollIntoViewIfNeeded()
    await pause(2000)
    await last.locator('input[id^="reason-"]').pressSequentially('Not yet, please: we confirm times with new clients by phone first.', { delay: 25 })
    await pause(1000)
    await last.getByRole('button', { name: 'Reject' }).click()
    await pause(4000)
    for (let i = 0; i < 5; i++) {
      const b = page.getByRole('button', { name: 'Approve and run' }).first()
      if (!(await b.count())) break
      await b.scrollIntoViewIfNeeded()
      await pause(1500)
      await b.click()
      await pause(3000)
    }
  }
  await pause(2000)
})

await step('memory', async () => {
  await go('/dashboard/memory')
  await pause(6000)
  await go('/dashboard/agents/demo-assistant-1', () => page.locator('#task').waitFor({ timeout: 60000 }))
  await pause(1500)
  await page.locator('#task').scrollIntoViewIfNeeded()
  await page.locator('#task').pressSequentially('Heads up for the team: from 1 December our office hours change to 8:30am to 4:30pm.', { delay: 20 })
  await pause(800)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  mark('wait-start')
  await page.waitForFunction(() => document.body.innerText.includes('is working on it'), null, { timeout: 20000 }).catch(() => {})
  await page.waitForFunction(() => !document.body.innerText.includes('is working on it'), null, { timeout: 180000 })
  mark('wait-end')
  await pause(1000)
  const view = page.locator('section.scroll-mt-20')
  await view.scrollIntoViewIfNeeded().catch(() => {})
  await pause(6000)
  mark('ava-note', { text: flat(await view.locator('ol > li').last().innerText().catch(() => ''), 600) })
})

await step('voice', async () => {
  await go('/dashboard/agents/demo-assistant-1', () => page.getByRole('button', { name: /Start call|Call again/ }).waitFor({ timeout: 60000 }))
  const panel = page.getByRole('region', { name: /Talk to Ava/ })
  await panel.scrollIntoViewIfNeeded()
  await pause(11500)
  const status = panel.getByRole('status')
  await page.getByRole('button', { name: /Start call|Call again/ }).click()
  mark('call-start')
  await status.filter({ hasText: 'Listening' }).waitFor({ timeout: 60000 })
  await pause(1200)
  mark('say', { clip: 'ask', ...(await page.evaluate((d) => window.__say(d), b64('clips/caller-ask.wav'))) })
  await status.filter({ hasText: 'is speaking' }).waitFor({ timeout: 60000 })
  await status.filter({ hasText: 'Listening' }).waitFor({ timeout: 120000 })
  await pause(1500)
  mark('say', { clip: 'bye', ...(await page.evaluate((d) => window.__say(d), b64('clips/caller-bye.wav'))) })
  await page.getByText('ended the call').first().waitFor({ timeout: 90000 }).catch(() => mark('no-hangup'))
  mark('call-end')
  await pause(4000)
  mark('call', { text: flat(await panel.innerText(), 1500) })
  // Saved here: the next page load would reset the in-page recorder.
  const audio = await page.evaluate(() => window.__dump())
  if (audio) {
    fs.writeFileSync(`${out}/browser-audio.${audio.mime.includes('ogg') ? 'ogg' : 'webm'}`, Buffer.from(audio.data, 'base64'))
    mark('audio', { startedAt: audio.startedAt, mime: audio.mime })
  }
})

await step('improvements', async () => {
  await go('/dashboard/improvements')
  await pause(6000)
  await page.mouse.move(640, 500)
  await page.mouse.wheel(0, 500)
  await pause(5000)
  await page.mouse.wheel(0, 500)
  await pause(4000)
})

await step('onboarding', async () => {
  await go('/dashboard/onboarding', () => page.locator('#website-url').waitFor({ timeout: 60000 }))
  await page.locator('#website-url').scrollIntoViewIfNeeded()
  await pause(2500)
  await page.locator('#website-url').pressSequentially('yourbusiness.com.au', { delay: 60 })
  await pause(9000)
  await page.locator('#website-url').fill('')
  await pause(1000)
})

await step('safety', async () => {
  await go('/dashboard/team', () => page.getByRole('button', { name: 'Stop all agents' }).waitFor({ timeout: 60000 }))
  await pause(2500)
  await page.getByRole('button', { name: 'Stop all agents' }).click()
  await pause(1500)
  await page.getByRole('button', { name: 'Stop all', exact: true }).click()
  await page.getByText('Every agent is stopped').waitFor({ timeout: 10000 })
  await pause(4000)
  await page.getByRole('button', { name: 'Turn agents back on' }).click()
  await page.getByRole('button', { name: 'Stop all agents' }).waitFor({ timeout: 10000 })
  await pause(3000)
})

await step('home', async () => {
  await go('/dashboard')
  await pause(8000)
  await page.mouse.move(640, 500)
  await page.mouse.wheel(0, 450)
  await pause(9000)
  await page.mouse.wheel(0, 450)
  await pause(6000)
})

const video = page.video()
await context.close()
mark('video', { path: await video.path() })
fs.writeFileSync(`${out}/events.json`, JSON.stringify(events, null, 1))
await browser.close()
