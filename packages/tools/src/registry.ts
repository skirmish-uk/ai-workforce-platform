import {
  gmailAdapter,
  calendarAdapter,
  hubspotAdapter,
  driveAdapter,
  type IntegrationAdapter,
  type IntegrationAction,
} from '@ai-workforce/integrations'
import type { LLMTool } from '@ai-workforce/llm'
import { zodToInputSchema } from './schema'

export interface RegisteredTool {
  /**
   * Fully-qualified tool name exposed to the LLM, e.g. "gmail__send_email".
   * Anthropic and OpenAI both reject tool names outside ^[a-zA-Z0-9_-]+$ (no
   * dots), so "__" separates the adapter slug from the action name instead
   * of ".": action names already use single underscores, so "__" stays
   * unambiguous to split back apart.
   */
  toolName: string
  adapter: IntegrationAdapter
  action: IntegrationAction
}

const ADAPTERS: IntegrationAdapter[] = [gmailAdapter, calendarAdapter, hubspotAdapter, driveAdapter]

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

/**
 * Maps LLM-facing tool names to integration adapter actions. Built once from
 * every adapter in `packages/integrations`; new adapters register automatically
 * by being added to the ADAPTERS list above.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()

  constructor(adapters: IntegrationAdapter[]) {
    for (const adapter of adapters) {
      for (const action of adapter.actions) {
        const toolName = `${slugify(adapter.name)}__${action.name}`
        this.tools.set(toolName, { toolName, adapter, action })
      }
    }
  }

  get(toolName: string): RegisteredTool | undefined {
    return this.tools.get(toolName)
  }

  has(toolName: string): boolean {
    return this.tools.has(toolName)
  }

  all(): RegisteredTool[] {
    return Array.from(this.tools.values())
  }

  /**
   * Resolves a Skill's `requiredTools` entries to registered tools. Entries may be
   * fully-qualified ("gmail__send_email") or a bare action name ("send_email"), in
   * which case every adapter exposing that action name is included.
   */
  resolve(requiredTools: string[]): RegisteredTool[] {
    const resolved: RegisteredTool[] = []
    const seen = new Set<string>()

    for (const raw of requiredTools) {
      // Older skill rows used "adapter.action" (e.g. "gmail.send_email"); provider
      // APIs reject dots in tool names, so normalise to the "__" form.
      const wanted = raw.includes('.') && !raw.includes('__') ? raw.replace('.', '__') : raw
      const direct = this.tools.get(wanted)
      if (direct) {
        if (!seen.has(direct.toolName)) {
          resolved.push(direct)
          seen.add(direct.toolName)
        }
        continue
      }

      for (const tool of this.all()) {
        if (tool.action.name === wanted && !seen.has(tool.toolName)) {
          resolved.push(tool)
          seen.add(tool.toolName)
        }
      }
    }

    return resolved
  }

  toLLMTools(tools: RegisteredTool[]): LLMTool[] {
    return tools.map((tool) => ({
      name: tool.toolName,
      description: `[${tool.adapter.name}] ${tool.action.description}`,
      inputSchema: zodToInputSchema(tool.action.inputSchema),
    }))
  }
}

export const toolRegistry = new ToolRegistry(ADAPTERS)
