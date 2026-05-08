# Runbook: Master Sheet Import

Operational runbook for `scripts/import_master_sheet.py` — the
one-shot CSV → Supabase import that brings the dashboard's new fields
(M4 Chunk A schema additions) up to real data.

Full design: `docs/client-page-schema-spec.md` § Part 5. This runbook
covers the operator's flow, not the transformation rules — those are
the spec's job.

---

## When to run

This is **not a recurring job.** It's a one-shot to seed real values
into 14 new `clients` columns + 4 new tables (`client_upsells` and
three `*_history` tables) introduced by migration 0017. After the
initial apply, the dashboard becomes the source of truth for these
fields — CSMs edit via the inline-edit UI from M4 Chunk B2.

Re-run only if:

- The master sheet's pre-import filter rule changes (e.g. a status
  category gets renamed) and the import was applied against the old
  rule.
- A new master-sheet export lands with values that materially differ
  from what's in cloud (rare; the dashboard is the source of truth
  going forward).
- An idempotency-verification check is needed (re-running with the
  same CSV produces 0 writes).

---

## Default mode is dry-run

```bash
.venv/bin/python scripts/import_master_sheet.py
```

Reads the CSV, computes everything that would change, prints a report,
writes nothing. Safe to run anytime.

The first line of output tells you the mode:

```
Mode: DRY-RUN
```

You can also pass an alternate CSV path:

```bash
.venv/bin/python scripts/import_master_sheet.py --input path/to/sheet.csv
```

---

## Apply mode

```bash
.venv/bin/python scripts/import_master_sheet.py --apply
```

Writes everything the dry-run proposed. The first line of output
becomes:

```
Mode: APPLIED
```

**Always run dry-run first.** The script does not enforce this — the
operator does.

Logs land in `data/master_sheet/import_report_<UTC-timestamp>.txt`.

---

## What the report sections mean

### Row counts

```
Total CSV rows (header excluded):  194
Filtered:                          21
    na_status                         4
    empty_name                        5
    empty_status                      12
Real client rows:                  173
```

The filter implements spec § Part 5: keep rows where Client Name is
non-empty AND Status not in `('', 'N/A')`. Footer rows like `TOTALS`
and `UF Collection Rate` get dropped via the empty-status branch;
the 4 deposits-never-converted rows get dropped via the N/A branch.

If the real-client count differs from 173 on a future run, the master
sheet has changed shape — investigate before applying.

### Matching

```
email_primary                             103
email_alternate                             0
name_primary                                1
name_alternate                              0
auto_created (churned, no match)           69
unmatched (require human review)            0
```

The four match methods correspond to the spec's match ladder:

1. Email exact match against `clients.email`
2. Email match against `clients.metadata->'alternate_emails'`
3. Name match against `clients.full_name`
4. Name match against `clients.metadata->'alternate_names'`

`auto_created` covers two populations:

- **Churned clients with no match** (per spec): auto-create as
  `clients` row with `status='churned'`. These are clients who churned
  after the original Active++ seed.
- **Non-churn clients with no match** (per Drake's M4 Chunk C amendment
  to the spec): auto-create with their sheet-side status. Reason: a
  cloud cross-check of the first dry-run's 21 unmatched non-churn rows
  confirmed they were genuinely absent from cloud (0/20 sampled emails
  found anywhere). Auto-creating them surfaces them in the dashboard
  for CSM onboarding; manual cleanup later is acceptable. Followup
  logged in `docs/known-issues.md` § "Master sheet importer — three
  carry-overs".

`unmatched` should be 0 after the M4-C amendment — any non-zero count
means the script encountered a row that couldn't be normalized to a
status (defensive fallback). Stop and investigate.

### AUTO-CREATED CLIENTS

The list is sorted with non-churn rows first, then churned. Status is
shown alongside the name to make scanning easy when both populations
land in the same list.

Rows with `(no email — placeholder will be synthesized on apply)` get
`<slug>+import@placeholder.invalid` synthesized at apply time so the
migration 0001 NOT NULL email constraint holds. The
`placeholder.invalid` TLD is RFC-reserved — no risk of accidentally
emailing the address. CSMs can edit via the dashboard's Email field
later if a real email surfaces.

### Updates by field

```
Updates by field (transform fields):
  status                          12 updated,   92 unchanged
  csm_standing                   104 updated,    0 unchanged
  ...
```

`updated` means the new value differs from what's currently in cloud.
`unchanged` means the new value equals cloud's current — no write
needed.

**Idempotency check:** on a second `--apply` run with the same CSV,
every field should report `0 updated`, all rows in `unchanged`. If
that's not the case, the script has lost idempotency — investigate.

### Fill-null updates

Three fields (`slack_user_id`, `phone`, `start_date`) follow the
spec's "fill nulls only" rule — they don't overwrite existing values
in cloud, only fill where the cloud value is currently null. The
report counts only the writes that actually happen.

### Sub-table inserts

```
client_team_assignments (new primary_csm):  44
    ... of which end + create (owner change): 16
client_upsells:                              24
client_status_history (seed rows):           81
client_standing_history (seed rows):        137
```

- `client_team_assignments`: counts new primary_csm rows. End + create
  fires when the cloud has an active assignment for a different team
  member than the master sheet says. The old assignment gets
  `unassigned_at = now()` (preserves history); the new one is inserted.
- `client_upsells`: dedup'd against existing `(client_id, amount,
  sold_at, notes)` tuples. Re-runs skip rows that already exist.
- `client_status_history` and `client_standing_history`: seed rows
  marked `note='import seed'` to distinguish them from CSM-driven
  edits via the dashboard. Dedup is on `(client_id, value, note)` for
  re-run safety.

### ERRORS

```
owner  | Ming-Shih Wang  | 'Aleks' not in team_members — assignment skipped
```

The Owner (KHO!) column refers to a person who doesn't exist in the
`team_members` table. The script logs the error and skips the
assignment; the client lands with `primary_csm = NULL`. The
operator decides whether to add the missing team member (then re-run)
or accept the null assignment.

For the M4 Chunk C apply: Aleks is no longer at the company per
Drake; the 4 rows with `Owner=Aleks` land with `primary_csm = NULL`
and Drake reassigns them manually via the dashboard. See
`docs/known-issues.md` § "Master sheet importer — three carry-overs"
point (b).

---

## Idempotency

The script is designed to be safe to re-run. After a successful apply,
re-running with the same CSV should produce:

- All `Updates by field` lines showing `0 updated`
- All `Sub-table inserts` lines showing `0`
- 0 net new auto-created clients (the matching ladder now finds them)

If a re-run produces non-zero writes:

1. Check the `Matching` block — auto-created clients from the prior
   run should now match by email_primary. If they're auto-creating
   again, the matching ladder is broken or the prior apply didn't
   actually persist.
2. Check the `Updates by field` block. The most common source of
   false-positive updates is numeric field formatting (Decimal vs
   string round-trip). The script normalizes via Decimal in
   `_normalize_for_diff` — if a column is reporting "updated" when the
   value hasn't changed, that helper needs to grow.

---

## Failure modes

| Symptom | Likely cause | Action |
|---|---|---|
| Script can't find the CSV | Path drift or rename | Pass `--input <path>`; consider updating `DEFAULT_CSV_PATH` |
| `unmatched (require human review)` is non-zero | A row's status didn't normalize | Inspect; either map the status in `STATUS_MAP` or drop the row from the CSV |
| Owner errors > 4 | A new team member is referenced but missing from `team_members` | Add them to `team_members` and re-run, OR extend the spec to drop that owner |
| Apply hangs partway through | PostgREST flake or pooler connection issue | Check Supabase status; the script does not transact across rows, so partial state is possible — re-run dry-run to see what's still pending |
| Idempotency-check re-run shows non-zero writes | Diff-comparison bug | Inspect `_normalize_for_diff` and field-specific narrowing |

---

## Rollback

There's no built-in rollback. Manual options:

- **`clients` updates**: query `client_status_history` / `client_standing_history` for `note='import seed'` rows and reverse to the prior values (this only works for fields that have history tables — status, csm_standing).
- **Auto-created `clients` rows**: identify via `metadata->>'auto_created_via' = 'import_master_sheet.py'` and soft-archive (`archived_at = now()`), don't hard-delete.
- **`client_upsells`**: identify via `created_at > <apply timestamp>` and delete (or soft-archive if a deletion column gets added).
- **`client_team_assignments`**: end with `unassigned_at = now()`; the prior assignments (if any) need to be reactivated by clearing their `unassigned_at`.

---

## References

- `scripts/import_master_sheet.py` — the script.
- `docs/client-page-schema-spec.md` § Part 5 — column transformation rules.
- `docs/known-issues.md` § "Master sheet importer — three carry-overs" — known cleanup items post-apply.
- `data/master_sheet/import_report_*.txt` — log of past runs.
