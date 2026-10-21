# Voice agents

Agents can be talked to, not just typed to. The first voice agent is **Ava - Client Questions** (`demo-assistant-1`), a Knowledge Assistant that answers from the business's own documents. The design follows the "voice RAG agent" pattern: speech → text → retrieve from documents → model → text → speech. Each answer goes through the same agent runtime, rules and audit trail as a typed task.

**Status (2026-10-13):** turn-based voice in the dashboard is built and verified end to end in headless Firefox. That run used a fake microphone and a local stand-in for the OpenAI API: greeting spoken, recording transcribed, answer retrieved from the FAQ document, reply spoken, run and usage recorded. It has **not** yet run against real OpenAI or Cartesia accounts. Phone calls and real-time streaming are not built (see §5).

---

## 1. How a voice turn works

```
Browser (Talk panel on the agent page)
  │ call mode: mic stays open; voice detection starts and ends each turn (MediaRecorder webm/opus)
  ▼
POST /api/agents/{id}/voice   (multipart "audio", ≤10 MB; "history": the call so far)
  1. checks: signed in, same tenant, agent:write, voice enabled and valid for this agent
  2. speech-to-text        packages/llm/src/speech.ts  (OpenAI gpt-4o-mini-transcribe, with a
                           names-only hint; WAV from the browser)
  3. agent run             enqueued on agent-run with trigger "voice"; the route waits for the
                           worker's result (≤45 s). Same Diagnose → Assemble → Act → Assess run,
                           policy, approvals, kill switches, spend caps and AuditLog as any run.
                           Document retrieval: pgvector when embedded, otherwise the agent's
                           attached documents.
  4. spoken reply          spokenReply(): the answer; or "passed to the team" for approvals and
                           escalations. It never says a gated action was done.
  5. text-to-speech        OpenAI gpt-4o-mini-tts (default) or Cartesia Sonic
  6. VOICE_TURN audit row  audio bytes, characters spoken, models, duration: the usage data
                           per-minute pricing will be based on
  ▼
JSON { transcript, reply, status, runId, audio (base64 mp3) } → played in the browser
```

`GET /api/agents/{id}/voice` returns the greeting (text and audio) to start a conversation.

**Garbled audio protection (2026-10-13).** Transcripts now carry a confidence score (mean token probability, `include: ['logprobs']`). Below `MIN_TRANSCRIPT_CONFIDENCE` (0.5) the turn is answered "Sorry, I didn't catch that clearly" and is **not** sent to the agent (status `unclear`). Calibration with real calls: clear speech 0.97–0.99, heavily distorted but correct 0.82, unintelligible audio that came back as foreign-sounding gibberish 0.23; silence and noise come back empty. A transcription prompt quoting what the agent last said is deliberately not used: on silence it made the model invent whole sentences at high confidence.

**Poor microphones (2026-10-21).** Measured on test sentences degraded to sound like a cheap laptop mic across a room (quiet, band-limited to 300–3200 Hz, fan noise), the transcriber mostly got the names wrong: "Cloud9" for CloudNine, "you here" for Maria, "Paramatta". Four changes:
- **Names-only hint.** Each turn sends a short term list as the prompt: the agent's name, the business name, the agent's `voice.vocabulary` (optional, up to 40 terms) and names already said in the call. With it, all three test sentences came back word-perfect. On pure noise the model sometimes returns the hint itself (5 of 9 noise clips). `echoesHint()` spots that and transcribes again without the hint, which returns nothing (`VOICE_TURN.hintRetried`).
- **Model.** `gpt-4o-mini-transcribe` stays. With the hint, `gpt-4o-transcribe` was no more accurate, and on noise it invented short phrases in other languages. Override with `SPEECH_STT_MODEL`.
- **No clipped first word.** The browser keeps the last 0.6 s of microphone audio, so a turn includes the syllable spoken before speech was detected. Before, recording only started once speech was detected, which cut off the start of every turn.
- **Clean audio.** Turns are sent as 16 kHz mono WAV instead of compressed Opus, captured by an AudioWorklet. Quiet microphones are brought up to a normal level (at most 8×), trailing silence is trimmed, and rumble below 90 Hz is filtered out. Browsers without AudioWorklet fall back to MediaRecorder.

**Comparing transcribers (2026-10-21).** Speech-to-text can be OpenAI, Deepgram or Speechmatics. The default is `SPEECH_STT_PROVIDER`, and an agent's `voice.sttProvider` overrides it for that agent's calls. Use **Compare transcribers** on the agent page to choose. Read a suggested sentence (or type your own) and the same recording goes to every provider with a key, with the agent's vocabulary. Each result shows the transcript, the time it took, confidence, and how many words differ from what was read out (numbers count the same written as words or digits). In a call, **Compare transcribers** on any of your turns does the same with that turn's recording. Nothing is sent to the agent. Transcripts (no audio) are kept as `SPEECH_COMPARISON` audit rows. `POST /api/agents/[id]/voice/compare`.
- **Deepgram:** pre-recorded `POST /v1/listen`, Nova-3, `smart_format`. The vocabulary goes in as `keyterm` parameters.
- **Speechmatics:** a batch job polled every 250 ms, model `enhanced` (`transcription_config.model`; `operating_point` was deprecated in July 2026). The vocabulary goes in as `additional_vocab`. Batch jobs queue, so Speechmatics is slower per turn here; for live calls their real-time websocket API would be the one to use. Its "time" in the comparison includes that queueing.
- Not yet run against real Deepgram or Speechmatics accounts. The request shapes follow their docs and the Speechmatics JS client, and are covered by tests with stand-in responses.

**Talk panel: a call, not voice messages (2026-10-20).** It sits at the top of the agent page. **Start call** plays the greeting and keeps the microphone open until **End call**:
- **No buttons per turn.** Voice detection in the browser measures the microphone level (speech band, 90 Hz–4 kHz) against a noise floor it learns while the room is quiet. The lowest level that counts as speech is 0.006 RMS, because quiet laptop mics gave 0.01–0.03. About 150 ms of speech starts a turn, and 0.65 s of silence ends and sends it. Clicks and coughs under 0.5 s are ignored, and turns are capped at 30 s. A turn that transcribes to nothing is dropped silently, so background noise never makes the agent say "sorry?".
- **Interrupting by talking (reworked 21 Oct).** Before, interrupting needed a fixed level (0.05 RMS, 6× the noise floor) that ordinary speech on a laptop mic rarely reached. Now:
  - The page measures what it is playing and learns, during the call, how much of the agent's voice the microphone picks up. With a headset that is almost nothing; with laptop speakers it is whatever echo cancellation leaves.
  - When the mic is 1.3× louder than that expected echo for 100 ms, the agent is turned down to a quarter. An echo drops with it and a person talking doesn't. If the mic stays 3× over the new expected echo for another 100 ms, the agent stops and your turn starts. Otherwise its volume comes back within about 0.35 s.
  - The turn keeps your audio from just before you were first heard, so the interrupting words aren't lost.
  - The expected echo is also used between sentences and just after the agent stops. Without that, its echo tail was sometimes transcribed as you saying "Right." or "So...".
  - The page compares playback with the loudest moment of the last 200 ms, because echo arrives a little later. If the agent was turned down but it proved to be echo, the estimate is raised.
  - **Echo guard (server).** A turn that started by interrupting (`interrupted=1`) is ignored like silence when it is only a backchannel ("Sure.", "Mm-hm") or mostly the agent's own last words (`soundsLikeEcho()`). Transcripts with no English letters at all ("Угу", "誰だ?": noise) are ignored on every turn (`VOICE_TURN.ignored`).
  - Tested 21 Oct in headless Firefox with a scripted microphone: speech at a normal level, and the page's own output fed back after its volume control at 5%, 25% and 50%, with no echo cancellation. Before the echo guard and the raised estimate, 25% echo made the agent interrupt itself and answer its own voice in a loop. After them it never did. During the first greeting the agent's volume dipped for about 1 s in total while the page learned the echo. Interruptions took 0.9–1.1 s from the first word. Turns spoken while the agent was quiet transcribed cleanly. Turns spoken over the agent with raw echo were sometimes garbled ("Demetri" for "Demo"), which the browser's echo cancellation should largely remove. A headset works best.
- **Memory of the call.** Each turn sends the last 8 exchanges (as `history`, 400 characters each). The route gives the agent the conversation and the new line, so follow-ups like "what about Saturdays?" work.
- **Mute** (detection paused), a waveform that follows your microphone or the agent's voice, the current exchange with earlier turns collapsible, "Play my recording", a microphone picker, and "See how it answered", which opens that turn's run and reasoning on the same page.
- **Latency (streamed, 20 Oct).** Before: each step finished before the next started, so the reply began 5.9–6.3 s after upload. Now:
  - the model's text streams from the worker over Redis (`streamChannel`) as it is written;
  - the route turns each sentence into speech as soon as it completes, and the opening clause of a long first sentence on its own;
  - audio streams to the browser as NDJSON (`heard` → `audio` per sentence → `done`), and the browser plays the sentences back to back;
  - voice turns run at low effort (thinking stays on: off made Ava skip the calendar);
  - voice turns skip the embedding search (about 0.3 s) and use the attached documents;
  - the end-of-speech wait is 0.65 s;
  - an acknowledgement in the agent's voice ("Mm-hm.", "Okay.") plays if nothing has started 0.6 s after the caller stops.

  Measured on the live site, the first answer audio arrives 2.3–3.9 s after upload (one outlier at 6 s). What remains is speech-to-text (0.55–2 s) and the model's first words (1.2–5 s), both outside our control. Every turn's breakdown is returned as `timings` and kept on its `VOICE_TURN` row. Sub-second, phone-grade turn-taking needs streaming speech recognition and synthesis end to end (§5).

## 2. Turning voice on for an agent

Voice settings live in `Agent.config.voice`, outside the contract: they change how an agent sounds, not what it may do. They're validated by `voiceConfigSchema` in `packages/executor/src/voice.ts`.

```json
{ "voice": { "enabled": true, "provider": "openai", "voiceId": "coral",
             "greeting": "Hi, I'm Ava, Demo Marketing Agency's AI assistant. What can I help you with?" } }
```

Rules enforced in code (an invalid config turns voice **off**):
- **The greeting must say the caller is talking to an AI.**
- **A cloned voice requires recorded consent:** `clonedVoice: { consentFrom, consentDate, consentReference? }`. Clone only a voice whose owner has agreed in writing to its use by this agent.

Agents meant for voice should answer in one to three plain sentences with no formatting. Ava's prompt and playbook say so, and `toSpeakableText()` also strips markdown and caps replies at 1,500 characters.

## 2a. Using your own voice (cloning)

On the agent page, under the Talk panel, **Use your own voice** (admins only; needs `CARTESIA_API_KEY`):
1. Enter whose voice it is and tick the consent statement: the speaker agrees to their voice being copied by Cartesia and used by the business's AI assistant, which always says it's an AI.
2. Read the on-screen script aloud, about 30–40 seconds. Its first line is a spoken consent statement with the speaker's name and the business, so the recording carries the consent too. Cartesia needs at least 10 seconds, and up to 60 seconds keeps the accent better. Use a quiet room and speak normally.
3. Listen back, then **Create voice**. The browser converts the recording to 16-bit mono WAV (24 kHz) so every browser's format works and the server can check the length (10 s to 2 min). `POST /api/agents/[id]/voice/clone` sends it to Cartesia's instant clone (`POST /voices/clone`, private).
4. The server switches the agent to the new voice (`voice.provider: cartesia`, `voice.voiceId`) and stores the consent record (`voice.clonedVoice`: name, date in the tenant's time zone, and who uploaded it). It remembers the previous voice (`voice.previous`), audits `VOICE_CLONED` and plays a sample greeting.

**Remove this voice** (`DELETE …/voice/clone`) restores the previous voice, deletes the copy at Cartesia and audits `VOICE_CLONE_REMOVED`. Recording a new voice replaces the old copy, which is deleted at Cartesia too.

The recording is not stored by the platform. Cartesia keeps the private voice until it is removed. Reseeding keeps a cloned voice (the seed doesn't overwrite a voice that has a consent record). Instant cloning needs a paid Cartesia plan (Pro or above).

## 3. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | Speech-to-text, OpenAI text-to-speech, and document embeddings |
| `SPEECH_STT_PROVIDER` | `openai` | Speech-to-text provider (only `openai` today) |
| `SPEECH_STT_MODEL` | `gpt-4o-mini-transcribe` | Transcription model (see "Poor microphones") |
| `DEEPGRAM_API_KEY` | | Deepgram speech-to-text (`nova-3`; `DEEPGRAM_STT_MODEL`, `DEEPGRAM_LANGUAGE` override) |
| `SPEECHMATICS_API_KEY` | | Speechmatics batch speech-to-text (`enhanced`; `SPEECHMATICS_STT_MODEL`, `SPEECHMATICS_LANGUAGE`, `SPEECHMATICS_API_URL` override) |
| `SPEECH_TTS_PROVIDER` | `openai` | `openai` or `cartesia` (an agent's `voice.provider` overrides it) |
| `CARTESIA_API_KEY` | — | Needed for Cartesia voices (`sk_car_…`) |
| `CARTESIA_VOICE_ID` | — | Default Cartesia voice when the agent doesn't name one |

After adding `OPENAI_API_KEY`, run `npx tsx scripts/reindex-knowledge.ts` once so seeded documents get semantic search. Documents uploaded through the dashboard are indexed automatically.

## 4. Cost per conversation minute (estimates, to be replaced by measured data)

Assumptions: about half of each minute is the caller speaking and half the agent; the agent speaks about 450 characters a minute; about 4 turns a minute; Ava on Claude Haiku 4.5.

| Part | Estimate (USD/min) | Basis |
|---|---|---|
| Speech-to-text (gpt-4o-mini-transcribe) | ~$0.003 | third-party pricing summaries; check OpenAI's pricing page |
| Text-to-speech (Cartesia Sonic) | ~$0.017 | ~$0.037 per 1,000 characters on Cartesia's Scale plan (third-party estimate) |
| Text-to-speech (OpenAI gpt-4o-mini-tts) | not yet checked | check OpenAI's pricing page |
| Model (Haiku 4.5, ~1,000 input / 60 output tokens per turn) | ~$0.005 | $1 / $5 per million tokens (`packages/llm/src/pricing.ts`). Prompt caching doesn't apply: Haiku 4.5 only caches prompts over 4,096 tokens and Ava's is ~2,500 |
| **Browser voice total** | **~$0.025–0.03** | |
| Phone calls: telephony + a real-time voice platform | not yet checked | e.g. Cartesia's hosted voice agents are a flat $0.06/min (third-party report) |

`VOICE_TURN` audit rows record audio size and characters spoken for every turn, so the pilot can replace these estimates with real numbers.

## 5. What's not built: the AI Receptionist (phone)

Answering real phone calls needs a different runtime from this turn-based demo:
- **Real-time streaming** (LiveKit Agents or a hosted voice-agent platform): voice activity detection, interruptions, and sub-second turn-taking. Background agent runs through the queue are too slow for a live call, so the receptionist would answer from documents directly and hand actions to the normal agents.
- **Telephony:** phone numbers and SIP, per-minute carrier costs.
- **Legal:** callers told they're speaking to an AI; call-recording consent, which varies by Australian state (this design doesn't store audio, but transcripts are kept in the audit trail); privacy policy coverage.
- **Safety:** a phone agent can't wait for approvals mid-call. It takes the request, says it has passed it on, and the action waits in the approvals inbox as usual.

This is scheduled after the first pilot (see the launch plan).

## 6. Code map

| File | Role |
|---|---|
| `packages/llm/src/speech.ts` | `transcribeAudio`, `synthesizeSpeech`, `toSpeakableText`; OpenAI and Cartesia providers |
| `packages/executor/src/voice.ts` | `voiceConfigSchema`, `readVoiceConfig`, `spokenReply`, `defaultGreeting` |
| `packages/queue/src/queues.ts` | `waitForAgentRun()`: the route waits for the worker's result |
| `apps/web/src/app/api/agents/[id]/voice/route.ts` | Greeting (GET) and voice turn (POST) |
| `apps/web/src/app/dashboard/agents/[id]/VoicePanel.tsx` | Talk panel |
| `packages/db/prisma/seed.ts` | Ava, her playbook (`answer_client_questions`, 5 test cases) and the FAQ document |
| `scripts/reindex-knowledge.ts` | Embed documents for semantic search |

Tests: `packages/llm/src/speech.test.ts` (6, stubbed vendors) and `packages/executor/src/__tests__/voice.test.ts` (2).
