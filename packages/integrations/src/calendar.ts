import { z } from 'zod'
import { google } from 'googleapis'
import { BaseIntegrationAdapter, OAuthCredentials } from './base'

const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
]

export class CalendarAdapter extends BaseIntegrationAdapter {
  readonly provider = 'google'
  readonly name = 'Google Calendar'
  readonly description = 'Manage Google Calendar events and schedules'
  readonly requiredScopes = CALENDAR_SCOPES

  constructor() {
    super('google', 'Google Calendar', 'Manage Google Calendar events and schedules', CALENDAR_SCOPES)
    this.registerActions()
  }

  private registerActions(): void {
    this.registerAction({
      name: 'create_event',
      description: 'Create a calendar event',
      inputSchema: z.object({
        summary: z.string().min(1),
        description: z.string().optional(),
        location: z.string().optional(),
        startTime: z.string().datetime(),
        endTime: z.string().datetime(),
        timeZone: z.string().default('UTC'),
        attendees: z.array(z.object({
          email: z.string().email(),
          displayName: z.string().optional(),
          responseStatus: z.enum(['needsAction', 'declined', 'tentative', 'accepted']).optional(),
        })).optional(),
        recurrence: z.array(z.string()).optional(),
        reminders: z.object({
          useDefault: z.boolean().default(true),
          overrides: z.array(z.object({
            method: z.enum(['email', 'popup']),
            minutes: z.number().int().positive(),
          })).optional(),
        }).optional(),
      }),
      outputSchema: z.object({
        id: z.string(),
        htmlLink: z.string(),
        summary: z.string(),
        start: z.object({ dateTime: z.string(), timeZone: z.string() }),
        end: z.object({ dateTime: z.string(), timeZone: z.string() }),
      }),
      execute: async (input, credentials) => {
        const calendar = this.createCalendarClient(credentials)
        const eventData = input as any

        const response = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: {
            summary: eventData.summary,
            description: eventData.description,
            location: eventData.location,
            start: {
              dateTime: eventData.startTime,
              timeZone: eventData.timeZone,
            },
            end: {
              dateTime: eventData.endTime,
              timeZone: eventData.timeZone,
            },
            attendees: eventData.attendees?.map((a: any) => ({ email: a.email, displayName: a.displayName, responseStatus: a.responseStatus })),
            recurrence: eventData.recurrence,
            reminders: eventData.reminders || { useDefault: true },
          },
        })

        return response.data
      },
    })

    this.registerAction({
      name: 'list_events',
      description: 'List calendar events',
      inputSchema: z.object({
        timeMin: z.string().datetime().optional(),
        timeMax: z.string().datetime().optional(),
        maxResults: z.number().min(1).max(250).default(20),
        singleEvents: z.boolean().default(true),
        orderBy: z.enum(['startTime', 'updated']).default('startTime'),
      }),
      outputSchema: z.object({
        items: z.array(z.object({
          id: z.string(),
          summary: z.string(),
          description: z.string().optional(),
          start: z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string() }),
          end: z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string() }),
          htmlLink: z.string(),
          status: z.string(),
        })),
        nextPageToken: z.string().optional(),
      }),
      execute: async (input, credentials) => {
        const calendar = this.createCalendarClient(credentials)
        const { timeMin, timeMax, maxResults, singleEvents, orderBy } = input as any

        const response = await calendar.events.list({
          calendarId: 'primary',
          timeMin: timeMin || new Date().toISOString(),
          timeMax,
          maxResults,
          singleEvents,
          orderBy,
        })

        return response.data
      },
    })

    this.registerAction({
      name: 'get_event',
      description: 'Get a specific calendar event',
      inputSchema: z.object({
        eventId: z.string(),
      }),
      outputSchema: z.object({
        id: z.string(),
        summary: z.string(),
        description: z.string().optional(),
        start: z.object({ dateTime: z.string(), timeZone: z.string() }),
        end: z.object({ dateTime: z.string(), timeZone: z.string() }),
        htmlLink: z.string(),
      }),
      execute: async (input, credentials) => {
        const calendar = this.createCalendarClient(credentials)
        const { eventId } = input as any

        const response = await calendar.events.get({
          calendarId: 'primary',
          eventId,
        })

        return response.data
      },
    })

    this.registerAction({
      name: 'update_event',
      description: 'Update a calendar event',
      inputSchema: z.object({
        eventId: z.string(),
        summary: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        startTime: z.string().datetime().optional(),
        endTime: z.string().datetime().optional(),
        attendees: z.array(z.object({
          email: z.string().email(),
          displayName: z.string().optional(),
        })).optional(),
      }),
      outputSchema: z.object({
        id: z.string(),
        summary: z.string(),
        htmlLink: z.string(),
      }),
      execute: async (input, credentials) => {
        const calendar = this.createCalendarClient(credentials)
        const { eventId, ...updates } = input as any

        const existing = await calendar.events.get({ calendarId: 'primary', eventId })
        
        const response = await calendar.events.patch({
          calendarId: 'primary',
          eventId,
          requestBody: {
            ...existing.data,
            ...updates,
            start: updates.startTime ? { dateTime: updates.startTime, timeZone: 'UTC' } : existing.data.start,
            end: updates.endTime ? { dateTime: updates.endTime, timeZone: 'UTC' } : existing.data.end,
          },
        })

        return response.data
      },
    })

    this.registerAction({
      name: 'delete_event',
      description: 'Delete a calendar event',
      inputSchema: z.object({
        eventId: z.string(),
        sendUpdates: z.enum(['all', 'externalOnly', 'none']).default('all'),
      }),
      outputSchema: z.object({ success: z.boolean() }),
      execute: async (input, credentials) => {
        const calendar = this.createCalendarClient(credentials)
        const { eventId, sendUpdates } = input as any

        await calendar.events.delete({
          calendarId: 'primary',
          eventId,
          sendUpdates,
        })

        return { success: true }
      },
    })

    this.registerAction({
      name: 'find_free_time',
      description: 'Find free time slots',
      inputSchema: z.object({
        timeMin: z.string().datetime(),
        timeMax: z.string().datetime(),
        durationMinutes: z.number().int().positive().default(30),
      }),
      outputSchema: z.object({
        freeSlots: z.array(z.object({
          start: z.string().datetime(),
          end: z.string().datetime(),
        })),
      }),
      execute: async (input, credentials) => {
        const calendar = this.createCalendarClient(credentials)
        const { timeMin, timeMax, durationMinutes } = input as any

        const response = await calendar.freebusy.query({
          requestBody: {
            timeMin,
            timeMax,
            items: [{ id: 'primary' }],
          },
        })

        const busy = response.data.calendars?.primary?.busy || []
        const freeSlots: Array<{ start: string; end: string }> = []
        let currentStart = new Date(timeMin)
        const endTime = new Date(timeMax)

        for (const period of busy) {
          const busyStart = new Date(period.start!)
          const busyEnd = new Date(period.end!)

          if (currentStart < busyStart) {
            const diffMinutes = (busyStart.getTime() - currentStart.getTime()) / (1000 * 60)
            if (diffMinutes >= (input as any).durationMinutes) {
              freeSlots.push({
                start: currentStart.toISOString(),
                end: new Date(Math.min(busyStart.getTime(), currentStart.getTime() + durationMinutes * 60 * 1000)).toISOString(),
              })
            }
          }
          currentStart = new Date(Math.max(currentStart.getTime(), busyEnd.getTime()))
        }

        if (currentStart < endTime) {
          const diffMinutes = (endTime.getTime() - currentStart.getTime()) / (1000 * 60)
          if (diffMinutes >= (input as any).durationMinutes) {
            freeSlots.push({
              start: currentStart.toISOString(),
              end: new Date(currentStart.getTime() + durationMinutes * 60 * 1000).toISOString(),
            })
          }
        }

        return { freeSlots }
      },
    })
  }

  private createCalendarClient(credentials: Record<string, unknown>) {
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

    return google.calendar({ version: 'v3', auth: oauth2Client })
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
      const calendar = this.createCalendarClient(credentials)
      await calendar.calendarList.list({ maxResults: 1 })
      return true
    } catch {
      return false
    }
  }
}

export const calendarAdapter = new CalendarAdapter()