import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CARTESIA_API_VERSION,
  MAX_AUDIO_BYTES,
  MAX_TTS_CHARS,
  synthesizeSpeech,
  toSpeakableText,
  transcribeAudio,
  sttProvider,
  ttsProvider,
} from './speech'
import { LLMConfigError } from './types'

/** A stand-in for the OpenAI SDK's audio namespace that records what it was asked. */
function fakeOpenAI() {
  const calls: { transcribe: Array<Record<string, unknown>>; speech: Array<Record<string, unknown>> } = { transcribe: [], speech: [] }
  const openai = {
    audio: {
      transcriptions: { create: async (params: Record<string, unknown>) => { calls.transcribe.push(params); return { text: '  What are your office hours?  ', logprobs: [{ logprob: Math.log(0.9) }, { logprob: Math.log(0.7) }] } } },
      speech: { create: async (params: Record<string, unknown>) => { calls.speech.push(params); return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } } },
    },
  }
  return { openai: openai as never, calls }
}

test('transcription sends the recording as a named file with the configured model', async () => {
  const { openai, calls } = fakeOpenAI()
  const result = await transcribeAudio(Buffer.from('fake-webm'), { mimeType: 'audio/webm;codecs=opus', language: 'en' }, { openai, env: {} })
  assert.equal(result.text, 'What are your office hours?')
  assert.equal(result.model, 'gpt-4o-mini-transcribe')
  assert.equal(result.audioBytes, 9)
  assert.ok(Math.abs((result.confidence ?? 0) - 0.8) < 1e-9, 'mean token probability')
  assert.deepEqual(calls.transcribe[0].include, ['logprobs'])
  const file = calls.transcribe[0].file as File
  assert.equal(file.name, 'utterance.webm')
  assert.equal(calls.transcribe[0].language, 'en')
})

test('transcription refuses empty and oversized audio before calling the provider', async () => {
  const { openai, calls } = fakeOpenAI()
  await assert.rejects(transcribeAudio(Buffer.alloc(0), { mimeType: 'audio/webm' }, { openai }), /No audio/)
  await assert.rejects(transcribeAudio(Buffer.alloc(MAX_AUDIO_BYTES + 1), { mimeType: 'audio/webm' }, { openai }), /larger than/)
  assert.equal(calls.transcribe.length, 0)
})

test('missing keys give a clear configuration error, not a crash', async () => {
  await assert.rejects(transcribeAudio(Buffer.from('x'), { mimeType: 'audio/webm' }, { env: {} }), LLMConfigError)
  await assert.rejects(synthesizeSpeech('Hello', { provider: 'cartesia' }, { env: { CARTESIA_VOICE_ID: 'v1' } }), /CARTESIA_API_KEY/)
  await assert.rejects(synthesizeSpeech('Hello', { provider: 'cartesia' }, { env: { CARTESIA_API_KEY: 'sk_car_x' } }), /voice id/)
  assert.throws(() => ttsProvider({ SPEECH_TTS_PROVIDER: 'elevenlabs' }), LLMConfigError)
})

test('OpenAI text-to-speech speaks the cleaned text in the chosen voice', async () => {
  const { openai, calls } = fakeOpenAI()
  const result = await synthesizeSpeech('**Yes!** We are open [Mon–Fri](https://x.test) 9–5.', { voice: 'sage' }, { openai, env: {} })
  assert.equal(calls.speech[0].input, 'Yes! We are open Mon–Fri 9–5.')
  assert.equal(calls.speech[0].voice, 'sage')
  assert.equal(calls.speech[0].response_format, 'mp3')
  assert.equal(result.mimeType, 'audio/mpeg')
  assert.equal(result.characters, 'Yes! We are open Mon–Fri 9–5.'.length)
  assert.equal(result.audio.length, 3)
})

test('Cartesia text-to-speech sends the documented request', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const fetchStub = (async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    return new Response(new Uint8Array([9, 9]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
  }) as unknown as typeof fetch
  const result = await synthesizeSpeech('Hello there.', {}, { fetch: fetchStub, env: { SPEECH_TTS_PROVIDER: 'cartesia', CARTESIA_API_KEY: 'sk_car_test', CARTESIA_VOICE_ID: 'voice-123' } })
  assert.equal(requests[0].url, 'https://api.cartesia.ai/tts/bytes')
  const headers = requests[0].init.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer sk_car_test')
  assert.equal(headers['Cartesia-Version'], CARTESIA_API_VERSION)
  const body = JSON.parse(String(requests[0].init.body))
  assert.deepEqual(body.voice, { id: 'voice-123' })
  assert.equal(body.transcript, 'Hello there.')
  assert.deepEqual(body.output_format, { container: 'mp3', sample_rate: 44100, bit_rate: 128000 })
  assert.equal(result.provider, 'cartesia')
  assert.equal(result.audio.length, 2)

  const failing = (async () => new Response('bad voice', { status: 400 })) as unknown as typeof fetch
  await assert.rejects(synthesizeSpeech('Hi', {}, { fetch: failing, env: { SPEECH_TTS_PROVIDER: 'cartesia', CARTESIA_API_KEY: 'k', CARTESIA_VOICE_ID: 'v' } }), /Cartesia text-to-speech failed \(400\): bad voice/)
})

test('speakable text drops markdown and is capped at a sentence boundary', () => {
  assert.equal(toSpeakableText('# Hours\n- Mon to Fri\n- `9am`'), 'Hours Mon to Fri 9am')
  const long = 'This is a sentence. '.repeat(200)
  const capped = toSpeakableText(long)
  assert.ok(capped.length <= MAX_TTS_CHARS)
  assert.ok(capped.endsWith('.'))
})

test('an empty provider variable means the default (compose env files often leave them blank)', () => {
  assert.equal(ttsProvider({ SPEECH_TTS_PROVIDER: '' }), 'openai')
  assert.equal(sttProvider({ SPEECH_STT_PROVIDER: '' }), 'openai')
})
