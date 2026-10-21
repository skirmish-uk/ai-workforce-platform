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
  cloneCartesiaVoice,
  deleteCartesiaVoice,
  wavDurationSeconds,
  transcriptionHint,
  echoesHint,
  soundsLikeEcho,
  notEnglishSpeech,
  compareTranscription,
  configuredSttProviders,
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

test('a vocabulary hint is sent as the prompt, and a transcript that is the hint read back is redone without it', async () => {
  const hint = transcriptionHint(['Ava', 'Demo Marketing Agency', undefined, 'ava', 'Maria Gonzalez', 'CloudNine Analytics'])
  assert.equal(hint, 'Ava, Demo Marketing Agency, Maria Gonzalez, CloudNine Analytics.')
  assert.ok(echoesHint('Vocabulary: Ava, Demo Marketing Agency, Maria Gonzalez.', hint!))
  assert.ok(!echoesHint('Could I book a chat with Maria from CloudNine on Thursday?', hint!))
  assert.ok(!echoesHint('Maria Gonzalez.', hint!), 'too short to judge: kept')

  const prompts: unknown[] = []
  const replies = ['Ava, Demo Marketing Agency, Maria Gonzalez, CloudNine Analytics.', '']
  const openai = { audio: { transcriptions: { create: async (params: Record<string, unknown>) => { prompts.push(params.prompt); return { text: replies.shift() ?? '' } } } } } as never
  const result = await transcribeAudio(Buffer.from('noise'), { mimeType: 'audio/wav', vocabulary: ['Ava', 'Demo Marketing Agency', 'Maria Gonzalez', 'CloudNine Analytics'] }, { openai, env: {} })
  assert.deepEqual(prompts, [hint, undefined])
  assert.equal(result.text, '')
  assert.equal(result.hintRetried, true)

  const { openai: real, calls } = fakeOpenAI()
  const heard = await transcribeAudio(Buffer.from('speech'), { mimeType: 'audio/wav', vocabulary: ['Ava'] }, { openai: real, env: { SPEECH_STT_MODEL: 'gpt-4o-transcribe' } })
  assert.equal(calls.transcribe.length, 1)
  assert.equal(calls.transcribe[0].prompt, 'Ava.')
  assert.equal(heard.model, 'gpt-4o-transcribe')
  assert.equal(heard.hintRetried, undefined)
})

test('an interruption that is only the agent echoing itself, or a backchannel, is recognised', () => {
  const agent = ['Growth is our most popular package at $7,500 a month, and it covers SEO, paid ads, content and LinkedIn.']
  assert.ok(soundsLikeEcho('Sure.', agent))
  assert.ok(soundsLikeEcho('Mm-hm, okay.', agent))
  assert.ok(soundsLikeEcho('Great! Growth is our...', agent))
  assert.ok(!soundsLikeEcho('Actually, what about the Starter package?', agent))
  assert.ok(!soundsLikeEcho('Stop, can I book a call instead?', agent))
  assert.ok(notEnglishSpeech('Угу.'))
  assert.ok(notEnglishSpeech('誰だ?'))
  assert.ok(!notEnglishSpeech('OK, two cafés.'))
  assert.ok(!notEnglishSpeech(''))
})

test('Deepgram gets the raw audio, the key terms and the token; its transcript and confidence come back', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'Could I book a chat with Maria from CloudNine?', confidence: 0.93 }] }] } }), { status: 200 })
  }) as never
  const result = await transcribeAudio(Buffer.from('wav-bytes'), { mimeType: 'audio/wav', language: 'en', vocabulary: ['Ava', 'CloudNine Analytics'], provider: 'deepgram' }, { fetch, env: { DEEPGRAM_API_KEY: 'dg-key' } })
  assert.equal(result.text, 'Could I book a chat with Maria from CloudNine?')
  assert.equal(result.confidence, 0.93)
  assert.equal(result.model, 'nova-3')
  const url = new URL(calls[0].url)
  assert.equal(url.origin + url.pathname, 'https://api.deepgram.com/v1/listen')
  assert.equal(url.searchParams.get('model'), 'nova-3')
  assert.deepEqual(url.searchParams.getAll('keyterm'), ['Ava', 'CloudNine Analytics'])
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Token dg-key')
  assert.equal((calls[0].init.headers as Record<string, string>)['Content-Type'], 'audio/wav')
  await assert.rejects(transcribeAudio(Buffer.from('x'), { mimeType: 'audio/wav', provider: 'deepgram' }, { fetch, env: {} }), LLMConfigError)
})

test('Speechmatics: a batch job with the custom dictionary, polled until done, transcript assembled from json-v2', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let polls = 0
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('/v2/jobs')) return new Response(JSON.stringify({ id: 'job-1' }), { status: 201 })
    if (url.endsWith('/v2/jobs/job-1')) return new Response(JSON.stringify({ job: { status: ++polls < 2 ? 'running' : 'done' } }))
    return new Response(JSON.stringify({ results: [
      { type: 'word', alternatives: [{ content: 'Hello', confidence: 0.9 }] },
      { type: 'punctuation', attaches_to: 'previous', alternatives: [{ content: ',', confidence: 1 }] },
      { type: 'word', alternatives: [{ content: 'CloudNine', confidence: 0.7 }] },
      { type: 'punctuation', attaches_to: 'previous', alternatives: [{ content: '.', confidence: 1 }] },
    ] }))
  }) as never
  const result = await transcribeAudio(Buffer.from('wav-bytes'), { mimeType: 'audio/wav', language: 'en', vocabulary: ['CloudNine'], provider: 'speechmatics' }, { fetch, env: { SPEECHMATICS_API_KEY: 'sm-key' } })
  assert.equal(result.text, 'Hello, CloudNine.')
  assert.ok(Math.abs((result.confidence ?? 0) - 0.8) < 1e-9, 'mean word confidence')
  assert.equal(result.model, 'enhanced')
  const form = calls[0].init?.body as FormData
  assert.deepEqual(JSON.parse(String(form.get('config'))), { type: 'transcription', transcription_config: { language: 'en', model: 'enhanced', additional_vocab: [{ content: 'CloudNine' }] } })
  assert.ok(form.get('data_file') instanceof Blob)
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer sm-key')
  assert.ok(calls.at(-1)!.url.endsWith('/v2/jobs/job-1/transcript?format=json-v2'))
})

test('comparison runs every configured provider and reports a failure without losing the others', async () => {
  const env = { OPENAI_API_KEY: 'o', DEEPGRAM_API_KEY: 'd' }
  assert.deepEqual(configuredSttProviders(env), ['openai', 'deepgram'])
  const { openai } = fakeOpenAI()
  const fetch = (async () => new Response('bad key', { status: 401 })) as never
  const results = await compareTranscription(Buffer.from('wav'), { mimeType: 'audio/wav' }, { openai, fetch, env })
  assert.equal(results.length, 2)
  assert.equal(results[0].text, 'What are your office hours?')
  assert.match(results[1].error ?? '', /Deepgram speech-to-text failed \(401\)/)
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

test('cloning sends one private clip to Cartesia and returns the voice id; deleting tolerates a missing voice', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (init.method === 'DELETE') return new Response(null, { status: url.endsWith('gone') ? 404 : 204 })
    return Response.json({ id: 'voice-123', name: 'Ava - Dave' })
  }) as unknown as typeof fetch
  const env = { CARTESIA_API_KEY: 'sk_car_test' }
  const result = await cloneCartesiaVoice(Buffer.from('RIFF....WAVE'), { mimeType: 'audio/wav', name: 'Ava - Dave' }, { fetch: fakeFetch, env })
  assert.deepEqual(result, { voiceId: 'voice-123', name: 'Ava - Dave' })
  assert.equal(calls[0].url, 'https://api.cartesia.ai/voices/clone')
  const form = calls[0].init.body as FormData
  assert.equal(form.get('access'), 'private')
  assert.equal(form.get('language'), 'en')
  assert.ok(form.get('clip') instanceof Blob)
  await deleteCartesiaVoice('voice-123', { fetch: fakeFetch, env })
  await deleteCartesiaVoice('gone', { fetch: fakeFetch, env })
  await assert.rejects(cloneCartesiaVoice(Buffer.from('x'), { mimeType: 'audio/wav', name: 'x' }, { fetch: fakeFetch, env: {} }), /CARTESIA_API_KEY/)
})

test('WAV duration comes from the header', () => {
  const rate = 24000
  const samples = rate * 12
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF', 0, 'ascii'); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii'); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii'); wav.writeUInt32LE(samples * 2, 40)
  assert.equal(wavDurationSeconds(wav), 12)
  assert.equal(wavDurationSeconds(Buffer.from('not a wav file at all, definitely longer than 44 bytes....')), null)
})
