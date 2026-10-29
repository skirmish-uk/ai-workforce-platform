import { zodToJsonSchema } from 'zod-to-json-schema'
import type { z } from 'zod'

/**
 * Converts a Zod schema (as used by IntegrationAction.inputSchema) into the
 * plain JSON Schema object shape both Anthropic and OpenAI tool-calling APIs expect.
 */
export function zodToInputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<string, unknown>
  delete json.$schema
  if (json.type === undefined) {
    json.type = 'object'
  }
  return json
}
