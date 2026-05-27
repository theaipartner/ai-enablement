'use client'

// Section 7 — Notes.
//
// Single textarea inline-edit on clients.notes. Display mode shows
// "No notes yet — click to add" when empty (with a dashed border for
// the empty-state cue). Edit mode is a multi-line textarea; saves on
// blur or Cmd/Ctrl+Enter. Markdown rendering deferred to V1.1.

import type { ClientDetail } from '@/lib/db/clients'
import { Section } from './section'
import { EditableField } from './editable-field'
import { updateClientField } from '@/app/(authenticated)/(fulfillment)/clients/[id]/actions'

export function NotesSection({ client }: { client: ClientDetail }) {
  return (
    <Section title="Notes">
      <EditableField
        label="Free-text notes"
        value={client.notes}
        variant="textarea"
        mono
        placeholder="Anything worth remembering about this client…"
        onSave={(v) =>
          updateClientField(client.id, 'notes', v as string | null)
        }
      />
    </Section>
  )
}
