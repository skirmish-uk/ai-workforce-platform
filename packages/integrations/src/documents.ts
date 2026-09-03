import { z } from 'zod'
import { google } from 'googleapis'
import { BaseIntegrationAdapter, OAuthCredentials } from './base'

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
]

export class DriveAdapter extends BaseIntegrationAdapter {
  readonly provider = 'google'
  readonly name = 'Google Drive'
  readonly description = 'Manage files and folders in Google Drive'
  readonly requiredScopes = DRIVE_SCOPES

  constructor() {
    super('google', 'Google Drive', 'Manage files and folders in Google Drive', DRIVE_SCOPES)
    this.registerActions()
  }

  private registerActions(): void {
    this.registerAction({
      name: 'upload_file',
      description: 'Upload a file to Google Drive',
      inputSchema: z.object({
        name: z.string().min(1),
        content: z.string(), // base64 encoded
        mimeType: z.string().optional(),
        parents: z.array(z.string()).optional(),
      }),
      outputSchema: z.object({
        id: z.string(),
        name: z.string(),
        mimeType: z.string(),
        webViewLink: z.string(),
      }),
      execute: async (input, credentials) => {
        const drive = this.createDriveClient(credentials)
        const { name, content, mimeType, parents } = input as any

        const buffer = Buffer.from(content, 'base64')

        const response = await drive.files.create({
          requestBody: {
            name,
            mimeType: mimeType || 'application/octet-stream',
            parents,
          },
          media: {
            mimeType: mimeType || 'application/octet-stream',
            body: buffer,
          },
          fields: 'id,name,mimeType,webViewLink',
        })

        return response.data
      },
    })

    this.registerAction({
      name: 'create_folder',
      description: 'Create a folder in Google Drive',
      inputSchema: z.object({
        name: z.string().min(1),
        parents: z.array(z.string()).optional(),
      }),
      outputSchema: z.object({
        id: z.string(),
        name: z.string(),
        webViewLink: z.string(),
      }),
      execute: async (input, credentials) => {
        const drive = this.createDriveClient(credentials)
        const { name, parents } = input as any

        const response = await drive.files.create({
          requestBody: {
            name,
            mimeType: 'application/vnd.google-apps.folder',
            parents,
          },
          fields: 'id,name,webViewLink',
        })

        return response.data
      },
    })

    this.registerAction({
      name: 'list_files',
      description: 'List files in Google Drive',
      inputSchema: z.object({
        query: z.string().optional(),
        pageSize: z.number().min(1).max(1000).default(20),
        orderBy: z.string().optional(),
      }),
      outputSchema: z.object({
        files: z.array(z.object({
          id: z.string(),
          name: z.string(),
          mimeType: z.string(),
          size: z.string().optional(),
          modifiedTime: z.string(),
          webViewLink: z.string(),
        })),
        nextPageToken: z.string().optional(),
      }),
      execute: async (input, credentials) => {
        const drive = this.createDriveClient(credentials)
        const { query, pageSize, orderBy } = input as any

        const response = await drive.files.list({
          q: query,
          pageSize,
          orderBy,
          fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)',
        })

        return response.data
      },
    })

    this.registerAction({
      name: 'get_file',
      description: 'Get file metadata by ID',
      inputSchema: z.object({
        fileId: z.string(),
      }),
      outputSchema: z.object({
        id: z.string(),
        name: z.string(),
        mimeType: z.string(),
        size: z.string().optional(),
        modifiedTime: z.string(),
        webViewLink: z.string(),
      }),
      execute: async (input, credentials) => {
        const drive = this.createDriveClient(credentials)
        const { fileId } = input as any

        const response = await drive.files.get({
          fileId,
          fields: 'id,name,mimeType,size,modifiedTime,webViewLink',
        })

        return response.data
      },
    })

    this.registerAction({
      name: 'download_file',
      description: 'Download file content',
      inputSchema: z.object({
        fileId: z.string(),
      }),
      outputSchema: z.object({
        content: z.string(), // base64 encoded
        mimeType: z.string(),
      }),
      execute: async (input, credentials) => {
        const drive = this.createDriveClient(credentials)
        const { fileId } = input as any

        const response = await drive.files.get({
          fileId,
          alt: 'media',
        }, { responseType: 'arraybuffer' })

        const content = Buffer.from(response.data).toString('base64')
        const metaResponse = await drive.files.get({ fileId, fields: 'mimeType' })

        return {
          content,
          mimeType: metaResponse.data.mimeType,
        }
      },
    })

    this.registerAction({
      name: 'delete_file',
      description: 'Delete a file (move to trash)',
      inputSchema: z.object({
        fileId: z.string(),
      }),
      outputSchema: z.object({ success: z.boolean() }),
      execute: async (input, credentials) => {
        const drive = this.createDriveClient(credentials)
        const { fileId } = input as any

        await drive.files.update({
          fileId,
          requestBody: { trashed: true },
        })

        return { success: true }
      },
    })

    this.registerAction({
      name: 'search_files',
      description: 'Search files by name or content',
      inputSchema: z.object({
        query: z.string(),
        pageSize: z.number().min(1).max(1000).default(20),
      }),
      outputSchema: z.object({
        files: z.array(z.object({
          id: z.string(),
          name: z.string(),
          mimeType: z.string(),
          modifiedTime: z.string(),
        })),
      }),
      execute: async (input, credentials) => {
        const drive = this.createDriveClient(credentials)
        const { query, pageSize } = input as any

        const response = await drive.files.list({
          q: `name contains '${query}' or fullText contains '${query}'`,
          pageSize,
          fields: 'files(id,name,mimeType,modifiedTime)',
        })

        return response.data
      },
    })
  }

  private createDriveClient(credentials: Record<string, unknown>) {
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

    return google.drive({ version: 'v3', auth: oauth2Client })
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
      const drive = this.createDriveClient(credentials)
      await drive.about.get({ fields: 'user' })
      return true
    } catch {
      return false
    }
  }
}

export const driveAdapter = new DriveAdapter()