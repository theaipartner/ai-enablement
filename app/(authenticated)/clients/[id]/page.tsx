import { notFound } from 'next/navigation'
import { getClientById } from '@/lib/db/clients'
import { listMergeCandidates } from '@/lib/db/merge'
import { Separator } from '@/components/ui/separator'
import { StatusPill, JourneyStagePill, NeedsReviewPill } from '../pills'
import { BackToClientsButton } from './back-to-clients-button'
import { MergeClientButton } from './merge-client-button'

import { IdentitySection } from '@/components/client-detail/identity-section'
import { LifecycleSection } from '@/components/client-detail/lifecycle-section'
import { FinancialsSection } from '@/components/client-detail/financials-section'
import { ActivitySection } from '@/components/client-detail/activity-section'
import { ProfileSection } from '@/components/client-detail/profile-section'
import { AdoptionSection } from '@/components/client-detail/adoption-section'
import { NotesSection } from '@/components/client-detail/notes-section'

// V3 7-section layout (M4 Chunk B1 — read-only).
//
// Every editable field renders read-only with a hover affordance that
// signals "click to edit." B2 wires up inline editing per-section.
// Existing edit-mode infrastructure (inline-fields.tsx, primary-csm-
// field.tsx, actions.ts) is preserved on disk for B2 to reuse.
//
// The needs_review / merge UI from M3.2 is preserved unchanged — it
// sits above Section 1 and is orthogonal to the section structure.

export default async function ClientDetailPage({
  params,
}: {
  params: { id: string }
}) {
  const client = await getClientById(params.id)
  if (!client) {
    notFound()
  }

  const hasNeedsReview = client.tags.includes('needs_review')
  const mergeCandidates = hasNeedsReview
    ? await listMergeCandidates(client.id)
    : []

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <BackToClientsButton />
      </div>

      <div className="space-y-1.5">
        <h1 className="text-3xl font-semibold">{client.full_name}</h1>
        <div className="flex flex-wrap gap-2 items-center">
          <StatusPill status={client.status} />
          <JourneyStagePill stage={client.journey_stage} />
          {hasNeedsReview ? (
            <>
              <NeedsReviewPill />
              <MergeClientButton
                sourceId={client.id}
                sourceFullName={client.full_name}
                candidates={mergeCandidates}
              />
            </>
          ) : null}
        </div>
      </div>

      <Separator />

      <IdentitySection client={client} />
      <Separator />

      <LifecycleSection client={client} />
      <Separator />

      <FinancialsSection client={client} />
      <Separator />

      <ActivitySection client={client} />
      <Separator />

      <ProfileSection client={client} />
      <Separator />

      <AdoptionSection client={client} />
      <Separator />

      <NotesSection client={client} />
    </div>
  )
}
