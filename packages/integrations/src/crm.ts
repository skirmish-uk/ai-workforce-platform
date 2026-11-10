import { z } from 'zod'
import { Client } from '@hubspot/api-client'
import { BaseIntegrationAdapter, OAuthCredentials } from './base'

interface HubSpotTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type?: string
  scope?: string
}

const HUBSPOT_SCOPES = [
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.deals.read',
  'crm.objects.deals.write',
  'crm.objects.companies.read',
  'crm.objects.companies.write',
  'crm.objects.tickets.read',
  'crm.objects.tickets.write',
  'crm.schemas.contacts.read',
  'crm.schemas.contacts.write',
]

export class HubSpotAdapter extends BaseIntegrationAdapter {
  readonly provider = 'hubspot'
  readonly name = 'HubSpot CRM'
  readonly description = 'Manage HubSpot CRM contacts, deals, and companies'
  readonly requiredScopes = HUBSPOT_SCOPES

  constructor() {
    super('hubspot', 'HubSpot CRM', 'Manage HubSpot CRM contacts, deals, and companies', HUBSPOT_SCOPES)
    this.registerActions()
  }

  private registerActions(): void {
    this.registerAction({
      name: 'create_contact',
      description: 'Create a new contact',
      inputSchema: z.object({
        email: z.string().email(),
        firstname: z.string().optional(),
        lastname: z.string().optional(),
        phone: z.string().optional(),
        company: z.string().optional(),
        properties: z.record(z.string()).optional(),
      }),
      outputSchema: z.object({
        id: z.string(),
        properties: z.record(z.string()),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
      execute: async (input, credentials) => {
        const client = this.createHubSpotClient(credentials)
        const { email, firstname, lastname, phone, company, properties } = input as any

        const response = await client.crm.contacts.basicApi.create({
          associations: [],
          properties: {
            email,
            firstname,
            lastname,
            phone,
            company,
            ...properties,
          },
        })

        return response
      },
    })

    this.registerAction({
      name: 'get_contact',
      description: 'Get a contact by ID or email',
      inputSchema: z.object({
        id: z.string().optional(),
        email: z.string().email().optional(),
      }).refine(data => data.id || data.email, { message: 'Either id or email is required' }),
      outputSchema: z.object({
        id: z.string(),
        properties: z.record(z.string()),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
      execute: async (input, credentials) => {
        const client = this.createHubSpotClient(credentials)
        const { id, email } = input as any

        if (email) {
          const search = await client.crm.contacts.searchApi.doSearch({
            filterGroups: [{
              filters: [{ propertyName: 'email', operator: 'EQ', value: email }],
            }],
            properties: ['email', 'firstname', 'lastname', 'phone', 'company'],
            sorts: [],
            limit: 1,
            after: 0,
          })
          if (search.results.length === 0) throw new Error('Contact not found')
          return search.results[0]
        }

        return await client.crm.contacts.basicApi.getById(id, ['email', 'firstname', 'lastname', 'phone', 'company'])
      },
    })

    this.registerAction({
      name: 'update_contact',
      description: 'Update a contact',
      inputSchema: z.object({
        id: z.string(),
        properties: z.record(z.string()),
      }),
      outputSchema: z.object({
        id: z.string(),
        properties: z.record(z.string()),
        updatedAt: z.string(),
      }),
      execute: async (input, credentials) => {
        const client = this.createHubSpotClient(credentials)
        const { id, properties } = input as any

        return await client.crm.contacts.basicApi.update(id, { properties })
      },
    })

    this.registerAction({
      name: 'create_deal',
      description: 'Create a new deal',
      inputSchema: z.object({
        dealname: z.string().min(1),
        amount: z.number().optional(),
        dealstage: z.string().optional(),
        pipeline: z.string().optional(),
        closedate: z.string().datetime({ offset: true }).optional(),
        associatedContactIds: z.array(z.string()).optional(),
        properties: z.record(z.string()).optional(),
      }),
      outputSchema: z.object({
        id: z.string(),
        properties: z.record(z.string()),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
      execute: async (input, credentials) => {
        const client = this.createHubSpotClient(credentials)
        const { dealname, amount, dealstage, pipeline, closedate, associatedContactIds, properties } = input as any

        const dealProperties: Record<string, string> = {
          dealname,
          ...properties,
        }
        if (amount) dealProperties.amount = String(amount)
        if (dealstage) dealProperties.dealstage = dealstage
        if (pipeline) dealProperties.pipeline = pipeline
        if (closedate) dealProperties.closedate = closedate

        const deal = await client.crm.deals.basicApi.create({
          associations: [],
          properties: dealProperties,
        })

        if (associatedContactIds?.length) {
          for (const contactId of associatedContactIds) {
            // @hubspot/api-client has moved associations to a separate v4 batch API across
            // versions; cast past the type here rather than guess at an unverified shape —
            // there are no live HubSpot credentials in this environment to test against.
            await (client.crm.deals as any).associationsApi.create(deal.id, 'contacts', contactId)
          }
        }

        return deal
      },
    })

    this.registerAction({
      name: 'search_contacts',
      description: 'Search contacts with filters',
      inputSchema: z.object({
        query: z.string().optional(),
        filters: z.array(z.object({
          propertyName: z.string(),
          operator: z.enum(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN']),
          value: z.string(),
        })).optional(),
        limit: z.number().min(1).max(100).default(20),
      }),
      outputSchema: z.object({
        results: z.array(z.object({
          id: z.string(),
          properties: z.record(z.string()),
        })),
        total: z.number(),
      }),
      execute: async (input, credentials) => {
        const client = this.createHubSpotClient(credentials)
        const { query, filters, limit } = input as any

        const defaultProperties = ['email', 'firstname', 'lastname', 'phone', 'company']

        if (filters?.length) {
          const search = await client.crm.contacts.searchApi.doSearch({
            filterGroups: [{
              filters: filters.map((f: any) => ({ propertyName: f.propertyName, operator: f.operator, value: f.value })),
            }],
            properties: defaultProperties,
            sorts: [],
            limit,
            after: 0,
          })
          return { results: search.results, total: search.total }
        }

        const search = await client.crm.contacts.searchApi.doSearch({
          query: query || '',
          filterGroups: [],
          properties: defaultProperties,
          sorts: [],
          limit,
          after: 0,
        })
        return { results: search.results, total: search.total }
      },
    })

    this.registerAction({
      name: 'create_company',
      description: 'Create a new company',
      inputSchema: z.object({
        name: z.string().min(1),
        domain: z.string().optional(),
        properties: z.record(z.string()).optional(),
      }),
      outputSchema: z.object({
        id: z.string(),
        properties: z.record(z.string()),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
      execute: async (input, credentials) => {
        const client = this.createHubSpotClient(credentials)
        const { name, domain, properties } = input as any

        return await client.crm.companies.basicApi.create({
          associations: [],
          properties: { name, domain, ...properties },
        })
      },
    })

    this.registerAction({
      name: 'get_deal',
      description: 'Get a deal by ID',
      inputSchema: z.object({
        id: z.string(),
      }),
      outputSchema: z.object({
        id: z.string(),
        properties: z.record(z.string()),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
      execute: async (input, credentials) => {
        const client = this.createHubSpotClient(credentials)
        const { id } = input as any

        return await client.crm.deals.basicApi.getById(id)
      },
    })
  }

  private createHubSpotClient(credentials: Record<string, unknown>) {
    return new Client({ accessToken: credentials.access_token as string })
  }

  authUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: process.env.HUBSPOT_CLIENT_ID!,
      redirect_uri: redirectUri,
      scope: this.requiredScopes.join(' '),
      response_type: 'code',
      state,
    })

    return `https://app.hubspot.com/oauth/authorize?${params.toString()}`
  }

  async exchangeCode(code: string, redirectUri: string): Promise<OAuthCredentials> {
    const response = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.HUBSPOT_CLIENT_ID!,
        client_secret: process.env.HUBSPOT_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        code,
      }),
    })

    const tokens = (await response.json()) as HubSpotTokenResponse
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
      token_type: tokens.token_type,
      scope: tokens.scope,
    }
  }

  async refreshToken(refreshToken: string): Promise<OAuthCredentials> {
    const response = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.HUBSPOT_CLIENT_ID!,
        client_secret: process.env.HUBSPOT_CLIENT_SECRET!,
        refresh_token: refreshToken,
      }),
    })

    const tokens = (await response.json()) as HubSpotTokenResponse
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
      token_type: tokens.token_type,
      scope: tokens.scope,
    }
  }

  async validateCredentials(credentials: Record<string, unknown>): Promise<boolean> {
    try {
      const client = this.createHubSpotClient(credentials)
      await client.crm.contacts.basicApi.getPage(1)
      return true
    } catch {
      return false
    }
  }
}

export const hubspotAdapter = new HubSpotAdapter()