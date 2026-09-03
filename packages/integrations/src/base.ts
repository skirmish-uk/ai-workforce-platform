import { z } from 'zod'

export interface IntegrationConfig {
  id: string
  name: string
  provider: string
  config: Record<string, unknown>
  credentials: Record<string, unknown>
  scopes: string[]
}

export interface IntegrationAction {
  name: string
  description: string
  inputSchema: z.ZodSchema
  outputSchema: z.ZodSchema
  execute: (input: unknown, credentials: Record<string, unknown>) => Promise<unknown>
}

export interface IntegrationAdapter {
  readonly provider: string
  readonly name: string
  readonly description: string
  readonly requiredScopes: string[]
  readonly actions: IntegrationAction[]
  readonly authUrl: (redirectUri: string, state: string) => string
  readonly exchangeCode: (code: string, redirectUri: string) => Promise<Record<string, unknown>>
  readonly refreshToken: (refreshToken: string) => Promise<Record<string, unknown>>
  validateCredentials: (credentials: Record<string, unknown>) => Promise<boolean>
}

export interface OAuthCredentials {
  access_token: string
  refresh_token?: string
  expires_at?: number
  token_type?: string
  scope?: string
}

export class BaseIntegrationAdapter implements IntegrationAdapter {
  readonly provider: string
  readonly name: string
  readonly description: string
  readonly requiredScopes: string[]
  readonly actions: IntegrationAction[] = []

  constructor(provider: string, name: string, description: string, requiredScopes: string[] = []) {
    this.provider = provider
    this.name = name
    this.description = description
    this.requiredScopes = requiredScopes
  }

  authUrl(redirectUri: string, state: string): string {
    throw new Error('Not implemented')
  }

  async exchangeCode(code: string, redirectUri: string): Promise<Record<string, unknown>> {
    throw new Error('Not implemented')
  }

  async refreshToken(refreshToken: string): Promise<Record<string, unknown>> {
    throw new Error('Not implemented')
  }

  async validateCredentials(credentials: Record<string, unknown>): Promise<boolean> {
    throw new Error('Not implemented')
  }

  registerAction(action: IntegrationAction): void {
    this.actions.push(action)
  }
}

export function createIntegrationRegistry(): Map<string, IntegrationAdapter> {
  return new Map()
}