import { config } from 'dotenv'
import path from 'node:path'

/**
 * Unlike `next dev`, a plain `tsx` invocation of this worker process does not
 * auto-load .env. Import this module FIRST (before any other import) in any
 * standalone entrypoint so process.env is populated before @ai-workforce/db's
 * PrismaClient or any LLM client construction reads it at module-eval time.
 * Resolved relative to this file rather than process.cwd() so it works the
 * same whether invoked from the repo root or via `npm run start --workspace`.
 */
const loaded = config({ path: path.resolve(__dirname, '../../../.env') })
// dotenv never overrides a variable that is already set, even to an empty string, so an empty
// OPENAI_API_KEY exported by the shell would hide the real one in .env. Treat empty as unset.
for (const [key, value] of Object.entries(loaded.parsed ?? {})) {
  if (process.env[key] === '' && value !== '') process.env[key] = value
}

