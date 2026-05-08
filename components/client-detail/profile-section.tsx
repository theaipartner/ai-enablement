'use client'

// Section 5 — Profile & Background.
//
// All seven fields write to clients.metadata.profile.* (jsonb sub-
// object) via updateClientProfileFieldAction → read-modify-write that
// preserves alternate_emails / alternate_names and any other top-level
// metadata keys. Race risk: concurrent edits to different sub-fields
// can clobber each other (followup logged for V1.1).
//
// Defensive read accessors throughout — metadata may be null, may
// not have profile, may have malformed types. Read what's readable,
// edit-mode renders empty for non-string values.

import type { ClientDetail } from '@/lib/db/clients'
import { Section } from './section'
import { EditableField } from './editable-field'
import { updateClientProfileFieldAction } from '@/app/(authenticated)/clients/[id]/actions'

type ProfileShape = {
  niche?: unknown
  offer?: unknown
  traffic_strategy?: unknown
  swot?: {
    strengths?: unknown
    weaknesses?: unknown
    opportunities?: unknown
    threats?: unknown
  }
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function ProfileSection({ client }: { client: ClientDetail }) {
  const metadata = (client.metadata ?? {}) as Record<string, unknown>
  const profile = (metadata.profile ?? {}) as ProfileShape
  const swot = (profile.swot ?? {}) as ProfileShape['swot']

  return (
    <Section title="Profile & Background" defaultOpen={false}>
      <div className="space-y-3">
        <EditableField
          label="Niche"
          value={asString(profile.niche)}
          variant="text"
          onSave={(v) =>
            updateClientProfileFieldAction(
              client.id,
              'niche',
              v as string | null,
            )
          }
        />
        <EditableField
          label="Offer"
          value={asString(profile.offer)}
          variant="text"
          onSave={(v) =>
            updateClientProfileFieldAction(
              client.id,
              'offer',
              v as string | null,
            )
          }
        />
        <EditableField
          label="Traffic strategy"
          value={asString(profile.traffic_strategy)}
          variant="text"
          onSave={(v) =>
            updateClientProfileFieldAction(
              client.id,
              'traffic_strategy',
              v as string | null,
            )
          }
        />
      </div>

      <div className="space-y-2 pt-2">
        <h3 className="text-sm font-medium text-muted-foreground">SWOT</h3>
        <div className="grid grid-cols-2 gap-3">
          <EditableField
            label="Strengths"
            value={asString(swot?.strengths)}
            variant="textarea"
            onSave={(v) =>
              updateClientProfileFieldAction(
                client.id,
                'swot.strengths',
                v as string | null,
              )
            }
          />
          <EditableField
            label="Weaknesses"
            value={asString(swot?.weaknesses)}
            variant="textarea"
            onSave={(v) =>
              updateClientProfileFieldAction(
                client.id,
                'swot.weaknesses',
                v as string | null,
              )
            }
          />
          <EditableField
            label="Opportunities"
            value={asString(swot?.opportunities)}
            variant="textarea"
            onSave={(v) =>
              updateClientProfileFieldAction(
                client.id,
                'swot.opportunities',
                v as string | null,
              )
            }
          />
          <EditableField
            label="Threats"
            value={asString(swot?.threats)}
            variant="textarea"
            onSave={(v) =>
              updateClientProfileFieldAction(
                client.id,
                'swot.threats',
                v as string | null,
              )
            }
          />
        </div>
      </div>
    </Section>
  )
}
