# Runbook: Seed Clients from the Financial Master Sheet

How to populate `clients`, `slack_channels`, and `client_team_assignments` from a pre-filtered Active++ export of the Financial Master Sheet. Also covers the re-import loop and post-import churn handling.

## What counts as a client (V1 import rule)

**The owner's working view is the filter.** The importer does not status-filter rows. Instead, the sheet owner exports the rows visible under their `Active++` (USA) and `Aus Active++` (AUS) saved views and drops the XLSX at `data/client_seed/`. Every row the owner exports is imported; rows they excluded from their view do not show up here in the first place.

This is the "trust the source's working view" principle from `docs/fulfillment/data-hygiene.md` §1. The owner's saved filter encodes real business logic we shouldn't try to re-derive.

What the importer still skips:
- Rows with a blank `Customer Name` (entirely empty rows).
- Rows with a blank `Client Emails` (surfaced in the dry-run under SKIPPED — MISSING EMAIL so nothing silently disappears).

## When to run

- First-time seed of a fresh Supabase project (local or cloud).
- Whenever the owner produces a new Active++ export (typically once per month, or when a client churns / is paused / comes back).
- After fixing an Owner typo in the sheet, to refresh the DB.

## Prerequisites

- Local Supabase running (or cloud target with `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` set in `.env.local`).
- Migrations `0001`–`0009` applied; `team_members` seeded.
- Virtualenv active with `pip install -e '.[scripts]'` (brings in `openpyxl`).
- The XLSX dropped at `data/client_seed/`. Default file name is `active ++ (1).xlsx` (sheet export naming). Pass `--input` to override.

## Canonical re-import workflow

1. Owner re-exports the `Active++` and `Aus Active++` views to XLSX.
2. Owner drops the file at `data/client_seed/` (default name `active ++ (1).xlsx`; pass `--input` for a different path).
3. Dry run: `python scripts/seed_clients.py --input 'data/client_seed/active ++ (1).xlsx'` — prints path and sheets read at the top so there's no ambiguity about which file is being processed.
4. Review the dry-run report. Check counts per tab, unmapped Owner values, any email duplicates, and the archival preview.
5. Apply: `python scripts/seed_clients.py --input 'data/client_seed/active ++ (1).xlsx' --apply`.

## Dry-run report sections

- **Header** — input file path and sheet names read. Always verify before acting on anything below.
- **Summary counts** — rows per tab, rows skipped (missing email), proposed clients / channels / assignments.
- **Skipped — missing email** — rows with a name but no email. Expected: 0 on a clean export.
- **Unmapped Owner values** — distinct Owner strings that didn't match any of our 5 CSMs (`Lou`, `Scott`, `Nico`, `Nabeel`, `Aman`). These clients get imported but unassigned.
- **Messy Owner mappings** — strings like `Lou (Scott Chasing)` or `Lou > Nico?` that mapped heuristically to the first-named CSM. Full raw string lands in `client_team_assignments.metadata.raw_owner`.
- **Sheet email duplicates** — same email on two rows in the sheet.
- **DB email collisions** — emails in the sheet that already exist in `clients`.
- **Proposed archivals** — clients currently in the DB whose emails are NOT in this export. On `--apply` these get soft-archived with the cascade (see below).
- **Random sample** — 5 proposed clients with full payloads (plus a guaranteed AUS row).

## Metadata written to `clients`

Five keys, exactly:
- `seed_source` — constant `"financial_master_jan26"`.
- `seeded_at` — ISO date of the import run.
- `country` — `"USA"` or `"AUS"`.
- `nps_standing` — raw `NPS Standing` cell, trimmed.
- `owner_raw` — raw `Owner` cell, for audit.

**Column fields** set by the importer on every row:
- `program_type` = `"9k_consumer"` (V1 is single-program).
- `timezone` = `"America/New_York"` (V1 is EST-only).
- `status` — mapped from the sheet's Status column.
- `start_date` — from the sheet's Date column.
- `phone`, `slack_user_id`, `slack_channel_id` — from the sheet when present.
- `journey_stage` — left null, CSM Co-Pilot populates later.

**Excluded by design:** revenue columns (stale — source of truth is Scott's head), the `Standing` column (reliability unclear). See `docs/fulfillment/data-hygiene.md`.

## Tag derivation

- `promoter` — `NPS Standing` equals `Promoter` (trimmed, case-insensitive).
- `at_risk` — `NPS Standing` equals `Detractor / At Risk`.
- `detractor` — same as `at_risk`.
- `aus` — source tab is AUS.
- `churned` — defensive only; doesn't fire on a normal Active++ export.

## Idempotency

- **`clients`** — matched by email across archived and active rows (partial unique index). Active row wins if both exist.
  - In-place update refreshes `full_name`, `phone`, `slack_user_id`, `start_date`, `status`, `program_type`, `timezone`, `tags`, and merges `metadata` (existing keys kept if not in new row).
  - `archived_at` is always set to `NULL` on update — so a previously archived client who reappears in the export is **reactivated** automatically. The apply summary surfaces the reactivation count distinctly from updates.
- **`slack_channels`** — `on_conflict=slack_channel_id`. Name and `client_id` refresh.
- **`client_team_assignments`** — `on_conflict=(client_id, team_member_id, role)` with `ignore_duplicates=True`. Manual reassignments stick; to reassign, delete the old row first.

## Archival cascade

Every run compares the proposed set to `clients` currently in the DB with `archived_at IS NULL`. Any DB client whose email is **not** in this export gets:
- `clients.archived_at = now()`
- `slack_channels.is_archived = true` (for rows linked to that client)
- `client_team_assignments.unassigned_at = now()` (for active assignments)

No deletes. Ever. The row stays in the DB; history is preserved; agents stop seeing it because their queries filter on `archived_at IS NULL` / `is_archived = false`.

## Churn after import

A client churning is now just an owner action on the sheet:
1. Owner removes the client from their Active++ view (the view is status-filtered in the sheet; marking them `Churn` or moving them to the archive tab does this automatically).
2. Next export doesn't include that row.
3. Next `--apply` soft-archives the client via the cascade above.

No importer-side "churn status" logic. The source-of-truth is the owner's working view.

## Apply log

The `--apply` run writes `data/client_seed/import_<ts>.log` containing:
- Full dry-run report (same as stdout).
- APPLY SUMMARY — inserts, updates, reactivations, channel upserts, assignment upserts, archival cascade counts.
- DISCREPANCY CHECKS — dry-run-predicted archival counts vs. actual applied counts. Flags mismatches.
- Post-apply breakdowns — status / journey_stage / tag / primary_csm-assignment distributions over active clients.

Everything under `data/` is gitignored.

## Common Fixes

**Unmapped Owner value.** Normalize the Owner cell to `Lou`, `Scott`, `Nico`, `Nabeel`, or `Aman` (optionally with a messy suffix like `Lou (Scott Chasing)`), re-export, re-run. Unmapped values = no assignment; the client still imports.

**Email typo.** Fix in the sheet and re-export. The old DB row with the typo'd email will be soft-archived on next apply (it's no longer in the export), and the corrected row lands as a new insert.

**Two rows for the same email in the sheet.** Dedupe in the sheet first. Last occurrence wins on `--apply`, but the right fix is at the source.

**Apply failed partway through.** Re-run; idempotency handles the partial state. Archival cascade will still correctly process anything that didn't make it.

**Rows in DB not in sheet that shouldn't be archived.** Shouldn't happen if the owner's Active++ view is right. If it does, investigate at the sheet level, not by patching the importer.

## Cloud seeding

`supabase db push` doesn't run arbitrary scripts. For cloud:
1. Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` to the cloud values.
2. Dry run to verify parsing.
3. `--apply`. All writes go through the REST API under the service_role key.

## Future

- `scripts/churn_client.py` — atomic "set churned + archived_at" helper for hand actions. See `docs/fulfillment/future-ideas.md`.
- `scripts/add_client.py` — one-off adds between sheet exports. See `docs/fulfillment/future-ideas.md`.
- Automated cloud seed application. See `docs/fulfillment/future-ideas.md`.
