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
  // Index signature so concrete adapters (whose exchangeCode/refreshToken narrow the
  // return type to OAuthCredentials) stay structurally assignable to IntegrationAdapter,
  // whose interface commits to Promise<Record<string, unknown>>.
  [key: string]: unknown
}

/** Normalizes Google's nullable OAuth2Client token fields into OAuthCredentials. */
export function fromGoogleTokens(tokens: {
  access_token?: string | null
  refresh_token?: string | null
  expiry_date?: number | null
  token_type?: string | null
  scope?: string | null
}): OAuthCredentials {
  return {
    access_token: tokens.access_token ?? '',
    refresh_token: tokens.refresh_token ?? undefined,
    expires_at: tokens.expiry_date ?? undefined,
    token_type: tokens.token_type ?? undefined,
    scope: tokens.scope ?? undefined,
  }
}

/** Reconstructs the shape google.auth.OAuth2Client.setCredentials() expects from stored JSON credentials. */
export function toGoogleCredentials(credentials: Record<string, unknown>): {
  access_token?: string
  refresh_token?: string
  expiry_date?: number
} {
  return {
    access_token: typeof credentials.access_token === 'string' ? credentials.access_token : undefined,
    refresh_token: typeof credentials.refresh_token === 'string' ? credentials.refresh_token : undefined,
    expiry_date: typeof credentials.expires_at === 'number' ? credentials.expires_at : undefined,
  }
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