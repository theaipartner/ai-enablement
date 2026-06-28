import { HeaderBand } from '@/components/gregory/header-band'
import {
  getRepCandidates,
  getCloseUsersForPicker,
} from '@/lib/db/sales-rep-verify'
import { RepsVerify } from './_components/reps-verify'

// Sales Dashboard — Verify Reps (admin only; the whole /sales-dashboard segment
// is admin-gated by its layout).
//
// New sales reps land in the Airtable "Sales Team Member" table → mirrored into
// sales_rep_candidates (migration 0109). This page lists the forward-only set
// (created on/after the cutoff) that isn't already a team_member, and lets an
// admin resolve each rep's Close ID + email + role (+ optional Calendly) and
// Complete — which writes the team_members row so the rep auto-appears on every
// per-rep surface (Outbound by-rep, Talent, People, Roster) via the existing
// joins. No per-page wiring.
//
// Docs: docs/sales/surfaces.md § Verify Reps; docs/schema/sales_rep_candidates.md.
export const dynamic = 'force-dynamic'

export default async function RepsPage() {
  const [candidates, closeUsers] = await Promise.all([
    getRepCandidates(),
    getCloseUsersForPicker(),
  ])

  return (
    <>
      <HeaderBand
        eyebrow="SALES · ADMIN"
        title="Verify Reps"
      />
      <p
        style={{
          color: 'var(--color-geg-text-2)',
          fontSize: 13.5,
          maxWidth: 720,
          margin: '8px 0 28px',
          lineHeight: 1.5,
        }}
      >
        New sales reps from Airtable awaiting verification. Resolve each rep&rsquo;s
        Close ID and email (pick from Close or enter manually), set their role,
        and optionally add a Calendly event-type URI. <strong>Save</strong> keeps a
        card open for later; <strong>Complete</strong> adds them to the team and
        makes their stats show across every sales surface. <strong>Delete</strong>{' '}
        dismisses a test or junk record.
      </p>
      <RepsVerify candidates={candidates} closeUsers={closeUsers} />
    </>
  )
}
