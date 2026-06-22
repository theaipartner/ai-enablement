# Client Page Schema Spec — V1

**Status:** Source of truth for the V1 client page schema work (M4+). Locks the design produced in the planning sessions on April 30, 2026.

**Scope:** Adds the schema needed to support a CSM-facing client detail page with 7 sections (Identity & Contact, Lifecycle & Standing, Financials, Activity & Action Items, Profile & Background, Adoption & Programs, Notes), per the layout designed with Drake. Adds 14 columns to `clients`, 1 column to `nps_submissions`, and 4 new tables. Specifies import-time transformations from the Active++ master sheet CSV.

**Non-goals:** Reorganization of the existing schema. The known design seam between `alerts` and `client_health_scores.factors.concerns[]` is deferred and tracked in `docs/fulfillment/known-issues.md` § "`alerts` vs. `client_health_scores.factors.concerns[]` — two-table redundancy" — concerns stay in jsonb for V1; will resolve when CSM Co-Pilot needs a single read source.

---

## Part 1 — Existing schema we use as-is

The following are already in the schema and require no changes:

- `clients` — most existing fields stay (`full_name, email, phone, timezone, journey_stage, status, start_date, program_type, tags, metadata, notes, slack_user_id, archived_at, created_at, updated_at`). We add 14 new columns. We do NOT drop `program_type` or `start_date` — accepted as legacy until a future cleanup.
- `client_team_assignments` — solves owner history via the `assigned_at`/`unassigned_at` pattern. Owner changes write a new row. No separate owner-history table needed.
- `slack_channels` — `client_id` FK lives here. The dashboard joins on this; `slack_channel_id` does NOT belong on `clients`.
- `slack_messages` — "total Slack messages" is a derived count via `slack_user_id`, not stored on `clients`.
- `nps_submissions` — already history-preserving (one row per submission). We add one column (`recorded_by`).
- `client_health_scores` — already history-preserving. Concerns continue to live in `factors.concerns[]` jsonb (V1 design).
- `call_action_items` — already supports edit/complete via existing `status` and `completed_at` columns. The dashboard's "Section 4 action items checklist" reads from this table directly. No schema change.
- `alerts` — not used by V1 dashboard. Reserved for V2 CSM Co-Pilot.

## Part 2 — Columns to add to `clients`

All 14 columns are nullable except where noted, no default except where noted. All follow existing column conventions (snake_case, check constraints inline, comments mandatory).

| Column | Type | Nullable | Default | Constraint | Comment |
|---|---|---|---|---|---|
| `country` | `text` | yes | — | — | Free text. ISO codes deferred. |
| `birth_year` | `integer` | yes | — | `birth_year is null or (birth_year >= 1900 and birth_year <= extract(year from current_date)::int)` | Year only; age derived at display. |
| `location` | `text` | yes | — | — | Free text city / region. |
| `occupation` | `text` | yes | — | — | What they do for work. Free text. |
| `csm_standing` | `text` | yes | — | `csm_standing is null or csm_standing in ('happy', 'content', 'at_risk', 'problem')` | CSM-judgment standing. Distinct from financial standing (split during master sheet import). |
| `archetype` | `text` | yes | — | — | Free text in V1; enum check constraint to be added once Drake/Nabeel finalize the value set. |
| `contracted_revenue` | `numeric(10, 2)` | yes | — | — | Dollars. Total program contract value. |
| `upfront_cash_collected` | `numeric(10, 2)` | yes | — | — | Dollars. Upfront payment captured at signup. |
| `arrears` | `numeric(10, 2)` | no | `0` | — | Dollars. Amount owed. Negative master-sheet values normalize to 0. |
| `arrears_note` | `text` | yes | — | — | Operational note explaining arrears state. |
| `trustpilot_status` | `text` | yes | — | `trustpilot_status is null or trustpilot_status in ('yes', 'no', 'ask', 'asked')` | Workflow state for the Trustpilot review ask. Vocabulary matches the Financial Master Sheet column Scott uses; renamed from `('not_asked', 'pending', 'given', 'declined')` in 0020 (V1 adoption path). `'ask'` is imperative ("you should ask"), distinct from the old descriptive `'not_asked'`. |
| `ghl_adoption` | `text` | yes | — | `ghl_adoption is null or ghl_adoption in ('never_adopted', 'affiliate', 'saas', 'inactive')` | GHL product adoption state. Enum subject to Nabeel review; widen if needed. |
| `sales_group_candidate` | `boolean` | yes | — | — | Three-state: true / false / null (not assessed). |
| `dfy_setting` | `boolean` | yes | — | — | Three-state: true / false / null (not assessed). |

Indexes: add a btree index on `csm_standing` (filter on dashboard), `trustpilot_status`, `ghl_adoption`. No index on the others until query patterns surface a need.

## Part 3 — Column to add to `nps_submissions`

| Column | Type | Nullable | Default | Constraint | Comment |
|---|---|---|---|---|---|
| `recorded_by` | `uuid` | yes | — | FK → `team_members(id)` | Which team member entered this score manually. Null for entries from automated sources (Slack workflow, future Airtable webhook). |

No index needed — joins are infrequent and `nps_submissions_client_id_submitted_at_idx` already covers the dashboard query.

## Part 4 — New tables

### `client_upsells`

```sql
create table client_upsells (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  amount        numeric(10, 2),
  product       text,
  sold_at       date,
  notes         text,
  recorded_by   uuid references team_members(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
```

- Index: `(client_id, sold_at desc nulls last)`.
- Trigger: `client_upsells_set_updated_at` using existing `set_updated_at()` function.
- RLS enabled, no policies (default deny; service_role bypasses).
- Comments: table-level + per-column, following existing convention.

`amount` and `sold_at` are nullable to accommodate master sheet rows with free-text upsell descriptions and no date.

### `client_status_history`

```sql
create table client_status_history (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id),
  status      text not null,
  changed_at  timestamptz not null default now(),
  changed_by  uuid references team_members(id),
  note        text
);
```

- Index: `(client_id, changed_at desc)`.
- RLS enabled, no policies.
- History writes are application-layer (the API route writes both `clients.status` and a new history row). Pattern mirrors `client_team_assignments`. NOT trigger-based.
- Initial seed at migration time: one row per non-archived client with non-null status. `changed_at = clients.created_at`, `changed_by = null`, `note = 'initial migration seed'`. Filter on `archived_at is null` so seeded history reflects live clients only.

### `client_journey_stage_history`

```sql
create table client_journey_stage_history (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id),
  journey_stage   text,
  changed_at      timestamptz not null default now(),
  changed_by      uuid references team_members(id),
  note            text
);
```

- `journey_stage` nullable (most existing clients have null `clients.journey_stage`).
- Index: `(client_id, changed_at desc)`.
- RLS enabled, no policies.
- Application-layer writes.
- Initial seed: one row per non-archived client where `clients.journey_stage` is non-null. Skip clients with null journey_stage. Filter on `archived_at is null` for symmetry with the status-history seed (both should reflect live clients only).

### `client_standing_history`

```sql
create table client_standing_history (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id),
  csm_standing    text not null check (csm_standing in ('happy', 'content', 'at_risk', 'problem')),
  changed_at      timestamptz not null default now(),
  changed_by      uuid references team_members(id),
  note            text
);
```

- Check constraint matches the one on `clients.csm_standing`.
- Index: `(client_id, changed_at desc)`.
- RLS enabled, no policies.
- Application-layer writes.
- Initial seed: one row per client whose `clients.csm_standing` we populate during import (most clients won't have a value at migration time — most seeds happen during the import script in Chunk C, not at migration time. The migration-time seed is a no-op for `client_standing_history` because no `clients.csm_standing` values exist yet.)

## Part 5 — Master sheet import transformations

The Chunk C import script consumes `data/master_sheet/Financial MasterSheet (Nabeel - Jan 26) - USA TOTALS.csv` and produces DB writes per the rules below.

### Pre-import filter

Keep rows where `Client Name` is non-empty AND `Status` not in `('', 'N/A')`. Of 194 CSV rows, 173 are real client rows; 21 are dropped (17 footers like `TOTALS`, `UF Collection Rate`; 4 `N/A` rows that are deposits-never-converted: Vaishali Adla, Scott Stauffenberg, Clyde Vinson, Rachelle Hernandez).

### Client matching strategy

For each filtered row, match to `clients.id` in this order:

1. Email exact match (lowercased, trimmed) against `clients.email`.
2. Email match against `clients.metadata->'alternate_emails'`.
3. Name match (case-insensitive, whitespace-stripped) against `clients.full_name`.
4. Name match against `clients.metadata->'alternate_names'`.

If no match AND `Status='churn'`: **auto-create a new `clients` row** with the available identity fields (full_name, email if present, slack_user_id if present, phone if present, start_date, status='churned'). This handles clients who churned post-Active++-seed.

If no match AND status is not churn: log to unmatched-rows report. Do NOT auto-create. Drake reviews these manually.

### Column-by-column transformation table

| # | Sheet column | Action | Target field | Transformation |
|---|---|---|---|---|
| 0 | Client Name | Match-only | — | Trim. Used for name-fallback matching. Do NOT overwrite existing `clients.full_name`. |
| 1 | Accountability | Drop | — | Workflow Yes/No indicator. Future Airtable submission count replaces. |
| 2 | Client Emails | Match-only | — | Trim, lowercase. Used for matching. Do NOT overwrite existing `clients.email`. |
| 3 | Slack Channel ID | Drop | — | Lives on `slack_channels.client_id`. |
| 4 | Slack User ID | Import (fill nulls only) | `clients.slack_user_id` | Trim. Don't overwrite existing values. |
| 5 | Client Phone No. | Import (fill nulls only) | `clients.phone` | Trim. Don't overwrite. |
| 6 | Date | Import (fill nulls only) | `clients.start_date` | Parse `M/D/YYYY` to ISO date. Don't overwrite. |
| 7 | UF Collected | Transform | `clients.upfront_cash_collected` | Strip `$` and `,`. Parse to numeric. Empty → null. |
| 8 | Contracted Rev | Transform | `clients.contracted_revenue` | Strip `$` and `,`. Parse to numeric. Empty → null. |
| 9 | NPS | Drop | — | Yes/No workflow indicator; sheet has no actual scores. |
| 10 | Arrears | Transform | `clients.arrears` | Strip `$` and `,`. Parse to numeric. Negative → 0. Empty → 0. |
| 11 | Arrears Notes | Transform | `clients.arrears_note` | Trim. Empty → null. |
| 12-16 | Month 1-5 PP | Drop | — | Payment plan deferred from V1. |
| 17 | Refund/CB Amount | Drop | — | Refund tracking deferred from V1. |
| 18 | Status | Transform | `clients.status` | Normalize: `Active`→`active`, `Churn`→`churned`, `Paused (Leave)`→`paused`, `Paused`→`paused`, `Ghost`→`ghost`. |
| 19 | Owner (KHO!) | Transform | `client_team_assignments` (insert if differs) | Strip annotations: `Lou (Scott Chasing)`→Lou, `Scott > Nico`→Nico. Map name to `team_members.full_name`. `N/A`/`Unassigned`/empty → no assignment row. If active primary_csm exists and matches → skip. If active primary_csm exists and differs → end existing (`unassigned_at = now()`) + insert new with `role='primary_csm'`. |
| 20 | Standing | Transform | `clients.csm_standing` | Take CSM portion only. Mappings: `Happy`→`happy`, `Content`→`content`, `At risk`→`at_risk`, `Problem`→`problem`. Compound: `Owing Money, At risk`→`at_risk`, `Owing Money, Content`→`content`, `At risk, Owing Money`→`at_risk`, `Content, Happy`→`happy`. Pure-financial values (`Owing Money`, `Chargeback`, `Full Refund`, `Partial Refund`, `Refunded`, `N/A (Churn)`)→null. Empty→null. **Also**: write a `client_standing_history` row for every non-null csm_standing set. |
| 21 | NPS Standing | Drop | — | Standing derived at display from `nps_submissions.score`. |
| 22-29 | Meetings April / Meetings May / Meeting? checkpoints | Drop | — | Replaced by `calls` table. |
| 30 | Scott Notes. | Drop | — | Editorial notes start fresh in dashboard. |
| 31 | Upsells (N2AN) | Transform | `client_upsells` (insert) | Parse dollar amount (e.g. `$2,500`→`2500.00`). Free-text without amount → store full text in `notes`, leave `amount` null. `sold_at` = null. `recorded_by` = null. `product` = null. Idempotent: skip if row exists for `(client_id, amount, sold_at)` matching. |
| 32 | Client Work (Scott) | Drop | — | Editorial notes start fresh. |
| 33 | Stage | Drop | — | Mostly empty + about to be replaced by Nabeel/Scott journey-stage taxonomy. |
| 34 | GHL Adoption | Drop | — | Stale data; CSMs refresh per-client in dashboard. |
| 35 | Trustpilot | Transform | `clients.trustpilot_status` | Mapping (post-0020): `Yes`→`yes`, `No`→`no`, `Ask`→`ask`, `Asked`→`asked`, empty→null. Identity mapping after the M5.3b vocab rename — DB column now matches the master sheet vocab verbatim. |
| 36 | Nabeel Notes | Drop | — | Editorial notes start fresh. |
| 37 | (unnamed empty column) | Drop | — | Junk. |
| 38 | Sales Group Candidate | Drop | — | Stale; CSMs refresh per-client. |
| 39 | DFY Setting | Drop | — | Stale; CSMs refresh per-client. |

### Idempotency

The import script must be safely re-runnable:

- Owner assignment: check existing active primary_csm before inserting; skip if same person, end-and-create if different.
- Upsells: skip insert if a row exists for `(client_id, amount, sold_at)` matching.
- History seeds (during import, not migration): insert only if no history row exists yet for this client.
- Schema column updates: `update` is idempotent for the same input.

### Output report

The script prints to stdout:

- Total CSV rows: 194
- Filtered (footers + N/A): 21
- Real client rows: 173
- Matched to existing clients: N
- Auto-created (churned, no match): N
- Unmatched (active/paused/ghost, require human review): N — listed by name + email + reason
- Updates applied per column: count per column
- Upsell rows inserted: N
- History rows written: N per table
- Errors caught and skipped: list with reason

## Part 6 — Build sequencing

This work splits into three Code chunks, executed in order:

- **Chunk A (this prompt):** Schema migrations + this spec doc. Drake applies via Studio; Code verifies via dual-verification.
- **Chunk B:** Backend + UI for the 7 dashboard sections. Read paths via `lib/db/clients.ts`, write paths with application-layer history writes, list-page filters, concerns sub-section under health score.
- **Chunk C:** Master sheet import script (`scripts/import_master_sheet.py`) implementing Part 5 with dry-run mode and idempotency.

Each chunk has its own Code prompt and its own hard stops.
