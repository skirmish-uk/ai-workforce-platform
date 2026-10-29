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
  5. text-to-speech        OpenAI gpt-4o-mini-tts (default) or Cartesia Sonic, streamed as
                           24 kHz 16-bit PCM (streamSpeech); Cartesia also says when each word is spoken
  6. VOICE_TURN audit row  audio bytes, characters spoken, models, duration: the usage data
                           per-minute pricing will be based on
  ▼
NDJSON stream: heard → per sentence: say → pcm… (+ words) → said → done
  → scheduled back to back with Web Audio; the words type out as they are said
```

`GET /api/agents/{id}/voice` returns the greeting (text and audio) and the acknowledgement clips to start a conversation. A turn with nothing usable heard is answered with plain JSON (`speech: { pcm, words }`) instead of a stream.

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
- **Call sounds**: a soft rising two-note chime on **Start call** (before the microphone opens) and a falling one when the call ends, whoever hangs up; synthesised in the browser, played outside the agent's voice chain.
- **A call screen**: on **Start call** the orb grows to fill the panel, with the agent's name and a call timer above it and round Mute / End call buttons below; it shrinks back when the call ends.
- **Mute** (detection paused), an orb that swells and ripples with your microphone (rose) or the agent's voice (blue) and has a light circling it while it thinks (with a spinner by "Ava is thinking…"; a filler clip doesn't end the thinking state, only the answer's own audio does), the current exchange with earlier turns collapsible, "Play my recording", a microphone picker, and "See how it answered", which opens that turn's run and reasoning on the same page.
- **Latency (streamed, 20 Oct).** Before: each step finished before the next started, so the reply began 5.9–6.3 s after upload. Now:
  - the model's text streams from the worker over Redis (`streamChannel`) as it is written;
  - the route turns each sentence into speech as soon as it completes, and the opening clause of a long first sentence on its own;
  - audio streams to the browser as NDJSON (`heard` → `audio` per sentence → `done`), and the browser plays the sentences back to back;
  - voice turns run at low effort (thinking stays on: off made Ava skip the calendar);
  - voice turns skip the embedding search (about 0.3 s) and use the attached documents;
  - the end-of-speech wait is 0.65 s;
  - an acknowledgement in the agent's voice ("Mm-hm.", "Okay.") plays if nothing has started 0.6 s after the caller stops (since 21 Oct: after 1 s, and not on two turns in a row; one before every answer sounded mechanical).

  Measured on the live site, the first answer audio arrives 2.3–3.9 s after upload (one outlier at 6 s). What remains is speech-to-text (0.55–2 s) and the model's first words (1.2–5 s), both outside our control. Every turn's breakdown is returned as `timings` and kept on its `VOICE_TURN` row. Sub-second, phone-grade turn-taking needs streaming speech recognition and synthesis end to end (§5).

- **Streamed speech and words typed as they're said (21 Oct).** Where the time went, from 21 VOICE_TURN rows and their runs on the live site: speech-to-text 0.55–2.3 s; the run's own work before the model about 20 ms; the model's first words 1.3–1.8 s; and 0.4–0.7 s between the first words and the first audio. Changes:
  - **Speech streams.** Each sentence goes to Cartesia's `/tts/sse` (or OpenAI with `response_format: "pcm"`) and its audio is forwarded to the browser chunk by chunk (`say` → `pcm`… → `said`). Measured from here: first audio 0.10–0.18 s after the request, against 0.5–0.7 s for a whole sentence. The browser schedules the chunks back to back with Web Audio (60 ms lead before a sentence starts), through the same compressor, volume and waveform as before.
  - **Words in step with the voice.** Cartesia returns when each word is spoken (`add_timestamps`), so the agent's bubble types each word out as it is said. A word count that differs from the text ("$7,500" spoken as four words) is spread evenly; OpenAI voices and missing timings are paced by length. When the caller talks over the agent, the bubble keeps the words that were said and shows the rest dimmed ("Not said"). "Play again" replays the turn's audio.
  - **A slow transcription is asked twice.** About one turn in five took 1.7–2.3 s to transcribe for no reason in the audio. If the first request hasn't answered after 1 s, the same request goes again and the first answer wins (`hedged()`, `VOICE_TURN.timings.transcribeHedged`). That costs one extra transcription on those turns (about $0.0002).
  - **Whole documents on calls, cached.** Voice turns skip search and use the agent's attached documents, but each was cut to its first 1,500 characters, so Ava only saw a third of the packages guide on calls. They now get whole documents up to 16,000 characters in all, as their own cached prompt block (they only change when edited). Ava's voice turns read 5,219 of about 5,550 prompt tokens from cache, up from 2,937 of 4,900.
  - **Fixed lines are cached.** The greeting, "Mm-hm."/"Okay."/"Right."/"Sure." and the fallback lines are the same on every call, so their audio is kept in Redis (`voice-tts:<sha256 of provider, model, voice, text>`, 30 days, renewed when used): about 50 KB per second of speech, around 0.5 MB per agent voice. Starting a call went from ~1.8 s to 70–185 ms locally after the first one. Answers are not cached: they depend on the call so far, live calendar availability and the time of day, and a word-for-word repeat of a spoken question is rare, so a cache would seldom hit and could give a stale or wrong answer when it did.
  - Tested 21 Oct in headless Firefox with a scripted microphone (`Hi, what does the Growth package include?`): the greeting and the answer typed out word by word with the voice, first answer audio 2.0–2.5 s after upload locally, talking over the answer froze the text at the last word said, and the call appeared in the conversation list without a reload.
  - Interrupting with a short word then a pause ("Sorry, — actually…") used to take 2–3 s and lose the first word; fixed in the next section.

**Only a voice interrupts (21 Oct).** In a real call, opening a food container stopped the agent: interrupting went by loudness (louder than the agent's expected echo), and any sharp noise is loud.
- **A voice detector in the page.** Silero VAD v5 (MIT, 2.3 MB, `public/vad/silero_vad.onnx`) runs in the browser with ONNX Runtime's WebAssembly build (`onnxruntime-web` 1.20.1, 11 MB, about 3 MB compressed; copied to `public/vad/` by `apps/web/scripts/copy-vad-runtime.mjs` before dev and build, and loaded at run time outside the bundle). It gives a speech probability for every 32 ms of microphone audio (`speech-detector.ts`). Fetched when the agent page opens, so it is ready by the time a call starts; until then, or in a browser that can't run it, loudness alone decides, as before.
- **Measured offline first.** Real recordings from Wikimedia Commons (plastic bag, plastic wrapping, cutlery on a table, sorting cutlery, a metal pot and lid, cooking, tidying a kitchen; about 3 minutes, checked to contain no speech) and six speech clips. A hand-made check (a voice repeats at a speaking pitch and holds its level) fired 9–18 times a minute on the kitchen recordings and was dropped: a ringing pot looks like a held vowel. Silero never gave any noise frame more than 0.5; speech reached 1.0. The rule used, "0.7 or more for 3 frames in a row", never fired on the noise, recognised speech 128 ms after it started (median; at worst 256 ms) and also recognised speech over loud kitchen noise.
- **The same audio must be a voice and loud.** The detector hears the agent's own voice from the speakers as speech, however quiet. So a frame counts only if it is both speech and louder than the expected echo; neither alone is the caller.
- **The agent pauses to listen, then carries on.** When something loud comes in over the agent, it pauses mid-word (the audio is held, so nothing is lost), the detector starts afresh, and the page listens with no echo in the microphone. A voice stops the agent and the caller's turn starts. Anything else lets the agent carry on from where it paused once the detector has heard about 0.13 s of no speech (at most 0.45 s); the words typed in its bubble wait with it. Turning it down to a tenth instead of pausing wasn't enough: it still scored 0.99 as speech, and that carried into the frames of a pot clattering over it.
- **Starting a turn** also needs a voice, so a clatter while the agent is listening doesn't start one (or cost a transcription).
- Tested in headless Firefox with a scripted microphone: 10 s of the real recordings while listening and while the agent answered, then the caller saying "Sorry, actually, what about the Starter package?". Without echo in the microphone (a headset, or echo cancellation doing its job), 3 runs out of 3: the noise never started a turn or stopped the agent, and the voice stopped it 0.72–0.74 s after it started speaking, keeping "Sorry, actually," in the transcript (it used to be lost). Noise while listening never started a turn in any run. Worst case, with the page's own output fed straight back into the microphone at 25% or 50% and no echo cancellation: the noise still stopped the agent in about 2 runs out of 11, and interrupting took 0.6–2.8 s.
- **Fixed the same day: the voice cutting in and out.** On laptop speakers the agent's own echo set off pause after pause, hundreds in one answer, heard as the voice cutting in and out (a first live test reported it). Measured with the page's output fed back at 25% and 50%: (1) a pause set off by its own echo taught nothing, because the detector had just restarted and couldn't yet say the trigger was speech; now, if what set it off was speech and stopped when the agent paused, it raises the echo estimate with a 30% margin; (2) the echo estimate followed the average and dropped below the next syllable's echo within a second; it now follows the peaks and halves in about 1.7 s, and only rises on speech (a clatter just under the pause level ratcheted it up); (3) after a pause caused by its own echo there's no new pause for 1 s (0.3 s after one for a noise). Pauses in a plain answer: 0 at 25%, 0–1 at 50% (from hundreds). Noise still never stopped the agent in the following runs; interrupting took 0.7–0.8 s without echo and 0.7–2.8 s with that much raw echo (a short first word like "Sorry," can be missed, and the next word does it).
- **Faster interrupting (22 Oct).** On a laptop it took saying "hang on" three times: the page paused the agent, waited 150 ms, then wanted two loud ticks and ~0.1 s of fresh speech, so it decided ~0.4 s into the caller's words. A short "hang on" was over by then, and because it stopped while the agent was paused it was taken for the agent's echo, raising the echo estimate so the next one had to be louder. Now the detector restarts 50 ms after the pause, loudness counts from 100 ms, one loud tick with a voice is enough, and only a sound gone within those first 100 ms (too short for a word) counts as the agent's echo. "Hang on. Actually, what about the Starter package?" stopped the agent 0.42–0.76 s after it started (with the page's output fed back at 0%, 25% and 50%), transcribed in full; noise still never stopped it (6 runs) and plain answers had 0–1 pauses.
- **"Error in input stream" (Firefox).** A voice answer could break off with that error: the route waited for the run's result by polling the job, and a job read just before it finished reported "completed" with its result still missing, so the route crashed mid-answer (`Cannot read properties of null (reading 'status')`). `waitForAgentRun()` now reads the job again for its result, the route never assumes one, and if a stream does drop mid-answer the page says so on that answer instead of showing the browser's error.
- **Known limits.** Pausing on a long clatter makes the agent stop and start (each pause about 0.25 s). It can't tell the caller from another person talking in the room, or a TV. Real recordings of other kitchens, offices and microphones will differ from these.

**Sounding natural, and ending the call (21 Oct).** A first real call with Ava sounded scripted: every answer ended "Would you like more detail on…?", "in Australian dollars, excluding GST" came back each time, and a plain "No." got a three-sentence recap. Part of the cause was the per-turn instruction itself ("offer more detail instead of listing everything").
- **How to talk on a call** is now part of the prompt for every voice turn (`VOICE_STYLE` in `packages/executor/src/agent.ts`, cached with the stable prompt, voice turns only): answer straight away in plain spoken English; mostly just answer and stop; don't repeat what was already said on the call; react briefly and vary openings; short replies to "no" or "okay"; repeat more simply when asked. The turn itself is now only what was said (`The call so far… The caller just said: "…"`).
- **Wrapping up.** Once the caller's questions seem dealt with, the agent checks once, lightly, whether there's anything else. When they say they're done, it says a one-sentence goodbye and calls `platform__end_call` (offered on voice turns only; ends the run as `completed`, with `endCall` on the result and its audit row). The page hangs up about 1 s after the goodbye finishes (`END_CALL_AFTER_MS`), unless the caller starts talking again, and shows "Ava ended the call".
- **No double hand-off.** When the agent has already explained a hand-off in its own words, the stock "That's one for a colleague…" line isn't added after it. Approvals still always get theirs (it never claims a gated action was done).
- Replayed against the real model (Haiku 5.5) with the same caller lines as the first call: "No." got "No problem at all."; most answers stopped without a question; after "That's great, thanks." Ava asked "Is there anything else I can help with?"; "No, that's all. Bye!" got "Thanks for calling. Have a great day!" and the call ended.

**Live transcription and backchannels (26 Oct).** The caller's words are transcribed while they speak, instead of the whole turn being uploaded after they stop:
- **How.** At the start of a call the page asks `POST /api/agents/[id]/voice/live` for a short-lived key (2 minutes to connect; the API key never reaches the browser) and opens a WebSocket to OpenAI's realtime transcription with model `gpt-live-transcribe` (`live-transcriber.ts`). No turn detection on OpenAI's side: the page's own voice detection starts a turn (sending the 0.6 s pre-roll first) and ends it with a commit. Audio is resampled to 24 kHz 16-bit PCM in the page (`live-turn.ts`) and only sent while a turn is being recorded, so silence costs nothing. The same names-only hint as uploaded turns goes in as the session prompt.
- **What you see.** Nothing extra: the live words are used to time the call, not shown (showing them distracted from talking, 26 Oct). What was heard appears in the turn's bubble once it's sent.
- **Faster turns.** The page sends the text (`transcript` field) instead of the recording, and the server skips speech-to-text. It doesn't wait for the turn to end to ask for that text: at 0.4 s of silence it commits what has been said so far (`EARLY_COMMIT_MS`), holds back the quiet audio after it, and sends that on only if the caller speaks again (their next words become the turn's next part; the parts are joined). So when the turn ends at 0.65 s the text is usually already back. Measured 26 Oct on the live site: committing only at the turn's end, the text arrived 0.51–0.70 s after it; with the early commit, 0.44–0.61 s (the transcriber takes 0.5–0.8 s to finish a part, and the turn ends 0.25 s after the early commit). Uploading instead took upload + 1.17 s on the same question on the live site, and 0.55–2.3 s to transcribe in earlier measurements. The rest of the wait is the model's first sentence and its speech (about 2.7 s on the live site). If a part's text doesn't come within 2.5 s, comes back empty, or the connection is down, the turn is uploaded as before, and the page reconnects for the next one.
- **Not waiting for the final text.** The live words *are* the final text as it arrives (they matched it word for word in every test), so once the turn has ended the page sends them as soon as they end a sentence ("…package?"), 0.25–0.45 s before the transcriber confirms them. Only a sentence end that arrives 0.6 s or more after the caller stopped (`WORDS_CAUGHT_UP_MS`): the live words run **0.6–1 s behind the voice** (measured 26 Oct on the live site, e.g. "package?" 0.86–0.99 s after it was said), so an earlier "…Newtown." may still have words after it. Otherwise the confirmed text is waited for as before.
- **Not cutting in.** If the text stops mid-thought ("…and", "…um", a trailing comma), the page waits until 1.1 s of silence instead of 0.65 s before sending it; if the caller starts again in that time, it is all one turn. It is judged on the finished text, not the live words: those run behind the voice, so at a pause they often end mid-phrase only because the last words haven't arrived (judging by them made ordinary turns wait longer).
- **Backchannels.** When the caller has been talking for 3 s or more (8+ words since the last one) and pauses for 0.35 s mid-turn, the agent says a soft "Mm-hm." / "Yeah." / "Right." / "Uh-huh." in its own voice (cached clips from `GET /voice`, played at 70% of the answer volume). Never after a question, at most one every 4.5 s, and not as the "slow answer" filler on the same turn. Its echo isn't counted as the caller talking, and a picked-up "mm-hm"/"uh-huh" is taken out of the transcript. Tested 26 Oct on the live site with a 16 s explanation in three sentences with 0.6 s pauses: one turn (not cut at the pauses), backchannels at both pauses and not at the closing request ("so I wanted to ask what you'd suggest…"), clean transcript. "I'd like to ask about the Growth package and, um… [0.85 s] …what does it cost per month?" was one turn.
- **If the caller carries on** while the text of a turn they'd paused on is still coming, those words open their next turn instead of being lost.
- **Settings.** On by default when `OPENAI_API_KEY` is set. `SPEECH_LIVE_STT=off` turns it off everywhere; `voice.liveTranscription: false` for one agent; `voice.backchannels: false` keeps live text but no "mm-hm"s. `VOICE_TURN` rows record `stt: "live"`, `liveSeconds` (what's billed) and `timings.liveWaitMs`.
- **Cost.** $0.017 per minute of audio sent (OpenAI pricing page, 26 Oct), about 4× the batch model, but only for the caller's own speech: roughly $0.009 per conversation minute.

**What earlier turns did (26 Oct).** The call history sent with each turn marks an agent line that handed something over or passed it for approval (`outcome` → "[Done: this was handed over to the team on this call.]"), and `VOICE_STYLE` says what that means. Without it, the stock line "That's one for a colleague. I've passed it on…" read like a promise: on the live site Ava handed one custom-package request over five times, told the caller it "hadn't actually been sent", and kept handing over instead of ending the call when they said goodbye. Replayed on the real model: before, "Okay, that's all." was handed over again; after, she said goodbye and ended the call, and a follow-up question was answered with "your request is already with the team".
- **Outside the window too.** Only the last 8 lines are shown, but what older turns did is kept: "Earlier in the call (not shown): [Done: …]" (the page sends the last 24 turns). On a later live call the hand-off was 5 exchanges back, dropped out of the window, and Ava handed over again on "Okay, that's all". Replayed: 3/3 handed over before, 3/3 said goodbye and ended the call after.
- **If the caller is done, the call ends.** When the caller says they're done (`callerWantsToEnd()`) and the turn still ends in a hand-off or an approval (which end the agent's turn, so it can't also end the call), the server adds "Thanks for calling. Have a great day!" and ends the call (`VOICE_TURN.closedAfterHandOff`).

**Getting back to the caller (26 Oct).** A hand-off that someone should answer needs a way to reach the caller. On a call the agent asks for a name and a phone number or email first (`VOICE_STYLE`), and `platform__escalate` takes them as `contact`; they're added to the hand-off as "Contact: name: …, phone: …", so they show on the Handovers page. The spoken lines no longer promise a follow-up they can't keep: a hand-off is "That's one for the team, so I've passed it on.", or "Thanks, I've passed that on, and the team will get back to you on the details you gave." when it has contact details; an approval is "I've passed that to the team to approve." A hand-off on a call with no phone number or email in the call or the hand-off is flagged `handover_without_contact` (one such run starts a repair review). Replayed on the real model: "I'd like a custom package for my cybersecurity firm" → "Could I take your name and a phone number or email so they can get back to you?" (2/2), then the hand-off carried "Contact: name: Jamie Chen, phone: 0412 555 019".

**Answering while the caller speaks (26 Oct).** A model can't read words as they're spoken: each answer is one request on the text so far. So the page drafts the answer at a pause and keeps it only if the caller turns out to have finished, the way speculative answering works in voice-agent frameworks:
- **When.** In a pause of 0.25 s (`DRAFT_PAUSE_MS`) after words that end a sentence, the page sends the words so far as a draft (`POST /voice` with `draft`: a UUID). If the caller's words change (they said more), the draft is dropped (`POST /voice/draft {id, go: false}`, and the fetch is aborted) and a new one starts at the next sentence end. When the turn is sent, a draft of exactly those words (`sameWords`: case and punctuation aside) is played instead of starting again (`go: true`). Drafting mid-sentence was tried first and dropped: with the live words ~1 s behind the voice, those drafts were nearly always thrown away.
- **What a draft may do before the go-ahead.** The model writes and the text streams; the server voices the **first sentence only** (so a dropped draft costs a sentence of speech at most) and holds the rest. The run waits (`RunAgentOptions.hold`, polling a Redis key via `draftDecision()`) before **any tool call** and before **anything is recorded**. A dropped draft does nothing and leaves one `VOICE_DRAFT_DISCARDED` row with its model cost (counted by the spend caps, not shown as a run, not in the conversation or the impact numbers). No answer within 30 s drops it.
- **Who decides.** Only the person whose call it is (`voice-draft-owner-<id>` holds their user and agent; `/voice/draft` checks it).
- **How much it helps today.** With OpenAI's live transcription, little: the full question usually reaches the page only around the time the turn ends, so a draft starts ~0.3 s before the plain request would (measured 26 Oct on the live site; the draft of "Hi there, what's included in the growth package?" started 0.28 s before the confirmed text and was played). The time after that is the model: the first words of Ava's answer took 2.2–3.2 s on the live site (1.8–1.9 s locally; with thinking off it was no faster, 1.9 s, so thinking stays on). A transcriber whose words keep up with the voice (Deepgram Flux, ~0.3 s, which also signals a likely end of turn for exactly this purpose) would let drafts start ~0.7 s sooner. Not set up: it needs a Deepgram account.
- **Cost.** Each dropped draft is a model call (~$0.002–0.004 on Haiku 5.5 with the prompt cached) and at most one sentence of speech; drafts start only at sentence ends, so typically zero to two per turn.

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

**Several voices (22 Oct).** An agent keeps up to 8 recorded voices (`voice.voices`, each with its own consent record); recording another adds it and switches to it, instead of replacing (and deleting) the one before. The voice card lists the stock voice and each saved voice: **Use this voice** switches (`PUT …/voice/clone` with `{ voiceId }` or `{ stock: true }`, audited `VOICE_SWITCHED`), **Remove** asks "Delete it for good?" and then deletes that one at Cartesia (`DELETE …/voice/clone?voiceId=`, audited `VOICE_CLONE_REMOVED`); removing the voice in use brings the stock voice back. A voice cloned before the list existed (only `voice.clonedVoice` set) appears in it and is kept when another is added (`savedVoices()`). **Listen** on any row plays the agent's greeting in that voice without switching (`GET …/voice/preview?voice=stock|<voiceId>`, WAV): spoken through the speech cache, so each voice costs its greeting once against the monthly limit (429 when it's used up) and is free after that.

The recording is not stored by the platform. Cartesia keeps each private voice until it is removed. Reseeding keeps the voices, in use or only saved (the seed doesn't overwrite a voice config that has consent records; dropping them would orphan the copies at Cartesia). Instant cloning needs a paid Cartesia plan (Pro or above).

## 2b. Monthly voice limits (22 Oct)

Cartesia bills by the character (1 credit each, about 780 a minute of speech; Pro is $5 for 100,000 a month, Startup $49 for 1.25 million). So a leaked login or a runaway page can't run up the bill, speech is capped per calendar month (UTC), in `apps/web/src/app/api/agents/[id]/voice/tts-budget.ts`:
- **Whole platform:** `CARTESIA_MONTHLY_CHARACTER_LIMIT`, default 100,000; `0` turns it off.
- **Each business:** `Tenant.settings.voiceLimits.monthlyCharacters`, default 50,000 (about an hour); `0` turns it off.
- **Voices recorded:** `Tenant.settings.voiceLimits.clonesPerMonth`, default 10 (stops record-delete-record churn; counted from `VOICE_CLONED` rows).

Characters are reserved in Redis before each sentence is synthesised and given back if it fails or would go over, so concurrent calls can't race past a cap. Cached lines (greeting, acknowledgements) cost nothing and aren't counted. If a counter is missing it is rebuilt from this month's `VOICE_TURN` and `VOICE_CALL_STARTED` rows (the call start now records what its greeting cost). OpenAI voices aren't counted here.

When a limit is reached: a new call doesn't start (with under 300 characters left) and says why, typed tasks still work; a call in progress carries on with the rest of the answer as text and the note "Speech unavailable: This month's voice limit … has been reached". The voice card shows admins this month's use ("This month: 20,083 of 50,000 characters of speech (about 26 of 64 minutes) · 1 of 10 voices recorded"); the platform total isn't shown to tenants.

Each environment counts in its own Redis, so the caps don't add up across environments sharing one Cartesia key (local development and the demo do): set each environment's platform cap so their sum fits the plan. Tested 22 Oct against local Redis and Postgres (reservations, refusals given back, 0 = no cap, the platform cap across tenants, a counter rebuilt from the audit rows) and in a call: with 300 characters left the opening sentences were spoken and the rest shown with the note, usage stopping at 92,127 of 92,153; with fewer left, starting a call was refused.

## 3. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | Speech-to-text, OpenAI text-to-speech, and document embeddings |
| `SPEECH_STT_PROVIDER` | `openai` | Speech-to-text provider (only `openai` today) |
| `SPEECH_STT_MODEL` | `gpt-4o-mini-transcribe` | Transcription model (see "Poor microphones") |
| `SPEECH_LIVE_STT` | on | `off` sends every turn as a recording instead of transcribing live |
| `SPEECH_LIVE_STT_MODEL` | `gpt-live-transcribe` | Live transcription model |
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
| Speech-to-text, live (gpt-live-transcribe, the default) | ~$0.009 | $0.017 per minute of caller audio (OpenAI, 26 Oct), half of each minute |
| Speech-to-text, uploaded (gpt-4o-mini-transcribe, the fallback) | ~$0.003 | third-party pricing summaries; check OpenAI's pricing page |
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
| `packages/llm/src/speech.ts` | `transcribeAudio`, `hedged`, `streamSpeech` (PCM + word timings), `synthesizeSpeech`, `toSpeakableText`; OpenAI, Cartesia, Deepgram, Speechmatics |
| `apps/web/src/app/api/agents/[id]/voice/speech-cache.ts` | Cached audio for fixed lines (greeting, acknowledgements) in Redis |
| `apps/web/src/app/dashboard/agents/[id]/speech-detector.ts` | Silero voice detector in the browser: a voice, not a noise, interrupts or starts a turn |
| `packages/executor/src/agent.ts` | `VOICE_STYLE` (how to talk on a call) and `platform__end_call`, voice turns only |
| `packages/executor/src/voice.ts` | `voiceConfigSchema`, `readVoiceConfig`, `spokenReply`, `defaultGreeting` |
| `packages/queue/src/queues.ts` | `waitForAgentRun()`: the route waits for the worker's result |
| `apps/web/src/app/api/agents/[id]/voice/route.ts` | Greeting (GET) and voice turn (POST) |
| `apps/web/src/app/dashboard/agents/[id]/VoicePanel.tsx` | Talk panel |
| `packages/db/prisma/seed.ts` | Ava, her playbook (`answer_client_questions`, 5 test cases) and the FAQ document |
| `scripts/reindex-knowledge.ts` | Embed documents for semantic search |

Tests: `packages/llm/src/speech.test.ts` (6, stubbed vendors) and `packages/executor/src/__tests__/voice.test.ts` (2).
