# Report (PARTIAL): Close CRM Ingestion — Data Model + Backfill + Pipeline

**Slug:** close-ingestion-v1
**Spec:** docs/specs/close-ingestion-v1.md
**Status:** halted — awaiting Drake's SQL review on migration 0043 (spec gate (a))

## Files touched

**Created:**
- `supabase/migrations/0043_close_ingestion_tables.sql` — 6 mirror tables (close_leads, close_lead_status_changes, close_calls, close_sms, close_opportunities, close_custom_field_definitions) with indexes + `set_updated_at` triggers.
- `ingestion/close/__init__.py` — module docstring.
- `ingestion/close/client.py` — `CloseClient` (HTTP Basic auth, paginated iterators, retry on 429/timeout).
- `ingestion/close/parser.py` — Close JSON → row dicts; `_CF_NAME_TO_COLUMN` projection map; `derive_tier()` (Drake's ≥ $2k logic).
- `ingestion/close/pipeline.py` — idempotent upsert orchestrator (`sync_lead`, `sync_all_leads`, `sync_all_opportunities`, `sync_recently_updated_leads`, `sync_custom_field_definitions`).
- `scripts/backfill_close.py` — `--smoke` / `--apply` / `--limit` per CLAUDE.md operational convention; default dry-run.
- `docs/schema/close_leads.md`
- `docs/schema/close_lead_status_changes.md`
- `docs/schema/close_calls.md`
- `docs/schema/close_sms.md`
- `docs/schema/close_opportunities.md`
- `docs/schema/close_custom_field_definitions.md`
- `docs/runbooks/close_ingestion.md` — backfill modes, gate model, triage-count-path canonical, tier derivation, polling-cron-vs-webhooks decision, failure modes, re-run safety, out-of-scope.

**Modified:**
- `CLAUDE.md` § Folder Structure — added `ingestion/close/` line under `ingestion/`. (Single-line edit; rides in this spec's Builder work per the mandatory-doc-updates list.)

**NOT touched (deferred to the resume pass — see § Out of scope):**
- `docs/state.md` — update lands when the subsystem is actually shipped (migration applied + bulk backfill run). Spec mandates the update but the trigger is "shipped subsystem," which we aren't yet (gate (a) still pending).
- No `.env.example` change — `CLOSE_API_KEY` was already documented in the discovery spec; the polling cron isn't built yet so no new env var to add.

## What I did, in plain English

### Step 0 — CSV reconciliation (per spec)

Found the Engine CSV at the repo root as `Data Sheet - Overall Engine.csv` (filename has spaces, not underscores — the spec had `Data_Sheet_-_Overall_Engine.csv`; substituted the actual path). Read it fully.

**Big scope correction surfaced by the reconciliation:**

- **APPOINTMENT SETTING** (lines 46-92 of the CSV) — **33 Close-sourced rows + 13 derived rates.** All ~33 Engine-sheet rows in this section have `Close Smartviews` as col C source. Most map cleanly onto the inventory report's metric map; a few subdivisions (`Setter Dials to {fresh opt-ins, old opt-ins, No Shows, hand downs}`, `Setter Triages from {fresh opt-ins, old opt-ins, hand downs}`) are date-bucket variants of the same underlying activity stream — buildable from the same raw tables, just with different `WHERE` clauses.
- **CLOSING** (lines 93-122) — **almost entirely sourced from Closer EOC Forms (NOT Close).** The only Close-sourced row in the CLOSING section is "Follow Up Looms Sent" (line 104). Calendly handles "New Scheduled Meetings" / "New Rescheduled Meetings" / "Follow Up Meetings"; Fathom handles "Average Meeting Duration"; everything else (Showed Meetings, CCMI, No Shows, Reschedules, Cancelled, Objections, Deposits, Closed Deals splits, all Cash Collected variants) sources from EOC Forms.

This rewrites part of the inventory report's metric map — the closing-funnel money rows I'd inferred as "buildable from Close" in `close-full-data-inventory.md` are actually **not the canonical Close-sourced rows in the Engine sheet.** The Close payment cfs on `close_leads` (Amount of 1st-5th payment?, Date of Nth payment?, Closed?, Lost Deal?) are still mirrored — they're useful for cross-validation against EOC Forms ingestion when that lands — but they're NOT the canonical source.

**Scope adjustment:** this spec's primary deliverable is the table set + ingestion that serves APPOINTMENT SETTING (the Close-sourced section). CLOSING is served by a future EOC Forms ingestion spec.

### Schema design (migration 0043)

Six tables. Design follows the inventory report's grain decision (mirror raw objects, aggregate in SQL):

1. **`close_custom_field_definitions`** — small reference table (~100 rows total across object types) so the aggregation layer can resolve `cf_*` → human label.
2. **`close_leads`** — denormalized lead mirror. **~30 funnel-relevant lead custom fields denormalized as typed columns; full cf map kept in `custom_fields_raw` jsonb.** The denormalization choice: 52 of 88 lead cfs are populated; denormalizing all 88 would waste space and require migrations per new field. Denormalizing the funnel-relevant ~30 + jsonb catch-all lets aggregation queries hit indexed columns for the hot path and jsonb operators for the cold path.
3. **`close_lead_status_changes`** — funnel-spine event stream. Indexed on `(new_status_id, date_created)` for the per-day "leads that became X" queries that drive Hand Down, DQ, Downsell, Booked Meeting, No Show, Deposit, Client metrics.
4. **`close_calls`** — Call activities. Indexed on `(user_id, date_created)` for per-rep dial counts and `(direction, date_created)` for inbound/outbound splits.
5. **`close_sms`** — the dominant channel (67% of activity). Indexed for First Message Response queries.
6. **`close_opportunities`** — workflow markers (`value` is $1 placeholder in this org; clearly documented as NOT money).

**Key design decisions baked into the schema (full reasoning in the runbook):**

- **Triage-count canonical = `close_leads.triage_showed = 'Yes'`**, NOT the status-flip event. Drake's semantic ("the phone call where a human qualifies the lead") matches the cf, not the status transition. Status flip to `Handed-over` marks the hand-OVER, not the triage call. Documented with a gap-monitoring SQL in the runbook (cf is sparsely populated — closers need to fill it in).
- **Tier derivation = `≥ $2k disposable income → tier_1`**, computed in ingestion from the `investment` cf and stored on `close_leads.tier`. Implemented in `ingestion.close.parser.derive_tier()`; unit-tested against 8 representative Typeform values.
- **Loose FKs on `lead_id` from activity tables.** Backfill order doesn't guarantee leads land before their activities; loose ref keeps the backfill resilient. Aggregation layer left-joins for label resolution.

### Ingestion module (`ingestion/close/`)

Mirrors the Fathom shape — thin client + parser + pipeline orchestrator. All upserts are `ON CONFLICT (close_id)` keyed on Close's stable IDs. Re-running any subset is a no-op-equivalent.

- **`client.py`:** HTTP Basic auth, `urllib`-based (no new dep), 60s timeout + 3-try retry on timeouts/429s (the same pattern the discovery probe needed for heavy-lead `/activity/` calls). `iter_leads`, `iter_activities_for_lead`, `iter_opportunities`, `custom_field_schema`, `get_lead`, `me` — exactly the endpoints the pipeline uses.
- **`parser.py`:** Project Close JSON into row dicts matching `close_*` table columns. `_CF_NAME_TO_COLUMN` maps cf NAMES (not IDs — names survive org-admin recreate-with-new-id; IDs don't) to typed columns. `derive_tier()` implements Drake's ≥ $2k logic with conservative null-on-unknown.
- **`pipeline.py`:** `sync_lead()` is the per-lead end-to-end (full lead JSON + bundled `Call,SMS,LeadStatusChange` activity pull + dispatch by `_type`). `sync_all_leads()` walks the paginator. `sync_recently_updated_leads()` is the cron entry point (when wired up). Fail-soft per-record — one bad lead doesn't kill the run; errors collected in `SyncOutcome.errors` for reporting.

### Backfill script (`scripts/backfill_close.py`)

Three modes per CLAUDE.md operational convention:

- **Default dry-run** — `/me/` + first page of `/lead/` + first page of `/opportunity/`. Zero upserts. Used to confirm auth + endpoint reachability before any DB writes.
- **`--smoke`** — cf defs + one real lead end-to-end. Idempotent. **Mandatory before any `--apply`** per the operational pattern.
- **`--apply [--limit N]`** — bulk backfill. Cf defs → all leads (or capped) → all opportunities. Drake-gated for the first invocation at full scope (smoke must pass + Drake confirms; gate documented in runbook).

### Polling-cron-vs-webhooks decision

**V1 ships polling cron, webhooks deferred.** Reasoning in the runbook: webhook subscription registration is Drake-gated Close-side config (gate (d)); polling is correct-by-construction at the cost of latency. Cron implementation scoped (`api/close_poll_cron.py`, 15-minute cadence, `date_updated > now-20m` overlap window) but **NOT built in this spec** — flagged as the follow-up. The pipeline already exposes `sync_recently_updated_leads()` so the cron endpoint is a thin wrapper when it lands.

## Verification

- **`python3 -m py_compile`** on all five new Python files — exit 0. No syntax errors.
- **`derive_tier()` unit cases** — 8 representative Typeform values, all matched expected tier (Under $2,000 → tier_2; Under $5,000 → tier_1; $2,000-$5,000 → tier_1; $5,000-$10,000 → tier_1; $1,000-$2,000 → tier_2; empty / None / non-numeric → null). Quick inline ad-hoc check, not a committed pytest yet — would be added when the test file lands (out of scope per `Default: ship highest-priority forward-motion work`).
- **`.venv/bin/python scripts/backfill_close.py`** (dry-run) — auth OK (`Team AIP <success@theaipartner.io>`, org `orga_1gQ2poPe...AI Partner`), first 10 leads + first 10 opportunities listed cleanly. The full ingestion path (`CloseClient.from_env()` → `iter_leads()` / `iter_opportunities()` → JSON parse) is wired up end-to-end.
- **NOT verified:**
  - The migration itself — **HARD STOP for Drake's SQL review per spec gate (a).** Not applied yet.
  - The smoke (`--smoke`) — depends on the migration being applied first (tables must exist). Stage 2 work.
  - Bulk `--apply` — Stage 3 work, gated on smoke + Drake confirmation.

## Surprises and judgment calls

- **CLOSING section of the Engine sheet is sourced from Closer EOC Forms, NOT Close.** This is the biggest scope adjustment vs the inventory report's metric map. The closing-funnel money rows I'd inferred as buildable from Close cfs are still mirrored (for cross-validation), but they're not the canonical Engine-sheet source. The Close payment cfs (Amount of Nth payment?, etc.) are a secondary/redundancy layer once EOC Forms ingestion lands in a future spec. Documented loudly in the runbook + schema docs so this isn't a foot-gun later.
- **CSV filename had spaces, not underscores.** Spec said `Data_Sheet_-_Overall_Engine.csv`; actual file was `Data Sheet - Overall Engine.csv`. Substituted the correct path silently — not surfacing as a question because this is exactly the kind of trivial drift Drake's "don't pile on stops where there's no real boundary" feedback covers.
- **Tier derivation logic is "ceiling for `Under $X`" semantics.** The spec said `< $2k → tier_2`, but the Typeform values are inclusive ranges. `Under $5,000` could mean "this lead reported having less than $5k" — which means they could be anywhere from $0 to $5k disposable. I treat the *ceiling* as the qualifying signal: `Under $5,000` → tier_1 (because ≥ $2k is possible); `Under $2,000` → tier_2 (because the ceiling is the threshold). This is a defensible interpretation but it's a JUDGMENT CALL — Drake should sanity-check with one or two real Typeform values before the bulk backfill runs. If the org's actual Typeform values use a different bucket convention (e.g. `$0-$2k`, `$2k-$5k` — floor-based), update `derive_tier()` accordingly. Documented in the runbook.
- **Resolving cfs by NAME, not by ID.** `_CF_NAME_TO_COLUMN` keys on the human-readable cf name. An org admin could recreate a cf with the same name but a new `cf_*` id (e.g. delete + recreate) and the projection would still work. The trade-off: renaming a cf in the UI breaks projection silently until the map is updated. Acceptable trade-off given how rare cf creation/rename is and how disruptive ID-keyed projection would be on a recreate. If a cf is silently failing to project, check the name in Close UI vs `_CF_NAME_TO_COLUMN`.
- **Loose FKs (no cross-table constraint) on activity → lead.** Standard pattern across Postgres mirror tables but worth flagging — if Close ever returns an activity referencing a lead we don't yet have, the activity row lands without a corresponding lead row. Aggregation layer's left-join handles this. The alternative (strict FK + retry-on-FK-violation) is more code for marginal benefit.
- **`close_opportunities.value` mirrored despite being $1 placeholders.** Inventory report was clear that opportunities aren't money in this org. Considered dropping `value` from the schema entirely; kept it because (a) the field IS what Close returns and dropping it would lose audit fidelity, (b) some future org we deploy to might use opportunity values as real money, and (c) zero cost to keep it. Aggregation layer must NOT treat `value` as money for AI Partner; documented in the schema doc.
- **State.md update deferred.** Spec mandates a state.md update but the spec is gated mid-way (gate (a)) and "shipped subsystem" doesn't apply until the bulk backfill runs. Update lands in the resume pass.
- **Trade-off on _type__in bundling.** Pipeline pulls Call + SMS + LeadStatusChange in one `/activity/` paginated request rather than three separate calls. Cheaper (fewer API calls) but harder to debug (one timeout aborts all three). The retry loop in the client mitigates; if a single bundled call repeatedly times out on a heavy lead, the fallback is splitting to per-type calls — easy change in `pipeline.sync_lead`.
- **No tests committed yet.** Per CLAUDE.md operational default of "ship highest-priority forward-motion work" + the spec saying tests when relevant, I didn't add pytest cases for this PR. The `derive_tier()` cases would be the obvious first set; `parse_*` smoke tests against committed JSON fixtures would be the second. Logging this as deferred rather than blocking — would write them as part of the resume pass if Drake wants them before bulk.

## Out of scope / deferred

Held intentionally for the resume pass (Stage 2 / Stage 3 of this same spec):

- **Apply migration 0043** — Drake reviews SQL diff, then I run `supabase db push --linked` per `docs/runbooks/apply_migrations.md` § Apply + dual-verify.
- **Run `--smoke`** — after migration applied. Idempotent against one real lead end-to-end.
- **Run `--apply` bulk backfill** — Drake confirms smoke before invoking at full scope.
- **Update `docs/state.md`** — after bulk apply completes; include migration count → 43, new tables list, row counts, opt-in count for last 7 days for sanity.
- **Write the partial-report sequel** — `docs/reports/close-ingestion-v1-pt2.md` per the feedback memory convention (resume writes a NEW file; partial intact).

Held for future specs (separate Director scope):

- **Polling cron implementation** (`api/close_poll_cron.py`) — scoped in the runbook, not built. Follow-up spec when the V1 backfill is verified.
- **Webhook receiver** — deferred per the runbook trade-off.
- **EOC Forms ingestion** — separate source; serves the CLOSING section of the Engine sheet.
- **Email activity mirror (`close_emails`)** — deferred (6% of activity; Drake dropped from First Message Response).
- **Close Export API** — fallback for cold-start backfill if pagination ceilings become a problem.
- **Custom-field value history (Event Log API)** — 30-day rolling window; relevant only if back-population needed.
- **Pytest coverage** — `derive_tier` cases + parser smoke against JSON fixtures.

## Side effects

- **Close API:** 12 read-only calls during dry-run verification (`/me/` × 1, `/lead/?_limit=10` × 1, `/opportunity/?_limit=10` × 1, plus the discovery probes from earlier specs which are already side-effect-documented in their reports). NO writes to Close.
- **Supabase:** **NO writes.** Migration not applied (HARD STOP). No backfill ran (gated on migration).
- **Slack / external services:** none.
- **Local filesystem:** none beyond the committed files. No new `.probe-out/` dumps in this spec.
- **No env-var changes** in `.env.local`. `CLOSE_API_KEY` read at module-load and request time only.

---

## What's needed to unblock

**Drake's SQL review on `supabase/migrations/0043_close_ingestion_tables.sql`** (spec gate (a) — permanent gate per CLAUDE.md § Gate trajectory).

Key things to sanity-check:

1. **Table set + scope.** Six tables (`close_custom_field_definitions`, `close_leads`, `close_lead_status_changes`, `close_calls`, `close_sms`, `close_opportunities`). Email skipped per spec. The 30-ish denormalized cf columns on `close_leads` + the `custom_fields_raw` jsonb catch-all.
2. **Index choices.** Indexes target the per-day aggregation queries the Engine sheet's APPOINTMENT SETTING metrics will run. The runbook + schema docs document expected queries.
3. **Canonical-decision baking.**
   - **Triage-count path** = `close_leads.triage_showed = 'Yes'` (not status flip). Reasoning in the runbook § Triage-count path. Confirm.
   - **Tier derivation** ceiling-vs-floor semantics for `Under $X` values. Confirm with one or two real Typeform values to avoid silent miscount.
4. **Loose FK pattern** on activity → lead. Standard across mirror tables; confirm if you'd prefer strict FK + retry.
5. **`close_opportunities.value` kept despite $1 placeholders.** Confirm — alternative is dropping the column entirely.

After approval, I run:
```bash
DB_PW=$(...)   # per docs/runbooks/apply_migrations.md § Apply
supabase db push --linked --dns-resolver https --password "$DB_PW" --yes
```
Then dual-verify (schema reality via `to_regclass` for each new table + ledger via `supabase_migrations.schema_migrations`), then `--smoke`, then surface for `--apply` gate.

Resume report: `docs/reports/close-ingestion-v1-pt2.md` (new file per the partial-report convention; this PARTIAL report stays intact).
