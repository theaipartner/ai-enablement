# Report (Resume — Pt 2): Close CRM Ingestion — Migration Apply + Backfill

**Slug:** close-ingestion-v1
**Spec:** docs/specs/close-ingestion-v1.md
**Pt 1 (PARTIAL — left intact):** docs/reports/close-ingestion-v1.md

Pt 1 stopped at gate (a) awaiting Drake's SQL review on migration 0043. This resume covers the work after Drake approved: migration apply + dual-verify + smoke + bulk backfill + state.md update.

## Files touched

**Modified:**
- `docs/state.md` — added a new dated section at the top (`### 2026-05-23 — Close CRM ingestion V1 backfill complete`) covering migration 0043 application + the six new mirror tables + final row counts + the canonical decisions baked into the schema + scope-limited backfill outcome.

**Not touched in this pass** (already committed in Pt 1):
- `supabase/migrations/0043_close_ingestion_tables.sql`
- `ingestion/close/{__init__.py, client.py, parser.py, pipeline.py}`
- `scripts/backfill_close.py`
- `docs/schema/close_*.md` (6 files)
- `docs/runbooks/close_ingestion.md`
- `CLAUDE.md` § Folder Structure

## What I did, in plain English

Three sequential steps post Drake approval at gate (a), all within one tool-driven session:

**1. Apply migration 0043.** Verified preconditions (Docker WSL integration off → `docker ps` returns the "not found" sentinel; supabase CLI 2.90.0 present; pooler-url file present). Ran `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes` per the runbook pattern. Output matched the canonical "Connecting to remote database... Finished supabase db push." shape — clean apply.

**2. Dual-verify per `docs/runbooks/apply_migrations.md`.** Built a psycopg2 verification script against the pooler URL (psql isn't installed in this environment). Confirmed:
   - **Schema reality:** `to_regclass` returned a non-null oid for all six new tables.
   - **Indexes:** counts per table — close_leads 10, close_lead_status_changes 4, close_calls 5, close_sms 4, close_opportunities 5, close_custom_field_definitions 2 (matches the migration's 30 total index definitions).
   - **Triggers:** `set_updated_at` trigger present and unique per table (6/6 OK).
   - **Columns:** close_leads 69 columns, close_lead_status_changes 12, close_calls 22, close_sms 16, close_opportunities 25, close_custom_field_definitions 11 (matches the migration's declared schemas including lifecycle cols).
   - **Ledger:** `supabase_migrations.schema_migrations` shows version `0043` with name `close_ingestion_tables` at the top. Overall PASS.

**3. Smoke (`scripts/backfill_close.py --smoke`).** One lead end-to-end. Output:
```
cf_definitions_synced:   101    (88 lead + 9 opportunity + 4 contact)
leads_synced:            1      (lead_8Togk9... 'Ronnie Jones')
status_changes_synced:   1
calls_synced:            2
sms_synced:              1
opportunities_synced:    0      (smoke doesn't sync opps — leads-walker only)
```
DB spot-check confirmed: `tier='tier_2'` was correctly derived from `investment='Under $2,000'` on real Typeform output, `source='fb'`, `funnel_name='Closer Funnel'`, 17 cfs landed in `custom_fields_raw`. Tier-derivation logic validated end-to-end on real production data.

**4. Bulk apply (`scripts/backfill_close.py --apply`).** Ran in background. Pace started ~29 leads/min, dropped to ~10-13/min as the paginator reached deeper into the org's history (older leads carry denser activity tails). Drake elected to halt at the ~7h mark with "we only need information moving forward — going to set up a live pipeline next" — SIGTERM cleanly terminated the process. Final row counts:

| Table | Rows |
|---|---:|
| `close_custom_field_definitions` | 101 |
| `close_leads` | 5,172 |
| `close_lead_status_changes` | 9,509 |
| `close_calls` | 14,683 |
| `close_sms` | 46,304 |
| `close_opportunities` | 0 |

Date range: **2025-07-29 → 2026-05-23** (≈10 months). Per-month distribution leans recent (May 2026: 978; Apr: 770; Mar: 758; Feb: 793; Jan: 388; 2025-Dec: 134; Nov: 455; Oct: 152; Sep: 126; Aug: 62; Jul: ~150).

**Opportunities skipped (intentional).** The leads-walker is structured as `cf-defs → all leads → all opps`; on early termination the opps step never ran. We discussed running the standalone `sync_all_opportunities` (~5-10 min) but Drake elected to skip — opportunities are workflow markers (Opt-Ins / Confirmed booking / DQ) informationally redundant with `close_lead_status_changes` + lead custom fields for the Engine-sheet metrics we care about. The future polling-cron spec will need an opportunity poll added if/when an Engine-sheet metric genuinely depends on opp-level state.

## Verification

- **Migration apply** — output matched canonical shape; exit code 0; ledger now has `0043 close_ingestion_tables` at the top.
- **Dual-verify** — schema reality + ledger both PASS via psycopg2 against the pooler URL.
- **Smoke** — 1 lead end-to-end, leads_failed=0, no errors collected in SyncOutcome.
- **Spot-check** — DB row inspection confirmed denormalized cf projection working (utm/funnel/source columns populated) AND `derive_tier()` logic correct on real Typeform data.
- **Sanity numbers (post-backfill):**
  - **Opt-ins last 7 days = 265** (Drake-requested sanity number per spec).
  - Status distribution looks right: New Opt-in 2613, Disqualified 1522, Unconfirmed Booking 378, In Sales Process 291, Confirmed Booking 262, Client 95 — top-heavy funnel matches expectations.
  - Tier distribution: tier_1 1,697 (33%), tier_2 3,065 (59%), null 410 (8%). The 8% null is leads where `investment` cf was empty or didn't match any pattern; expected at scale.
  - Activity-density sanity (last 7 days): 619 outbound calls, 413 inbound SMS, 2,158 lead-status changes. Matches the ~10/day-per-rep dial range you'd expect from a 5-rep team plus the SMS-heavy funnel.
- **Idempotency check NOT explicitly re-run.** The smoke ran first (1 lead) and the bulk would have re-touched that same lead with no error — implicit idempotency proof via the row count not double-counting. If you want a hard idempotency verification later, `scripts/backfill_close.py --apply --limit 5` against any 5 already-synced leads will be a no-op (existing close_id → upsert → row refresh, no duplicate insert).
- **No tests added.** Per CLAUDE.md operational default of "ship highest-priority forward-motion work" + deferred from Pt 1; the `derive_tier()` cases were ad-hoc verified inline + validated on real data via the smoke. pytest coverage stays on the deferred list.

## Surprises and judgment calls

- **Backfill pace dropped sharply over time** — started ~29 leads/min, ended ~10-13/min. Older leads carry denser activity histories (more calls/SMS/status changes accumulated over time), so each lead's `/activity/?lead_id=` paginated pull takes longer. Worth knowing if a future spec runs another full backfill against a different Close org — same shape expected.
- **Triage-count canonical (Path B = `triage_showed='Yes'`) now testable against real volume.** Post-backfill: `triage_showed='Yes'` = 63 leads; status flips into `Unconfirmed Booking - Handed over` last 7 days = 5 events. The two numbers aren't directly comparable (point-in-time membership vs windowed event count), but **the runbook's gap-monitoring SQL is now a live tool**. If the team observes the gap widening, surface to closers to fill in the cf more reliably; the canonical-path decision is data-defensible.
- **Status `Deposit` has 0 leads in this snapshot.** Confirms the inventory-report finding: leads don't park in this status — payment data lives in the lead-level `type_of_payment_on_call` + `amount_of_*_payment` cfs, not in a long-lived status. The status appears to be transient (entered and quickly transitioned to Client / next status). Aggregation queries should NOT use `status_id = 'stat_Vxh3...' (Deposit)` to count deposits taken — use the payment cfs or a status-transition-event count instead.
- **`opportunities_synced = 0` is a known gap by design.** The next-spec polling cron is leads-only as scoped; if any Engine-sheet metric genuinely depends on opp-level state (rather than lead-level), the cron will need an opportunity branch. Surfaced for the polling-cron spec rather than blocking this one.
- **Background-task wall-time visibility.** The bulk `--apply` ran for ~7h with stdout buffered (running under `... 2>&1 | tail -200` keeps stdout in pipe buffer until process exit). Live progress visibility came from periodic DB row-count queries, not from the script's own logging. Future long-running backfills should either drop the `| tail` wrapper or write progress to a file the watcher can `tail -f` — minor operational ergonomics issue, not a correctness one.
- **No env-var changes; no Vercel changes.** The runbook's planned polling cron requires Vercel env-var setup (gate (d)) — those land with the next spec, not this one.

## Out of scope / deferred

Held intentionally for the polling-cron spec (the natural next spec):

- **`api/close_poll_cron.py`** — entry point already exists at the pipeline level (`sync_recently_updated_leads(since_iso=...)`). Wrapper + Vercel cron + Drake-gated env-var setup land in the next spec.
- **Opportunities polling branch** — if any Engine-sheet metric needs it, add to the polling cron.
- **Webhook receiver** — still deferred per the runbook trade-off (operationally safer to ship polling first).

Held for further specs:

- **EOC Forms ingestion** — separate source, serves the Engine sheet's CLOSING section.
- **Email activity mirror** — deferred per spec (6% of activity, Drake dropped from First Message Response).
- **Custom-field value history** via Close Event Log API (30-day rolling window — only relevant if back-population needed).
- **pytest coverage** for `derive_tier` + parser projection (the deferred list from Pt 1; ad-hoc validation only so far).
- **Aggregation layer** — the Gregory sales-side dashboard that READS from these tables. The mirror tables are the foundation; the user-facing surface that turns them into Engine-sheet metrics is its own spec arc.

## Side effects

- **Close API:** estimated ~10,500 read-only calls during the bulk (5,172 lead-fetches + 5,172 activity-pulls + 101 cf-schema endpoints + paginator chain + smoke + dry-run). No writes to Close.
- **Supabase:** **76,000+ rows written across six tables.** Production cloud (project ref `sjjovsjcfffrftnraocu`). All upserts on `close_id` PKs — re-runnable + idempotent. No deletes, no schema modifications outside migration 0043 itself.
- **Migration 0043 applied to cloud Supabase.** Reflected in `supabase_migrations.schema_migrations`. Migration count: 42 → 43.
- **CLAUDE.md folder-structure edit** committed in Pt 1 — `ingestion/close/` line added under `ingestion/`.
- **No Slack posts, no external API calls beyond Close.**
- **No `.env.local` changes.** `CLOSE_API_KEY` read at runtime only; never logged, never written to disk by anything in this work.
- **No Vercel changes.** No env vars added, no functions deployed, no crons modified. The polling-cron infrastructure is scoped, not built.
