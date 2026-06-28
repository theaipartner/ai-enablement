# sales_rep_verifications

Per-rep **verify state** for the admin sales-rep verify page
(`/sales-dashboard/reps`). One row per Airtable rep (keyed by the Airtable
`rec*` id), holding the admin's in-progress draft and the final outcome. The
mirror crons never write this table — it's purely human-entered state.

Added in migration `0109_sales_rep_verify.sql`.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `airtable_record_id` | `text` | **PK.** The candidate being verified (FK-by-convention to `sales_rep_candidates.airtable_record_id`). |
| `status` | `text` | Not null, default `'draft'`. CHECK-pinned: `draft` (Save — in progress) / `completed` (Complete — `team_members` row written) / `deleted` (Delete — dismissed test/junk). |
| `full_name` | `text` | Edited name. |
| `sales_role` | `text` | CHECK-pinned `setter` / `closer` / `dc_closer`. |
| `email` | `text` | Resolved email (picker auto-fills, or manual). |
| `close_user_id` | `text` | Resolved Close `user_*` id (picker or manual). |
| `calendly_event_type_uri` | `text` | Optional — DC closers can close by phone, so this is never required. |
| `team_member_id` | `uuid` | Set on Complete — the `team_members` row written/updated. |
| `created_by` / `updated_by` | `text` | Admin email (auth identity). |
| `created_at` / `updated_at` | `timestamptz` | `updated_at` bumped by trigger. |

## State machine

- A candidate with **no row here** = untouched/new — shown on the page.
- **`draft`** — Save was used; the card stays open (e.g. rep not in Close yet).
  Still shown, badged DRAFT.
- **`completed`** — Complete wrote the `team_members` row; dropped from the page.
- **`deleted`** — dismissed; dropped from the page. Sticky across re-sync.

## Written By

- `app/(authenticated)/sales-dashboard/reps/actions.ts` — `saveRepDraft`
  (`draft`), `completeRep` (writes `team_members`, then `completed`),
  `deleteRepCandidate` (`deleted`). All admin-gated.

## Read By

- `lib/db/sales-rep-verify.ts` `getRepCandidates()` — joins this onto
  `sales_rep_candidates` to show draft values and exclude completed/deleted.

## Related

- `sales_rep_candidates` — the Airtable mirror this verifies.
- `team_members` — what a completed verification writes (§ Sales identity).
