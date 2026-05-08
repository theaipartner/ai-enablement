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
| `slack_user_id` | `text` | Partial-unique where `archived_at is null`. Slack `U...` id when the client is in our Slack |
| `phone` | `text` | Optional |
| `timezone` | `text` | IANA tz name. Used for scheduling and display |
| `journey_stage` | `text` | `onboarding`, `active`, `churning`, `churned`, `alumni` |
| `status` | `text` | Operational status: `active`, `paused`, `ghost`, `leave`, `churned`. Default `active`. CHECK constraint `clients_status_check` added in 0019; `leave` is a CSM decision to let a client go without chasing (distinct from `churned`, which is post-program) |
| `nps_standing` | `text` | Added in 0021. NPS Survey segment classification mirrored from Airtable: `promoter`, `neutral`, `at_risk` (or null). Always written by `update_client_from_nps_segment` RPC; receiver normalizes Airtable raw strings (e.g. `"Strong / Promoter"`, `"Neutral"`, `"At Risk"`) to lowercase at the boundary. Post-0027 (NPS-is-gospel, 2026-05-08): every NPS write also auto-derives `csm_standing` from this column unconditionally — manual `csm_standing` overrides get overwritten on the next NPS submission, except `csm_standing='problem'` since no segment maps to it. Also read by `agents/gregory/signals.py:compute_latest_nps` (mapped promoter→100, neutral→50, at_risk→0, NULL→neutral 50) — `latest_nps` weighted signal in the Gregory brain V2 rubric. |
| `accountability_enabled` | `boolean` | Added in 0022. Not null, default `true`. Whether accountability (DMs, nudges, automated check-ins) is active for this client. Cascade owns this for negative-status transitions: M5.6's `clients_status_cascade_before` trigger flips to `false` when status moves to ghost/paused/leave/churned. CSMs can manually flip back to true via the dashboard; the override is **not sticky** — a future negative-going status transition re-fires the cascade and flips it off again. Distinct from `clients.status`: status is the operational state, this is a CSM-controlled gate on the automation layer regardless of status |
| `nps_enabled` | `boolean` | Added in 0022. Not null, default `true`. Whether NPS surveys go to this client. Same cascade semantics as `accountability_enabled`: auto-off on negative-going status transitions, manually flippable, override-not-sticky. The Airtable NPS Survery side is currently independent — flipping this to false in Gregory does not (V1) prevent Airtable from sending; Path 2 outbound writeback (deferred per future-ideas.md) closes that loop |
| `start_date` | `date` | When the client entered the program |
| `program_type` | `text` | `9k_consumer`, `b2b_enterprise`, etc. |
| `tags` | `text[]` | Ad-hoc labels; GIN-indexed |
| `metadata` | `jsonb` | Long-tail attributes (goals, SWOT, profession, age, etc.) |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | Bumped by trigger |
| `archived_at` | `timestamptz` | Soft delete |

`journey_stage` vs `status`: `journey_stage` is lifecycle bucket, `status` is present engagement. A client can be `journey_stage = 'active'` and `status = 'paused'` simultaneously.

## Bulk imports: trust the source's working view

Bulk imports (`scripts/seed_clients.py` today) trust the source system's working view as the definition of "active client." The owner pre-filters their saved view (`Active++`, `Aus Active++`) before export; the importer takes every row that's in the file. Any non-archived DB client whose email isn't in the export gets soft-archived via the cascade. See `docs/runbooks/seed_clients.md` and `docs/data-hygiene.md`.

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

**Excluded by design:** revenue fields (stale) and `Standing` (reliability unclear). See `docs/data-hygiene.md`.

Extension is cheap: add keys to future rows freely. Renaming or reshaping existing keys is expensive — per the `docs/ingestion/metadata-conventions.md` principle.

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

- Drive ingestion (client list doc) for initial seed
- CRM ingestion in Phase 2
- Manual admin corrections

## Read By

- Every agent that needs client context
- Ella (to scope retrieval and route HITL to the right CSM)
- CSM Co-Pilot (health scoring, alerts, scorecards)
- Dashboards

## Example Queries

All active clients in onboarding:

```sql
select id, full_name, email, start_date
from clients
where status = 'active'
  and journey_stage = 'onboarding'
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
