# sales_rep_candidates

Mirror of the Airtable **"Sales Team Member"** table — the candidate roster for
the admin sales-rep **verify page** (`/sales-dashboard/reps`). One row per
Airtable rep record.

Added in migration `0109_sales_rep_verify.sql`.

## Why it exists

A new sales rep first appears in Airtable (base `appCWa6TV6p7EBarC`, table
`tblpSaR3Iq4vBBbpO`). The dashboard reads only Supabase, so a Python cron mirrors
that Airtable table here; the verify page then surfaces new reps awaiting
verification. Critically, **each Airtable record id is a
`team_members.airtable_user_id`** — the one rep-identity join key that has no
other sync. The Airtable table holds name + Job Title + Active **but not** email,
Close ID, or Calendly, so those are resolved on the verify page, not read here.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `airtable_record_id` | `text` | **PK.** The Airtable `rec*` id == `team_members.airtable_user_id`. |
| `full_name` | `text` | Airtable `Name`. |
| `first_name` | `text` | Airtable `First Name`. |
| `last_name` | `text` | Airtable `Last Name`. |
| `job_title` | `text` | Airtable `Job Title` single-select (`Closer` / `Setter` / `Sales Manager` / `Client Success Manager`). Drives the verify page's default `sales_role` guess (Closer→closer, Setter→setter; else none). |
| `is_active` | `boolean` | Airtable `Active` checkbox. |
| `airtable_created_at` | `timestamptz` | Airtable record `createdTime`. Drives the **forward-only cutoff** — only reps created on/after the cutoff surface. |
| `synced_at` | `timestamptz` | Not null, default `now()`. Last mirror write. |

## Populated By

`api/sales_rep_candidates_sync_cron.py` (Vercel cron, every 30 min). It fetches
the Airtable table filtered to `IS_AFTER(CREATED_TIME(), <VERIFY_CUTOFF>)` and
upserts each parsed row (`ingestion.airtable.parser.parse_sales_team_member`).
The cron only mirrors; it never writes `sales_rep_verifications`.

## Read By

- `lib/db/sales-rep-verify.ts` `getRepCandidates()` — forward-only rows
  (`airtable_created_at >= SALES_REP_VERIFY_CUTOFF`) not already mapped into
  `team_members` and not dismissed/completed in `sales_rep_verifications`.

## Related

- `sales_rep_verifications` — the human draft + final state per candidate.
- `close_users` — the Close-ID picker source on the same page.
- `team_members` — the row a completed verification writes (§ Sales identity).
