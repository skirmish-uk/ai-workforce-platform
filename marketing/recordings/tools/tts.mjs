// Generates narrator and caller clips with OpenAI TTS: node tts.mjs <outdir>
import fs from 'node:fs'
const out = process.argv[2]
fs.mkdirSync(out, { recursive: true })
const key = fs.readFileSync('/home/elliot/Documents/ai-workforce-platform/.env', 'utf8').match(/^OPENAI_API_KEY="?([^"\n]+)/m)[1]
const lines = JSON.parse(fs.readFileSync(process.env.LINES ?? 'lines.json', 'utf8'))
const voices = {
  narrator: { voice: 'ash', instructions: 'Natural, warm Australian accent. A calm, confident product walkthrough narrator: clear, unhurried, friendly, not salesy.' },
  caller: { voice: 'coral', instructions: 'A friendly Australian small-business customer on a phone call. Casual and natural.' },
}
for (const [who, set] of Object.entries(lines)) {
  for (const [name, input] of Object.entries(set)) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', input, response_format: 'wav', ...voices[who] }),
    })
    if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`)
    fs.writeFileSync(`${out}/${who}-${name}.wav`, Buffer.from(await res.arrayBuffer()))
    console.log(who, name, input.length)
  }
}
