# clients

Customers of the agency. One row per individual person in a program.

## Purpose

Canonical record for each client. Kept deliberately lightweight for V1 — the long tail of attributes lives in `metadata` and `tags` until query patterns justify promoting fields to columns. Company-level grouping is not modeled yet; if B2B programs demand it, a future `companies` table joins in without reshaping this one.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | PK |
| `email` | `text` | Not null. Partial-unique where `archived_at is null`. Primary join key for Fathom participants and Slack Connect users |
| `full_name` | `text` | Not null |
| `slack_user_id` | `text` | Partial-unique where `archived_at is null`. Slack `U...` id when the client is in our Slack. Editable from the `/clients/[id]` Details box (inline text cell → `updateClientField`). A duplicate surfaces the partial-unique violation as the save error |
| `phone` | `text` | Optional |
| `timezone` | `text` | IANA tz name. Used for scheduling and display |
| `journey_stage` | `text` | Funnel position. Six values via 0028 CHECK constraint (or null): `business_setup`, `business_setup_activation_done`, `prospecting`, `first_closing_call_taken`, `first_closed_deal`, `ten_k_month`. Pre-0028 was free-text per 0017 design; 0028 pinned the taxonomy with all 192 active clients still NULL (zero backfill). Display labels live in `lib/client-vocab.ts` `JOURNEY_STAGE_OPTIONS`. |
| `status` | `text` | Operational status: `active`, `paused`, `ghost`, `leave`, `churned`. Default `active`. CHECK constraint `clients_status_check` added in 0019; `leave` is a CSM decision to let a client go without chasing (distinct from `churned`, which is post-program) |
| `nps_standing` | `text` | Added in 0021. NPS Survey segment classification mirrored from Airtable: `promoter`, `neutral`, `at_risk` (or null). Always written by `update_client_from_nps_segment` RPC; receiver normalizes Airtable raw strings (e.g. `"Strong / Promoter"`, `"Neutral"`, `"At Risk"`) to lowercase at the boundary. The RPC's email-match fallback over `metadata.alternate_emails` is guarded against malformed (non-array) values (migration 0100) — a single double-encoded row used to intermittently 500 the live NPS webhook for unrelated clients depending on scan order. Post-0027 (NPS-is-gospel, 2026-05-08): every NPS write also auto-derives `csm_standing` from this column unconditionally — manual `csm_standing` overrides get overwritten on the next NPS submission, except `csm_standing='problem'` since no segment maps to it. Also read by `agents/gregory/signals.py:compute_latest_nps` (mapped promoter→100, neutral→50, at_risk→0, NULL→neutral 50) — `latest_nps` weighted signal in the Gregory brain V2 rubric. |
| `accountability_enabled` | `boolean` | Added in 0022. Not null, default `true`. Whether accountability (DMs, nudges, automated check-ins) is active for this client. **As of 0120 this is a status-derived field**: `clients_status_cascade_before` re-derives it on every status transition — `active`/`ghost` → `true`, `paused`/`leave`/`churned` → `false`. Ghost was carved out of the off-set in 0120 (Scott's 2026-06-30 ask) and the restore direction is **automatic** (returning to active/ghost flips it on). A manual dashboard flip is **not sticky** in either direction — the next status change re-derives it (overriding manual intent is intended). Distinct from `clients.status`: status is the operational state, this is the automation-layer gate derived from it |
| `nps_enabled` | `boolean` | Added in 0022. Not null, default `true`. Whether NPS surveys go to this client. Same status-derived semantics as `accountability_enabled` (0120): re-derived on every status transition (`active`/`ghost` → `true`; `paused`/`leave`/`churned` → `false`), ghost carved out of the off-set, automatic restore on the way back, manual flips not sticky. The Airtable NPS Survery side is currently independent — flipping this to false in Gregory does not (V1) prevent Airtable from sending; Path 2 outbound writeback (deferred per future-ideas.md) closes that loop |
| `start_date` | `date` | When the client entered the program |
| `program_type` | `text` | `9k_consumer`, `b2b_enterprise`, etc. |
| `tags` | `text[]` | Ad-hoc labels; GIN-indexed |
| `metadata` | `jsonb` | Long-tail attributes (goals, SWOT, profession, age, etc.). Known keys include `alternate_emails` / `alternate_names` (case-insensitive resolution surface — see § Client Identity Resolution in CLAUDE.md), `profile.*` (sub-object for free-text fields editable from the Profile section), `auto_create_*` breadcrumbs (set on auto-create — see § needs_review lifecycle), `needs_review_cleared_at` ISO timestamp (audit field stamped when the dashboard's "Mark as reviewed" button clears the tag), `ghost_dismissed_at` ISO timestamp (set by the dashboard Client-flags "Remove notification" action — suppresses the ghost flag until the client posts in Slack again; see `lib/db/fulfillment-dashboard.ts` `getGhostClientFlags`) |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | Bumped by trigger |
| `archived_at` | `timestamptz` | Soft delete |
| `notes` | `text` | Free-text CSM notes |
| `country` | `text` | `USA` / `AUS`. Set at seed time (also mirrored into `metadata.country`); indexed |
| `birth_year` | `integer` | Profile field (migration 0017) |
| `location` | `text` | Profile field |
| `occupation` | `text` | Profile field |
| `csm_standing` | `text` | CSM-relationship health: `happy` / `content` / `at_risk` / `problem` (or null). Auto-derived from `nps_standing` on every NPS write (0027 NPS-is-gospel; promoter→happy, neutral→content, at_risk→at_risk) except `problem` (manual-only). Drives the M5.6 negative-status cascade and the Trustpilot cascade in both directions (→`happy` flips Trustpilot to `ask` per M5.7; →`content`/`at_risk`/`problem` flips it to `no` per 0101). Indexed |
| `archetype` | `text` | Client archetype / persona label |
| `contracted_revenue` | `numeric` | Financial field (0017). NOT written by `seed_clients.py` — revenue is dropped at ingestion (§ data hygiene); editable in the dashboard |
| `upfront_cash_collected` | `numeric` | Financial field; same not-from-import caveat as `contracted_revenue` |
| `arrears` | `numeric` | Not null, default 0. Outstanding balance owed |
| `arrears_note` | `text` | Free-text note on `arrears` |
| `trustpilot_status` | `text` | Trustpilot review state: `yes` (review given) / `no` (don't ask) / `ask` (not given, should ask) / `asked` (ask pending) (vocab in `lib/client-vocab.ts`). Auto-flipped to `ask` when `csm_standing` → `happy` (M5.7), with a first-month carve-out (0037); auto-flipped to `no` when `csm_standing` → any non-happy tier (`content`/`at_risk`/`problem`) per 0101 — i.e. only happy clients get the ask. The `no` cascade never overwrites an existing `yes` (a given review is permanent). Indexed |
| `ghl_adoption` | `text` | GoHighLevel adoption status. Indexed |
| `sales_group_candidate` | `boolean` | Whether the client is a sales-group candidate |
| `dfy_setting` | `boolean` | Done-for-you setting flag |

`journey_stage` vs `status`: `journey_stage` is lifecycle bucket, `status` is present engagement. A client can be `journey_stage = 'active'` and `status = 'paused'` simultaneously.

## Bulk imports: trust the source's working view

Bulk imports (`scripts/seed_clients.py` today) trust the source system's working view as the definition of "active client." The owner pre-filters their saved view (`Active++`, `Aus Active++`) before export; the importer takes every row that's in the file. Any non-archived DB client whose email isn't in the export gets soft-archived via the cascade. See `docs/runbooks/seed_clients.md` and `docs/fulfillment/conventions.md`.

## Metadata keys written by ingestion

The `metadata` jsonb is open-ended, but current ingestion sources are pinned:

**`scripts/seed_clients.py` (Financial Master Sheet import)** writes exactly these keys:

| Key | Type | Notes |
|-----|------|-------|
| `seed_source` | `text` | Always `"financial_master_jan26"` for this importer |
| `seeded_at` | `text` | ISO date the import ran |
| `country` | `text` | `"USA"` or `"AUS"` — which tab the row came from |
| `nps_standing` | `text` or null | Raw trimmed NPS Standing cell (e.g. `"Promoter"`, `"Detractor / At Risk"`) |
| `owner_raw` | `text` or null | Raw Owner cell, preserved for audit |

**Excluded by design:** revenue fields (stale) and `Standing` (reliability unclear). See `docs/fulfillment/conventions.md`.

Extension is cheap: add keys to future rows freely. Renaming or reshaping existing keys is expensive — per the `docs/fulfillment/metadata-conventions.md` principle.

## needs_review lifecycle

Auto-created clients (Fathom classifier's `should_auto_create_client` path) land with `tags` containing `needs_review`. The dashboard surfaces them on `/clients` via the existing "Needs review" filter chip, and on `/clients/[id]` via two action buttons (visible only when the tag is present): "Merge into…" (calls the `merge_clients` RPC, migration 0015 — source archives, calls + participants reattribute to the target) and "Mark as reviewed" (clears just the `needs_review` tag, stamps `metadata.needs_review_cleared_at` for audit).

As of 2026-05-15, the auto-create path is alive on both the legacy `30mins with Scott` pattern (pre-cutoff calls only) AND the six new-convention patterns (post-cutoff calls — `Coaching/Sales Call with {Scott|Lou|Nico}`). The two paths use distinct `metadata.auto_create_reason` strings so audit queries can split them:

```sql
-- New-convention auto-creates
SELECT id, full_name, email, created_at, metadata->>'auto_create_reason'
FROM clients
WHERE 'needs_review' = ANY(tags)
  AND metadata->>'auto_create_reason' = 'new title convention with unresolved participant'
ORDER BY created_at DESC;

-- Legacy Scott-1:1 auto-creates
SELECT id, full_name, email, created_at
FROM clients
WHERE 'needs_review' = ANY(tags)
  AND metadata->>'auto_create_reason' = '30mins_with_Scott pattern with unresolved participant';
```

The Slack-hygiene badges on the same surfaces (`Missing Slack channel`, `Missing Slack user`) are independent of `needs_review` — computed read-time from `slack_user_id` + the joined `slack_channels` table. A legacy client with broken Slack identity shows the missing-Slack badges but not the needs-review pill, and vice versa. The "Missing Slack" filter on `/clients` narrows to clients where either field is null. See `docs/runbooks/auto_created_client_management.md`.

## Uniqueness

`email` and `slack_user_id` are unique only among non-archived rows (see migration `0007_partial_unique_archival.sql`). A former client coming back into a program can be re-added without colliding with their archived record.

## Relationships

- Referenced by `client_team_assignments.client_id`
- Referenced by `slack_channels.client_id`
- Referenced by `calls.primary_client_id`
- Referenced by `call_participants.client_id`
- Referenced by `call_action_items.owner_client_id`
- Referenced by `nps_submissions.client_id`
- Referenced by `client_health_scores.client_id`
- Referenced by `alerts.client_id`
- Soft reference via `documents.metadata->>'client_id'` for call-summary docs

## Populated By

- `scripts/seed_clients.py` — the Financial Master Sheet `Active++` import (initial seed + re-sync; see § Bulk imports)
- Fathom call ingestion — auto-creates `needs_review` rows for unresolved call participants (§ needs_review lifecycle)
- `api/airtable_onboarding_webhook.py` — Path 3, Zain's onboarding flow (create-or-update RPC)
- Dashboard edits — inline-editable cells on `/clients` and the detail-page Server Actions

## Read By

- Every agent that needs client context
- Ella (to scope retrieval and route HITL to the right CSM)
- CSM Co-Pilot (health scoring, alerts, scorecards)
- Dashboards
- `GET /api/clients?email=` — read-only email→full-record lookup (matches primary email then `metadata.alternate_emails`; `getClientByEmail` in `lib/db/clients.ts`). See `docs/runbooks/client_lookup_api.md`

## Example Queries

All active clients in `business_setup`:

```sql
select id, full_name, email, start_date
from clients
where status = 'active'
  and journey_stage = 'business_setup'
  and archived_at is null
order by start_date desc;
```

Clients tagged `at_risk`:

```sql
select id, full_name, tags
from clients
where tags @> array['at_risk']
  and archived_at is null;
```

Resolve a Slack user id to a client:

```sql
select * from clients
where slack_user_id = $1
  and archived_at is null;
```
