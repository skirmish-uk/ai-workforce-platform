import { z } from 'zod'
import { google } from 'googleapis'
import { BaseIntegrationAdapter, IntegrationAction, IntegrationConfig, OAuthCredentials } from './base'

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
]

export class GmailAdapter extends BaseIntegrationAdapter {
  readonly provider = 'google'
  readonly name = 'Gmail'
  readonly description = 'Send, receive, and manage Gmail messages'
  readonly requiredScopes = GMAIL_SCOPES

  constructor() {
    super('google', 'Gmail', 'Send, receive, and manage Gmail messages', GMAIL_SCOPES)
    this.registerActions()
  }

  private registerActions(): void {
    this.registerAction({
      name: 'send_email',
      description: 'Send an email via Gmail',
      inputSchema: z.object({
        to: z.array(z.string().email()),
        cc: z.array(z.string().email()).optional(),
        bcc: z.array(z.string().email()).optional(),
        subject: z.string().min(1),
        body: z.string(),
        bodyHtml: z.string().optional(),
        threadId: z.string().optional(),
        inReplyTo: z.string().optional(),
      }),
      outputSchema: z.object({
        id: z.string(),
        threadId: z.string(),
        labelIds: z.array(z.string()),
      }),
      execute: async (input, credentials) => {
        const gmail = this.createGmailClient(credentials)
        const { to, cc, bcc, subject, body, bodyHtml, threadId, inReplyTo } = input as any

        const messageParts = [
          `To: ${to.join(', ')}`,
          cc ? `Cc: ${cc.join(', ')}` : '',
          bcc ? `Bcc: ${bcc.join(', ')}` : '',
          `Subject: ${subject}`,
          'MIME-Version: 1.0',
          bodyHtml
            ? `Content-Type: multipart/alternative; boundary="boundary"\n\n--boundary\nContent-Type: text/plain; charset="UTF-8"\n\n${body}\n\n--boundary\nContent-Type: text/html; charset="UTF-8"\n\n${bodyHtml}\n\n--boundary--`
            : `Content-Type: text/plain; charset="UTF-8"\n\n${body}`,
        ].filter(Boolean).join('\n')

        const encodedMessage = Buffer.from(messageParts).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

        const requestBody: any = { raw: encodedMessage }
        if (threadId) requestBody.threadId = threadId

        const response = await gmail.users.messages.send({
          userId: 'me',
          requestBody,
        })

        return response.data
      },
    })

    this.registerAction({
      name: 'list_emails',
      description: 'List emails from Gmail',
      inputSchema: z.object({
        query: z.string().optional(),
        maxResults: z.number().min(1).max(100).default(10),
        labelIds: z.array(z.string()).optional(),
      }),
      outputSchema: z.object({
        messages: z.array(z.object({
          id: z.string(),
          threadId: z.string(),
          labelIds: z.array(z.string()),
          snippet: z.string(),
        })),
        nextPageToken: z.string().optional(),
      }),
      execute: async (input, credentials) => {
        const gmail = this.createGmailClient(credentials)
        const { query, maxResults, labelIds } = input as any

        const response = await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults,
          labelIds,
        })

        return response.data
      },
    })

    this.registerAction({
      name: 'get_email',
      description: 'Get a specific email by ID',
      inputSchema: z.object({
        id: z.string(),
        format: z.enum(['full', 'metadata', 'minimal', 'raw']).default('full'),
      }),
      outputSchema: z.object({
        id: z.string(),
        threadId: z.string(),
        labelIds: z.array(z.string()),
        snippet: z.string(),
        payload: z.unknown().optional(),
        raw: z.string().optional(),
      }),
      execute: async (input, credentials) => {
        const gmail = this.createGmailClient(credentials)
        const { id, format } = input as any

        const response = await gmail.users.messages.get({
          userId: 'me',
          id,
          format,
        })

        return response.data
      },
    })

    this.registerAction({
      name: 'modify_labels',
      description: 'Add or remove labels from an email',
      inputSchema: z.object({
        id: z.string(),
        addLabelIds: z.array(z.string()).optional(),
        removeLabelIds: z.array(z.string()).optional(),
      }),
      outputSchema: z.object({
        id: z.string(),
        threadId: z.string(),
        labelIds: z.array(z.string()),
      }),
      execute: async (input, credentials) => {
        const gmail = this.createGmailClient(credentials)
        const { id, addLabelIds, removeLabelIds } = input as any

        const response = await gmail.users.messages.modify({
          userId: 'me',
          id,
          requestBody: {
            addLabelIds,
            removeLabelIds,
          },
        })

        return response.data
      },
    })

    this.registerAction({
      name: 'create_draft',
      description: 'Create a draft email',
      inputSchema: z.object({
        to: z.array(z.string().email()),
        cc: z.array(z.string().email()).optional(),
        bcc: z.array(z.string().email()).optional(),
        subject: z.string().min(1),
        body: z.string(),
        bodyHtml: z.string().optional(),
      }),
      outputSchema: z.object({
        id: z.string(),
        message: z.object({
          id: z.string(),
          threadId: z.string(),
        }),
      }),
      execute: async (input, credentials) => {
        const gmail = this.createGmailClient(credentials)
        const { to, cc, bcc, subject, body, bodyHtml } = input as any

        const messageParts = [
          `To: ${to.join(', ')}`,
          cc ? `Cc: ${cc.join(', ')}` : '',
          bcc ? `Bcc: ${bcc.join(', ')}` : '',
          `Subject: ${subject}`,
          'MIME-Version: 1.0',
          bodyHtml
            ? `Content-Type: multipart/alternative; boundary="boundary"\n\n--boundary\nContent-Type: text/plain; charset="UTF-8"\n\n${body}\n\n--boundary\nContent-Type: text/html; charset="UTF-8"\n\n${bodyHtml}\n\n--boundary--`
            : `Content-Type: text/plain; charset="UTF-8"\n\n${body}`,
        ].filter(Boolean).join('\n')

        const encodedMessage = Buffer.from(messageParts).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

        const response = await gmail.users.drafts.create({
          userId: 'me',
          requestBody: {
            message: { raw: encodedMessage },
          },
        })

        return response.data
      },
    })

    this.registerAction({
      name: 'search_emails',
      description: 'Search emails with advanced query',
      inputSchema: z.object({
        query: z.string(),
        maxResults: z.number().min(1).max(100).default(20),
      }),
      outputSchema: z.object({
        messages: z.array(z.object({
          id: z.string(),
          threadId: z.string(),
        })),
        resultSizeEstimate: z.number(),
      }),
      execute: async (input, credentials) => {
        const gmail = this.createGmailClient(credentials)
        const { query, maxResults } = input as any

        const response = await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults,
        })

        return response.data
      },
    })
  }

  private createGmailClient(credentials: Record<string, unknown>) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    )

    oauth2Client.setCredentials({
      access_token: credentials.access_token,
      refresh_token: credentials.refresh_token,
      expiry_date: credentials.expires_at,
    })

    return google.gmail({ version: 'v1', auth: oauth2Client })
  }

  authUrl(redirectUri: string, state: string): string {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      redirectUri
    )

    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: this.requiredScopes,
      state,
      prompt: 'consent',
    })
  }

  async exchangeCode(code: string, redirectUri: string): Promise<OAuthCredentials> {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      redirectUri
    )

    const { tokens } = await oauth2Client.getToken(code)
    return {
      access_token: tokens.access_token!,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expiry_date,
      token_type: tokens.token_type,
      scope: tokens.scope,
    }
  }

  async refreshToken(refreshToken: string): Promise<OAuthCredentials> {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    )

    oauth2Client.setCredentials({ refresh_token: refreshToken })
    const { credentials } = await oauth2Client.refreshAccessToken()

    return {
      access_token: credentials.access_token!,
      refresh_token: credentials.refresh_token,
      expires_at: credentials.expiry_date,
      token_type: credentials.token_type,
      scope: credentials.scope,
    }
  }

  async validateCredentials(credentials: Record<string, unknown>): Promise<boolean> {
    try {
      const gmail = this.createGmailClient(credentials)
      await gmail.users.getProfile({ userId: 'me' })
      return true
    } catch {
      return false
    }
  }
}

export const gmailAdapter = new GmailAdapter()