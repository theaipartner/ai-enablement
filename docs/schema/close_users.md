# close_users

Mirror of the Close **`/user/`** roster — the source for the sales-rep verify
page's **Close-ID picker** (`/sales-dashboard/reps`). One row per Close user.

Added in migration `0109_sales_rep_verify.sql`.

## Why it exists

The verify page lets an admin tie an Airtable rep to their Close identity by
picking from a list of Close users (which fills both `close_user_id` and
`email`). The dashboard reads only Supabase, so the Close roster is mirrored
here. Distinct from the `team_members.close_user_id` sync: the picker needs the
**whole** Close org, including people not yet in `team_members`.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `close_user_id` | `text` | **PK.** Close `user_*` id. |
| `email` | `text` | Close user email. Indexed `lower(email)`. |
| `first_name` / `last_name` | `text` | From Close. |
| `full_name` | `text` | `first + last`, computed at sync. |
| `is_active` | `boolean` | Reserved; not populated today. |
| `synced_at` | `timestamptz` | Not null, default `now()`. Last mirror write. |

## Populated By

`api/close_users_sync_cron.py` (daily) — the same cron that fills
`team_members.close_user_id` by email. It upserts every Close user here in the
same pass.

## Read By

- `lib/db/sales-rep-verify.ts` `getCloseUsersForPicker()`.

## Related

- `team_members` (§ Sales identity) — `close_user_id` is the dials/Calls join key.
- `sales_rep_candidates` / `sales_rep_verifications` — the rest of the verify page.
