'use client'

// Section 1 — Identity & Contact.
//
// Client component: each editable field's onSave is an inline closure
// that wraps the appropriate Server Action. Server-only data shapes
// imported as types (the runtime never reaches into lib/db/clients
// from this module).
//
// alternate_emails is editable as a comma-separated text input — no
// dedup, no validation, no collision check by design (see commit).

import type { ClientDetail } from '@/lib/db/clients'
import { Section } from './section'
import { ReadOnlyField } from './read-only-field'
import { EditableField } from './editable-field'
import { EditableTagsField } from './editable-tags-field'
import {
  updateClientAlternateEmailsAction,
  updateClientField,
  updateClientStatusAction,
} from '@/app/(authenticated)/(fulfillment)/clients/[id]/actions'
import { PrimaryCsmField } from '@/app/(authenticated)/(fulfillment)/clients/[id]/primary-csm-field'

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'ghost', label: 'Ghost' },
  { value: 'leave', label: 'Leave' },
  { value: 'churned', label: 'Churned' },
]

export function IdentitySection({ client }: { client: ClientDetail }) {
  const metadata = (client.metadata ?? {}) as Record<string, unknown>
  const alternateEmails = Array.isArray(metadata.alternate_emails)
    ? (metadata.alternate_emails as string[])
    : []
  const altEmailsDisplay =
    alternateEmails.length === 0 ? null : alternateEmails.join(', ')

  const startDateDisplay = client.start_date
    ? new Date(client.start_date).toLocaleDateString()
    : null

  const teamMemberOptions = client.team_members.map((m) => ({
    id: m.id,
    full_name: m.full_name,
  }))

  return (
    <Section title="Identity & Contact">
      <div className="grid grid-cols-2 gap-4">
        <EditableField
          label="Full name"
          value={client.full_name}
          variant="text"
          onSave={(v) =>
            updateClientField(client.id, 'full_name', v as string | null)
          }
        />
        <EditableField
          label="Status"
          value={client.status}
          variant="enum"
          options={STATUS_OPTIONS}
          onSave={(v) =>
            updateClientStatusAction(client.id, v as string, null)
          }
        />

        <PrimaryCsmField
          clientId={client.id}
          currentTeamMemberId={
            client.active_primary_csm?.team_member_id ?? null
          }
          currentTeamMemberName={
            client.active_primary_csm?.team_member_name ?? null
          }
          assignedAt={client.active_primary_csm?.assigned_at ?? null}
          options={teamMemberOptions}
        />
        <EditableField
          label="Email"
          value={client.email}
          variant="text"
          mono
          onSave={(v) =>
            updateClientField(client.id, 'email', v as string | null)
          }
        />

        <EditableField
          label="Alternate emails"
          value={altEmailsDisplay}
          variant="text"
          mono
          placeholder="comma,separated@x.com"
          onSave={(v) =>
            updateClientAlternateEmailsAction(client.id, v as string | null)
          }
        />
        <EditableField
          label="Phone"
          value={client.phone}
          variant="text"
          onSave={(v) =>
            updateClientField(client.id, 'phone', v as string | null)
          }
        />

        <EditableField
          label="Country"
          value={client.country}
          variant="text"
          onSave={(v) =>
            updateClientField(client.id, 'country', v as string | null)
          }
        />
        <EditableField
          label="Time zone"
          value={client.timezone}
          variant="text"
          placeholder="e.g. America/Los_Angeles"
          onSave={(v) =>
            updateClientField(client.id, 'timezone', v as string | null)
          }
        />

        <EditableField
          label="Birth year"
          value={client.birth_year}
          variant="integer"
          placeholder="YYYY"
          displayValue={(v) => (v == null ? '—' : `Born ${v}`)}
          onSave={(v) =>
            updateClientField(client.id, 'birth_year', v as number | null)
          }
        />
        <EditableField
          label="Location"
          value={client.location}
          variant="text"
          onSave={(v) =>
            updateClientField(client.id, 'location', v as string | null)
          }
        />

        <EditableField
          label="Occupation"
          value={client.occupation}
          variant="text"
          onSave={(v) =>
            updateClientField(client.id, 'occupation', v as string | null)
          }
        />

        {/* Truly read-only — system-sourced references */}
        <ReadOnlyField
          label="Slack channel id"
          value={client.slack_channel_id}
          editable={false}
          mono
        />
        <ReadOnlyField
          label="Slack user id"
          value={client.slack_user_id}
          editable={false}
          mono
        />
        <ReadOnlyField
          label="Signup date"
          value={startDateDisplay}
          editable={false}
        />

        <div className="col-span-2">
          <EditableTagsField
            initialTags={client.tags}
            onSave={(nextTags) =>
              updateClientField(client.id, 'tags', nextTags)
            }
          />
        </div>
      </div>
    </Section>
  )
}
