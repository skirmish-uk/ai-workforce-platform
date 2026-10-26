import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BACKCHANNEL_PAUSE_MS, Resampler, asking, endSilenceMs, endsSentence, pcm16ToBase64, sameWords, shouldBackchannel, withoutBackchannels, wordCount } from './live-turn'

test('48 kHz to 24 kHz: half the samples, across block edges, values kept', () => {
  const r = new Resampler(48_000)
  const tone = (n: number, offset: number) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 440 * (i + offset)) / 48_000) * 0.5)
  const a = r.process(tone(2048, 0))
  const b = r.process(tone(2048, 2048))
  assert.equal(a.length + b.length, 2048)
  // The joined output is the same tone at 24 kHz: no jump at the block edge.
  const joined = [...a, ...b]
  for (let i = 1; i < joined.length; i++) assert.ok(Math.abs(joined[i] - joined[i - 1]) < 32767 * 0.5 * 0.13, `jump at ${i}`)
  assert.ok(Math.abs(joined[600] / 32767 - Math.sin((2 * Math.PI * 440 * 1200) / 48_000) * 0.5) < 0.05)
})

test('44.1 kHz to 24 kHz keeps the duration; samples are clipped to 16 bits', () => {
  const r = new Resampler(44_100)
  let total = 0
  for (let i = 0; i < 100; i++) total += r.process(new Float32Array(441).fill(2)).length
  assert.ok(Math.abs(total - 24_000) <= 1, String(total))
  assert.equal(new Resampler(48_000).process(new Float32Array(4).fill(2))[1], 32767)
})

test('PCM is sent little-endian, base64', () => {
  assert.equal(pcm16ToBase64(Int16Array.from([1, -2])), Buffer.from([1, 0, 0xfe, 0xff]).toString('base64'))
})

test('a pause after an unfinished thought waits longer; a finished one does not, and nothing waits less', () => {
  assert.equal(endSilenceMs('', 650), 650)
  assert.equal(endSilenceMs('What does the Growth package include?', 650), 650)
  assert.equal(endSilenceMs('I wanted to ask about the Growth package and', 650), 1100)
  assert.equal(endSilenceMs('So we have two cafes, um', 650), 1100)
  assert.equal(endSilenceMs('We have two cafes,', 650), 1100)
  assert.equal(endSilenceMs('We have two cafes', 650), 650)
})

test('backchannel: only in a pause, after talking a while, not after a question, not too often', () => {
  const long = 'So we run two cafes in Newtown and we have been trying to get more people'
  const base = { speakingMs: 5000, sinceLastMs: 5000, wordsSince: wordCount(long), pauseMs: BACKCHANNEL_PAUSE_MS, partial: long }
  assert.equal(shouldBackchannel(base), true)
  assert.equal(shouldBackchannel({ ...base, pauseMs: 200 }), false, 'still talking')
  assert.equal(shouldBackchannel({ ...base, speakingMs: 2000 }), false, 'a short turn')
  assert.equal(shouldBackchannel({ ...base, sinceLastMs: 2000 }), false, 'just said one')
  assert.equal(shouldBackchannel({ ...base, wordsSince: 4 }), false, 'little new said')
  assert.equal(shouldBackchannel({ ...base, partial: `${long}. How much is it?` }), false, 'a question wants an answer')
  assert.equal(shouldBackchannel({ ...base, partial: `${long}. So I wanted to ask what you'd suggest for a business like ours` }), false, 'a request too')
})

test('asking: the sentence in progress is a question or a request', () => {
  assert.equal(asking('We run two cafes in Newtown, and we have been open three years now.'), false)
  assert.equal(asking('We run two cafes. And business is okay, but'), false)
  assert.equal(asking('We run two cafes. So could you tell me about SEO'), true)
  assert.equal(asking('We run two cafes. Um, what would you suggest'), true)
  assert.equal(asking('I was wondering if you work with cafes'), true)
  assert.equal(asking('How much is the Growth package'), true)
  assert.equal(asking('Is that right?'), true)
})

test('our own "mm-hm" picked up by the microphone is taken out of the transcript, real words stay', () => {
  assert.equal(withoutBackchannels('We have two cafes, mm-hm. And we want more customers.', true), 'We have two cafes, And we want more customers.')
  assert.equal(withoutBackchannels('Uh-huh, so what does it cost?', true), 'so what does it cost?')
  assert.equal(withoutBackchannels('Mm-hm, that sounds good', false), 'Mm-hm, that sounds good')
  assert.equal(withoutBackchannels('Yeah, that sounds right', true), 'Yeah, that sounds right')
})

test('a draft matches the final words when only case, punctuation or spacing differ', () => {
  assert.equal(sameWords('what does the growth package include', 'What does the Growth package include?'), true)
  assert.equal(sameWords("We're open,  right?", 'we’re open right'), true)
  assert.equal(sameWords('What does the Growth package include?', 'What does the Growth package include for cafes?'), false)
  assert.equal(sameWords('', ''), true)
})

test('a sentence end: a full stop, question or exclamation mark, even inside closing quotes', () => {
  assert.equal(endsSentence('What does the Growth package include?'), true)
  assert.equal(endsSentence('We have been open three years now. '), true)
  assert.equal(endsSentence('He said “that’s fine.”'), true)
  assert.equal(endsSentence('We run two cafes,'), false)
  assert.equal(endsSentence('We run two cafes'), false)
})
