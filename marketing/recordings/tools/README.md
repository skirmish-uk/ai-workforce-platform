# Narrated walkthrough (walkthrough-voiceover.mp4)

Recorded 25 Oct 2026 on the live demo, after `scripts/demo-deploy.sh reset-demo`.
The 8 steps of the in-app Demo guide, narrated, with a real voice call to Ava.

1. `node tts.mjs clips`: narrator and caller lines from `lines.json` (OpenAI gpt-4o-mini-tts, needs OPENAI_API_KEY in the root .env)
2. Reset the demo tenant on live, then `SITE_PASS=... node record.mjs https://khkewhglkw.site take`
   (needs playwright-core and its Firefox; the microphone is faked, and the caller clips are played into it)
3. `python3 edit.py take out.mp4`: speeds up the agent waits (labelled), holds frames where the narration runs long, and mixes the narrator, the caller and Ava
4. Reset live again afterwards: the take leaves a team case, approvals and a staff note behind
