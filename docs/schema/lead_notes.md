# lead_notes

Free-text scratchpad note per Close lead, shown + edited on the per-lead page
(`/sales-dashboard/leads/[close_id]`). Migration `0090_lead_notes.sql`.

## Purpose

A simple human note on a lead — one editable text box. You type into it and
save; the full text overwrites the prior note (it is **not** a timestamped
thread of entries). Any logged-in team member can edit; it's a shared note, not
per-user.

Standalone (keyed by `close_id`, **no FK** to `close_leads`) so a Close re-sync
can never touch it — same reasoning as the `excluded_at` soft-hide.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `close_id` | `text` | PK. The Close lead id (matches `close_leads.close_id`). One note per lead. |
| `note` | `text` | The note body. Defaults to `''`. |
| `updated_by` | `text` | `full_name` of the team member who last saved (from `team_members`). |
| `created_at` | `timestamptz` | Row creation. |
| `updated_at` | `timestamptz` | Last save — via `set_updated_at` trigger. |

## Written by

`saveLeadNote` server action
(`app/(authenticated)/sales-dashboard/leads/[close_id]/actions.ts`) — upsert on
`close_id`. Gated to any resolved `team_members` row.

## Read by

`getLeadNote` (`lib/db/lead-notes.ts`) → the per-lead page's Notes section
(`components/sales/lead-notes.tsx`).
