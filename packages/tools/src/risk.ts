/**
 * Static risk profile for every registered tool. The model never sees or sets
 * these — they are the application-side half of "identity is enforced by
 * permissions, not by the prompt". Anything not listed here is treated as an
 * irreversible, non-idempotent write (the most conservative class).
 */
export type ToolRiskClass =
  /** Reads data; no external side effect. */
  | 'read'
  /** Creates a draft/preview that nobody else sees until a human acts on it. */
  | 'draft'
  /** Writes that can be corrected or undone (CRM fields, labels, uploads). */
  | 'write_reversible'
  /** Sends something to a person outside the platform (email, calendar invites). */
  | 'external_communication'
  /** Deletes or overwrites data. */
  | 'destructive'
  /** Anything else with permanent effect, including unknown tools. */
  | 'write_irreversible'

export interface ToolRiskProfile {
  risk: ToolRiskClass
  /**
   * True when repeating the call with identical arguments cannot cause a
   * duplicate side effect. Non-idempotent calls are deduplicated by the
   * executor and are never blindly retried after a timeout.
   */
  idempotent: boolean
  /** Shown to approvers: what happens in the outside world if this runs. */
  sideEffects: string
}

const READ: ToolRiskProfile = { risk: 'read', idempotent: true, sideEffects: 'None (read-only).' }

const PROFILES: Record<string, ToolRiskProfile> = {
  // Gmail
  gmail__list_emails: READ,
  gmail__get_email: READ,
  gmail__search_emails: READ,
  gmail__create_draft: { risk: 'draft', idempotent: false, sideEffects: 'Creates an unsent draft in the mailbox.' },
  gmail__modify_labels: { risk: 'write_reversible', idempotent: true, sideEffects: 'Adds/removes labels on a message.' },
  gmail__send_email: {
    risk: 'external_communication',
    idempotent: false,
    sideEffects: 'Sends an email to external recipients as the connected account. Cannot be recalled.',
  },

  // Google Calendar — creating/updating events emails invitations to attendees.
  'google-calendar__list_events': READ,
  'google-calendar__get_event': READ,
  'google-calendar__find_free_time': READ,
  'google-calendar__create_event': {
    risk: 'external_communication',
    idempotent: false,
    sideEffects: 'Creates a calendar event and sends invitations to any attendees.',
  },
  'google-calendar__update_event': {
    risk: 'external_communication',
    idempotent: true,
    sideEffects: 'Changes an event and notifies attendees of the update.',
  },
  'google-calendar__delete_event': { risk: 'destructive', idempotent: true, sideEffects: 'Deletes an event and notifies attendees.' },

  // HubSpot CRM
  'hubspot-crm__get_contact': READ,
  'hubspot-crm__search_contacts': READ,
  'hubspot-crm__get_deal': READ,
  'hubspot-crm__create_contact': { risk: 'write_reversible', idempotent: false, sideEffects: 'Creates a CRM contact record.' },
  'hubspot-crm__update_contact': { risk: 'write_reversible', idempotent: true, sideEffects: 'Overwrites fields on a CRM contact.' },
  'hubspot-crm__create_deal': { risk: 'write_reversible', idempotent: false, sideEffects: 'Creates a CRM deal record.' },
  'hubspot-crm__create_company': { risk: 'write_reversible', idempotent: false, sideEffects: 'Creates a CRM company record.' },

  // Google Drive
  'google-drive__list_files': READ,
  'google-drive__get_file': READ,
  'google-drive__download_file': READ,
  'google-drive__search_files': READ,
  'google-drive__upload_file': { risk: 'write_reversible', idempotent: false, sideEffects: 'Uploads a new file to Drive.' },
  'google-drive__create_folder': { risk: 'write_reversible', idempotent: false, sideEffects: 'Creates a Drive folder.' },
  'google-drive__delete_file': { risk: 'destructive', idempotent: true, sideEffects: 'Permanently deletes a Drive file.' },
}

const UNKNOWN: ToolRiskProfile = {
  risk: 'write_irreversible',
  idempotent: false,
  sideEffects: 'Unclassified tool — treated as an irreversible external write.',
}

export function getToolRiskProfile(toolName: string): ToolRiskProfile {
  return PROFILES[toolName] ?? UNKNOWN
}

/** Risk classes that require human approval by default (brief §9 approval policy). */
export const HIGH_RISK_CLASSES: ReadonlySet<ToolRiskClass> = new Set([
  'external_communication',
  'destructive',
  'write_irreversible',
])

export function isHighRisk(risk: ToolRiskClass): boolean {
  return HIGH_RISK_CLASSES.has(risk)
}

export function knownToolRiskProfiles(): Record<string, ToolRiskProfile> {
  return { ...PROFILES }
}
