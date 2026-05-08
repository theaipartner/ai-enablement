# Followups — Gregory

Real bugs and ops reminders for Gregory. Ideas live in `docs/future-ideas.md` (Gregory V2 batches A–E). Decisions to revisit live in `docs/decisions/` (when populated). Ella's followups live in `docs/agents/ella/followups.md`.

**Entry format.** Short. Four lines:

- **What:** one-sentence description.
- **Why it matters:** consequence if ignored.
- **Next action:** concrete step that resolves it (or a check that answers whether it needs resolving).
- **Logged:** date.

---

## NEXT SESSION FIRST ACTION — verify daily cron fired (one-time gate, REMOVE after running)

**This is a one-time verification gate, not a recurring routine.** First action of the next session, before any planned work. Remove this entry from `docs/followups.md` AND the matching pointer from `CLAUDE.md § Next Session Priorities` once the verification has run, regardless of outcome.

**Background.** On 2026-05-08 the gregory_brain cron switched weekly→daily AND gained an `ai_call_signal` freshness filter. The deploy from this session is the first real exercise of both. Tomorrow's 09:00 UTC scheduled fire is the integration smoke; we want to confirm before iterating further.

**Run this query** (against cloud Supabase via `shared.db.get_client()` or psql against the pooler URL):

```sql
SELECT
  count(*) AS total_rows,
  min(started_at) AS earliest,
  max(started_at) AS latest,
  count(*) FILTER (WHERE output_summary LIKE 'skipped%') AS skipped_count,
  count(*) FILTER (WHERE status = 'success') AS success_count,
  count(*) FILTER (WHERE status = 'error') AS error_count
FROM agent_runs
WHERE agent_name = 'gregory'
  AND trigger_type = 'cron'
  AND started_at >= '2026-05-08 09:00:00'
  AND started_at <  '2026-05-08 10:00:00';
```

Note: `output_summary LIKE 'skipped%'` is the cost-rollup split documented in the freshness-filter design — but `output_summary` lives on the `ai_call_signal` child runs, not the parent `gregory` runs. **The query above as written will return 0 for `skipped_count` even on a perfectly healthy sweep.** Re-run the same shape against `agent_name='ai_call_signal'` to get the true skip rate. Both queries together give the full picture.

**Three outcomes — three reads:**

1. **`agent_name='gregory'` total_rows ≈ 188, earliest+latest within 09:00–09:59 UTC AND `agent_name='ai_call_signal'` skipped_count > 150** → Scheduled cron fires correctly, freshness filter is doing its job, fully self-running. End-state achieved. Remove this entry + the CLAUDE.md pointer; proceed with planned work.

2. **`agent_name='gregory'` total_rows = 0** → Scheduled trigger still broken. Same three diagnostic gates from prior cron-firing investigation: schedule not picked up, `CRON_SECRET` mismatch (Encrypted env var masking on `vercel env pull` complicates client-side testing), or silent code-path failure. Pause planned work, diagnose this first.

3. **`agent_name='gregory'` total_rows ≈ 188 but `agent_name='ai_call_signal'` skipped_count is LOW (< 50)** → Cron fired but freshness filter has a bug. Investigate why most clients recomputed when they shouldn't have. Most likely culprits: (a) the `_last_successful_compute_iso` jsonb-key filter not matching as expected (UUID type coercion?), (b) an off-by-one in the timestamp comparison (`>` vs `>=` on `latest_review_iso > last_compute_iso`), (c) the V1.1-transition fallback firing for too many clients because the May 2026 sweep rows have a `factors.signals[]` shape we didn't anticipate. Architecturally non-blocking but worth fixing before the next iteration.

**Logged:** 2026-05-07 (one-time gate added at session-close).

---

Delivered. `ingestion/fathom/pipeline.py:_ensure_call_review_document` fires automatically after each successful `_ensure_summary_document` for client-category calls with a non-null `primary_client_id`. Three-layer idempotency (existence guard inside the helper + persistence-layer upsert + pipeline-layer non-atomic-but-idempotent invariant) means Fathom retries / dup deliveries / the documented F2.2 re-fire case cost zero LLM tokens. Fail-soft via try/except wrapper mirroring the M6.1 CS Slack post hook — review-generation failure never breaks Fathom delivery; failures land on `IngestOutcome.errors[]` for diagnostic visibility. `review_call` gained an optional `trigger_type` kwarg so pipeline-fired runs tag `agent_runs.trigger_type='fathom_pipeline'` distinct from `'manual_backfill'`.

## Gregory brain V2 weight calibration

- **What:** V2 starting weights are `ai_call_signal 0.50 + call_cadence 0.20 + overdue_action_items 0.10 + latest_nps 0.20`. Heavy-but-balanced — AI signal at half the weight, deterministic floor handles the rest. Drake's call at V2 ship is "iterate after the rubric meets reality."
- **Why it matters:** the V1.1 weights produced a 93 green / 40 yellow / 0 red distribution that overstated health (zero red was a tell). V2's daily-cron sweep distribution will tell us whether 0.50 on the AI signal is too much (one bad review tanks an otherwise-healthy client) or too little (one bad review barely moves the needle on a structurally green client).
- **Next action:** revisit after 2-3 daily sweeps with the freshness filter. Look at: (a) does the AI signal correlate with intervention decisions CSMs actually make (Slack-able to Lou for spot check)? (b) does the new tier distribution feel realistic — should we expect ~70/20/10 green/yellow/red, or is the AI signal compressing everyone toward yellow? (c) does any signal feel under-weighted (e.g. if cadence at 0.20 isn't penalizing 60+ day silences enough)?
- **Logged:** 2026-05-07.

## ~~Brain run wall-clock duration trending toward Vercel cron ceiling~~ — RESOLVED 2026-05-08

Resolved architecturally, not by ceiling bump. The V2 brain shipped with a weekly cron + 600s bump that Vercel Pro rejected; a 300s cron-bound rebaselined the watchpoint at 240s. On 2026-05-08 the cron switched **weekly → daily** AND added a **freshness filter** to `compute_ai_call_signal` — each daily sweep now only fires Sonnet for clients whose `call_review` data has changed since the last successful compute (~10 clients/day at typical velocity), instead of all 188 every Monday. Sweep duration drops from 426s+ (the timeout-killed weekly attempt observed 2026-05-08) to comfortably under 300s. See `docs/agents/gregory.md` § "Freshness filter".

**Re-watch trigger:** if any daily sweep ever crosses 240s (80% of 300s), revisit. At that point the AI signal's per-client cost has grown faster than the freshness skip rate can offset — likely cause is reviews-per-client growing past 1-2 per 30-day window, which makes single-Sonnet-call payload size blow up. Decision matrix at that point: (a) Vercel plan upgrade, (b) parallelize the per-client loop, (c) move the AI signal to a separate weekly job that updates `factors.signals` post-hoc. SweepResult.duration_ms continues to be the gauge; INFO log line continues to surface it in cron logs.

## Index on agent_runs trigger_metadata.client_id when ai_call_signal volume grows

- **What:** the daily-cron freshness filter (shipped 2026-05-08) reads "last successful ai_call_signal compute timestamp for client X" via `SELECT max(started_at) FROM agent_runs WHERE agent_name='ai_call_signal' AND status='success' AND trigger_metadata->>'client_id' = X` — a jsonb-key filter without an index. Today's scale (~500 ai_call_signal rows total) makes this fine; PostgreSQL filters fast against a small table.
- **Why it matters:** at ~10 clients/day adding ai_call_signal rows on the compute path + ~178 clients/day adding skip-path rows, daily growth is ~190 rows/day. At ~6 months of operation, table will be ~35k rows. Per-client freshness queries on every sweep iterate ~188 clients × 1 query each = 188 jsonb scans per sweep — at 35k rows each, total per-sweep scan cost grows linearly.
- **Next action:** add a partial index `CREATE INDEX agent_runs_ai_call_signal_client_idx ON agent_runs (agent_name, status, (trigger_metadata->>'client_id')) WHERE agent_name='ai_call_signal' AND status='success'` when the row count crosses ~5000. Migration straightforward; no schema change needed.
- **Revisit trigger:** `SELECT count(*) FROM agent_runs WHERE agent_name='ai_call_signal'` exceeds 5000, OR sweep duration trends upward in a way that correlates with table growth.
- **Logged:** 2026-05-07.

## Call Review V1 has no eval coverage

- **What:** `agents/call_reviewer/` has unit tests covering JSON parse + persistence shapes, but no eval coverage of output quality (does the model surface real pain_points / wins / dodged_questions, or hallucinate / pad / miss obvious signals?). May 2026 backfill produced 31 reviews (smoke + apply); spot-checking is the only quality gate today.
- **Why it matters:** prompt iteration without an eval is iteration in the dark. Once CSMs start using the surface and we get signal on what's wrong (over-flagging dodged questions, under-flagging real pain, generic sentiment_arc), an eval gives us a regression net for tuning.
- **Next action:** add a golden-set eval when output quality becomes an iteration bottleneck (target: 10-20 hand-graded reviews across the call texture, programmatic checks for "does the model find pain points the human grader marked," etc.). Not blocking V1 ship.
- **Logged:** 2026-05-07.

## Promote `call_review` exclusion into `match_document_chunks` SQL function

- **What:** `agents/call_reviewer/persistence.py` writes documents rows with `is_active=False` as the V1 retrieval-side safety net — `match_document_chunks` only returns `is_active=true` rows, so review docs never leak into Ella's retrieval. The SQL function's explicit client-scoped-type exclusion list (`call_summary` / `call_transcript_chunk`) does NOT include `call_review` because the `is_active=false` write-time invariant is sufficient at V1.
- **Why it matters:** the safety gate disappears the moment anything sets `is_active=true` on a review row. V2 will wire review generation into the Fathom ingestion pipeline (likely with a per-call ingest hook), and at that point a small mistake — copy-pasting the summary's `is_active=true` line into the review's INSERT — would silently leak reviews into retrieval. Promote the exclusion into the SQL function via migration so the gate lives in the database, not in caller discipline.
- **Next action:** when V2 generation lands (or before, if anyone else touches the persistence layer): add a migration that extends `match_document_chunks` to also exclude `document_type='call_review'` from global-mode results, and update `docs/ingestion/metadata-conventions.md` §7 in the same commit.
- **Logged:** 2026-05-07.

## Cron auth: all Vercel crons share one project-level CRON_SECRET

- **What:** all Vercel cron endpoints in this project share a single `CRON_SECRET` env var (Vercel project-level convention; Vercel sends this as the `Authorization: Bearer <token>` regardless of which cron entry fires). The env var name is fixed by Vercel's cron infrastructure — not configurable via `vercel.json` or anywhere else. Confirmed empirically during the M6.1 401 saga: a per-cron-namespaced token convention was tried earlier (`FATHOM_BACKFILL_AUTH_TOKEN`, `GREGORY_BRAIN_CRON_AUTH_TOKEN`, `ACCOUNTABILITY_NOTIFICATION_CRON_AUTH_TOKEN`) and required operators to keep `CRON_SECRET` in sync with the custom token, which silently failed at the M6.1 deploy. Refactored to single-source-of-truth in M6.2.
- **Why it matters:** independent per-cron rotation is **NOT supported by Vercel**. Rotating `CRON_SECRET` rotates auth for every cron in the project simultaneously. If a use case ever surfaces requiring true independence (e.g., a third-party caller who shouldn't be able to trigger ALL crons by knowing one secret, or a per-cron rotation cadence the org needs to maintain for compliance reasons), the codebase would need a separate auth surface — likely a per-cron HMAC-signature scheme or a per-cron API gateway in front of the function. Not solvable via env var naming.
- **Next action:** none today. Logged as a constraint to remember when designing future cron endpoints. If Drake adds a new cron, just point its `_verify_auth` at `CRON_SECRET` like the existing three. If a third-party trigger becomes a real requirement, design a separate auth path (this followup is the prompt to remember the constraint).
- **Logged:** 2026-05-06 (M6.2 cron-auth consolidation refactor surfaced the architectural finding via the M6.1 401 diagnosis).

## NPS harness fixture (`Branden Bledsoe`) was archived 2026-05-05

- **What:** `scripts/test_airtable_nps_webhook_locally.py` uses Branden Bledsoe (`brandenbledsoe@transcendcu.com`) as the test fixture for happy-path NPS update probes. Branden was soft-archived 2026-05-05 in the M5 misclassified-client cleanup (he was Isabel Bledsoe's representative, not a real client). The NPS receiver's `update_client_from_nps_segment` RPC filters on `archived_at IS NULL`, so any harness call against Branden now hits the 404 "no active client matches email" path rather than the happy update path. Discovered while writing the M5.9 onboarding harness — that harness initially mirrored the NPS pattern and surfaced the same break.
- **Why it matters:** the NPS harness will start failing on tests 1 and 2 (the two happy paths). Tests 3–8 are negative paths and stay green. CI doesn't run the harness, so silent breakage is the realistic failure mode — Drake or someone running the harness manually will hit it.
- **Next action:** refactor the NPS harness to use a self-seeded fixture (mirror M5.9's pattern in `scripts/test_airtable_onboarding_webhook_locally.py`: per-run unique email, hard-deleted in cleanup, no reliance on production data). One ~30-minute change. Alternatively pick a different stable client, but self-seeding is the more robust fix and matches the new convention.
- **Logged:** 2026-05-05 (M5.9 onboarding receiver build surfaced this).

## Country filter on /clients silently misses non-USA/AUS payload values

- **What:** the M5.7 Country filter dropdown on `/clients` sources its options dynamically from `clients.country` distinct values (USA / AUS / null today). The M5.9 onboarding receiver passes the form's `country` field through to the column as-is, with no validation against a vocab. If Zain's onboarding payload ever sends a value outside `'USA'`/`'AUS'` (e.g. `'United States'`, `'Australia'`, `'UK'`, free-text variants), that client lands in the DB with the new value — then the filter dropdown surfaces it as a separate option, and any pre-existing filter URL bookmarked on `?country=USA,AUS` will silently miss the new client.
- **Why it matters:** the failure mode is "client doesn't appear under a filter the CSM expected to be exhaustive" — soft, not loud. CSMs may not realize their saved-filter view is incomplete. Compounds if multiple variant strings accumulate.
- **Next action:** revisit if it surfaces. Two paths: (a) add a CHECK constraint on `clients.country` enforcing the canonical short codes (USA / AUS / future codes), and have the receiver normalize at the boundary; (b) leave the column free-text but add a normalization layer in the receiver (`country.upper().strip()` plus a known-aliases map: "United States" → "USA", "Australia" → "AUS"). Lean: (b) — cheaper, doesn't require a migration, accommodates future Zain-side CSV drift.
- **Logged:** 2026-05-05 (M5.9 onboarding receiver build).

## Fathom classifier false-positive: hiring interview classified as client

> **Batch D framing:** address only if CSM titling discipline doesn't suppress this pattern; otherwise leave.

- **What:** Andy Gonzalez (DB row was `Andrés González` / `andy@thecyberself.com`) was a hiring-interview series — Scott interviewed him as a potential teammate, NOT a sales prospect. Fathom's classifier auto-created him as a client and tagged 3 calls as `category='client'` because the conversation pattern (1:1 with Scott, professional tone, sales-flavored discussion of work and engagement) matched the client heuristic. Resolved 2026-05-05 via `scripts/archive_misclassified_clients.py` — 3 calls reclassified to `external`, client soft-archived with `metadata.misclassification_type='external_hiring'`.
- **Why it matters:** any Scott-led interview (hiring, podcast guest prep, reverse pitches from vendors) is at risk of the same false-positive. Cost is low (false-positive client rows in Gregory) but pollutes counts and triggers Path 2 outbound roster inclusion if not caught. With the M5.6 cascade, a wrongly-active false-positive client also sits in active counts until manually status-flipped.
- **Next action:** track recurring instances. If 3+ surface in the next quarter, classifier needs a "hiring/recruiting context" signal — could be heuristic (`participant_email_domain` is on a known external recruiting domain, conversation contains words like "interview", "compensation", "benefits") or a re-prompt of the LLM call to consider non-client-but-1:1-with-Scott patterns explicitly. Until then: periodic spot-checks of `clients` rows where `category='client'` calls have been auto-created and the participant is unfamiliar to Scott.
- **Logged:** 2026-05-05 (M5 misclassified-client archive sweep).

## Fathom classifier false-positive: representative-of-existing-client

> **Batch D framing:** address only if CSM titling discipline doesn't suppress this pattern; otherwise leave.

- **What:** Branden Bledsoe joined Isabel Bledsoe's offboarding call as her representative (likely her husband — she had Branden handle the contract review on her behalf). Fathom didn't recognize the relationship and auto-created Branden as a separate client when his email/name appeared as the non-Scott participant. Resolved 2026-05-05 via `scripts/archive_misclassified_clients.py` — 1 call's `primary_client_id` repointed to Isabel; Branden's row soft-archived with `metadata.misclassification_type='representative_of_other_client'` + `rerouted_to_client_id=<Isabel's UUID>`.
- **Why it matters:** every churned-or-leaving client where a spouse / business partner / lawyer / accountant joins a final call is the same shape. Real client conversation; wrong primary attribution. The autocreate clutters Gregory with false rows and breaks downstream client-of-record analytics.
- **Next action:** classifier needs context awareness — "is this participant talking on behalf of an existing Gregory client based on shared last name + conversation context (referring to the existing client by name, using 'her account', 'on Isabel's behalf')?" For V1 a simpler heuristic: if a new auto-created client shares a last name with an existing active client AND the call has only 1 non-Scott participant, flag for review rather than auto-creating. Doesn't catch all cases but catches the common spousal-rep pattern. Track recurring instances meanwhile.
- **Logged:** 2026-05-05 (M5 misclassified-client archive sweep).

## Fathom ingestion: Apple iMIP @imip.me.com email duplicate-create

> **Batch D framing:** address only if CSM titling discipline doesn't suppress this pattern; otherwise leave.

- **What:** Robert Traffie had a duplicate Gregory row created from a calendar invitation routed through Apple's iMIP service — the participant email was `2_<long-token>@imip.me.com` rather than his real personal email. Fathom's resolver didn't recognize this as a forwarding/relay address and created a fresh client row with the iMIP email as primary. Surfaced during the 2026-05-05 needs_review walkthrough; merged via `merge_clients` RPC during that walkthrough.
- **Why it matters:** any iCloud user who accepts a calendar invite from another platform (Outlook, Google, etc.) routes the RSVP through `@imip.me.com`. Recurring pattern for Apple-using clients. Each duplicate auto-create is one more row to merge manually.
- **Next action:** Fathom ingestion classifier should detect the `@imip.me.com` domain and either: (a) skip auto-create entirely on iMIP-only emails, leaving the call with an unresolved participant flag for human review, or (b) auto-merge to an existing-by-name client when the rest of the participant context (full name + concurrent participants) makes the link obvious. (b) is preferable for ergonomics; (a) is simpler. Same fix likely applies to other relay domains (Outlook proxy addresses, Google Calendar generated UIDs that show up as emails, etc.).
- **Logged:** 2026-05-05 (M5 needs_review walkthrough — Robert Traffie merge).

## needs_review tag doesn't auto-clear after manual reconciliation

- **What:** the M3.2 auto-create flow tags new clients with `tags @> ['needs_review']` so the dashboard surfaces them in the Needs Review filter. After Drake reconciled ~13 clients during the 2026-05-05 walkthrough (canonical match confirmed via dashboard merge or simple eye-on-row inspection), the tag had to be manually cleared. No automatic detag on confirm-canonical / merge / primary_csm-assignment / inline-edit.
- **Why it matters:** the Needs Review filter accumulates resolved cases over time and stops being a useful triage queue. CSMs see a stale list and ignore it because most of it is already-handled.
- **Next action:** add automatic tag removal on three trigger events: (a) any call to `merge_clients` RPC (the source row gets archived; the target keeps the tag if it had one — auto-clear if it does); (b) any call to `change_primary_csm` RPC (assigning a primary CSM to a needs_review client implies it's been confirmed and routed); (c) any inline-save via `updateClient` that touches a "real" field (status, csm_standing, notes, etc., as opposed to just a tag edit). All three are RPC- or function-level — single line in each. Or alternatively: add a tracker job that periodically clears the tag on clients with primary_csm assigned + at least one client_status_history row (i.e., touched by a CSM).
- **Logged:** 2026-05-05 (M5 needs_review walkthrough — manual detag pattern observed across 13 clients).

## Signup date timezone display offset (renders 1 day early across all clients)

- **What:** every Gregory client's `start_date` (master sheet's `Date` column) renders one calendar day earlier than the CSV's value across the dashboard. Confirmed across 191+ clients during 2026-05-05 walkthrough — universal pattern. The CSV stores `M/D/YYYY`; `clients.start_date` is a `date` type; the dashboard renders via `Date.toLocaleDateString` or similar that interprets the stored value with timezone-aware locale shift. Drake is in UTC-7; storing `2026-04-23` and rendering it in UTC-7 produces `Apr 22` because the implicit midnight-UTC gets backshifted.
- **Why it matters:** cosmetic but trust-undermining — every client looks like they signed up the day before they actually did. A CSM checking the dashboard against a calendar invite sees a 1-day discrepancy and starts to distrust other dates too. Compounds for clients near month/quarter boundaries.
- **Next action:** display-layer fix only — DB stores correct date. Either: (a) parse as date-only via `new Date(value + 'T00:00:00')` to anchor to local midnight before formatting; (b) use a date-only formatter that doesn't apply timezone shift (e.g. `format(parseISO(value), 'MMM d, yyyy')` from date-fns); (c) explicit `{timeZone: 'UTC'}` option to `Intl.DateTimeFormat`. Cheapest fix is (c) on every `Date.toLocaleDateString` call site that handles a column typed as `date`. Audit all call sites in `app/(authenticated)/clients/[id]/` and `components/client-detail/`.
- **Logged:** 2026-05-05 (M5 needs_review walkthrough — universal pattern confirmed across 191+ clients).

## Aman's pre-team-email period — full_name "Aman Ali" + alternate email backfill

- **What:** Aman is now on `team_members` but his old call (2026-04-19, "30mins with Scott (Aman Ali)") was made before his team_members row existed, with a personal email (`amanxli4@gmail.com`) Fathom auto-created as a client row. The cleanup script (2026-05-05) reclassified the call to `internal` and archived the auto-created client row. Two follow-ups feed off this: (1) the call title `30mins with Scott (Aman Ali)` confirms Aman's full last name is **Ali** — `team_members.full_name` should read "Aman Ali" not just "Aman" (or whatever the current value is); (2) `amanxli4@gmail.com` should be added to Aman's team_members row's `metadata.alternate_emails` (or equivalent — team_members schema may not yet have alternates) so future calls/messages from that email auto-classify as internal without going through the misclassification → archive cycle again.
- **Why it matters:** without the backfill, any future call from Aman's old email re-triggers the same misclassification. Without the full_name fix, dashboard listings show "Aman" instead of "Aman Ali" and any name-based linkage (like the master sheet reconcile's name-fallback resolution) won't match cleanly.
- **Next action:** (1) inspect `team_members` schema — confirm there's an alternate-email storage path. If not, add a `metadata.alternate_emails` jsonb pattern mirroring the `clients` shape, and update the Fathom classifier to consult it. (2) Update Aman's row: `UPDATE team_members SET full_name = 'Aman Ali', metadata = metadata || jsonb_build_object('alternate_emails', jsonb_build_array('amanxli4@gmail.com')) WHERE full_name ILIKE 'Aman%' AND archived_at IS NULL;` — verify the row resolves to a single match before applying.
- **Logged:** 2026-05-05 (M5 misclassified-client archive — full_name surfaced in call title).

## Cleanup completeness — 4 N/A clients autocreated as churned (forensics flag)

- **What:** the M5 completeness pass (2026-05-04) autocreated 4 USA clients whose master sheet status was `N/A` — Vaishali Adla, Scott Stauffenberg, Clyde Vinson, Rachelle Hernandez. Per spec, `N/A` was coerced to `status='churned'` and the literal CSV string preserved on `metadata.original_master_sheet_status='N/A'`. These rows are discoverable via SQL: `SELECT * FROM clients WHERE metadata->>'original_master_sheet_status' = 'N/A';`. Mishank (AUS) also autocreated with `original_master_sheet_status='Churn (Aus)'` (real Churn, not N/A).
- **Why it matters:** `N/A` status in the master sheet is Scott's "I don't know what to do with this client" sentinel. Coercing to churned was Drake's call so they don't pollute Active counts and don't trigger the cascade weirdly. If Scott later wants to revive any of them, the metadata string surfaces the original ambiguity so the dashboard can show "this was N/A — you flipped it to active intentionally?".
- **Next action:** ad-hoc — surface these 4 in Scott's onboarding meeting (under Bucket A of `docs/data/m5_cleanup_scott_notes.md`). If Scott wants any reactivated, manual dashboard flip + the metadata string remains as historical context. If Scott wants the metadata cleaned up later, one-line SQL to remove the key.
- **Logged:** 2026-05-04 (M5 completeness pass).

## Master sheet CSV canonical location

- **What:** Going forward, drop fresh master sheet exports under `data/master_sheet/master-sheet-<MM-DD>/`. `cleanup_master_sheet_reconcile.py` and `cleanup_master_sheet_completeness.py` both default to that location. Prior `/mnt/c/Users/drake/Downloads/` defaults pointed at stale Windows-side downloads — the canonical export superseded that, and the script's path constants are now repointed in-repo.
- **Why it matters:** if a future cleanup pass needs the CSVs, the in-repo location keeps the source-of-truth co-located with the script that consumes it. The `master-sheet-<MM-DD>` subdirectory naming captures "as of which date" for forensics — comparing two exports across a few days surfaces what Scott edited in between.
- **Next action:** when a fresh export is needed, drop `Financial MasterSheet (Nabeel - Jan 26) - USA TOTALS.csv` and `Financial MasterSheet (Nabeel - Jan 26) - AUS TOTALS.csv` (note: spaces + parens in filenames are correct) into a new `data/master_sheet/master-sheet-<MM-DD>/` directory. If the directory naming convention changes (e.g., Scott renames the spreadsheet), update the script's `DEFAULT_USA_CSV` / `DEFAULT_AUS_CSV` constants in `cleanup_master_sheet_reconcile.py`. The completeness script imports those constants so a single edit covers both.
- **Logged:** 2026-05-04 (path repoint during the M5 delta + completeness pass).

## Cleanup pass — toggle re-activation for positive-status transitions

- **What:** the M5 master sheet reconcile (2026-05-04) fired status flips going positive (`ghost→active` or `paused→active`) for 2 clients (Marcus Miller, Allison Jayme Boeshans) and possibly more in future runs. The M5.6 cascade is **one-directional** (off-only) — when those clients moved INTO negative status earlier, `accountability_enabled` and `nps_enabled` got flipped to false, and the cascade does NOT auto-revert on positive transitions. So Marcus Miller is now active but `accountability_enabled=false, nps_enabled=false`. Allison Jayme Boeshans appears to have been manually flipped back to true at some point.
- **Why it matters:** an active client with accountability/nps automation off won't get DMs, nudges, or NPS surveys. If Scott expects these clients to receive automation, the toggles need a manual flip or the cleanup script needs a "positive-transition toggle reset" pass.
- **Next action:** two paths. (a) Add a "positive-transition toggle reset" subsection to `scripts/cleanup_master_sheet_reconcile.py` that flips toggles to true when status goes from negative → active. Risk: makes the apply less idempotent (re-running might flip something Scott explicitly wants off). (b) Surface positive-transition clients in scott_notes Bucket B with their current toggle state and let Scott decide per-client. Lean: (b) — keeps the cleanup script's "respect Scott's explicit CSV values" semantics intact.
- **Logged:** 2026-05-04 (M5 master sheet reconcile — Marcus Miller + Allison Jayme Boeshans surfaced this).

## Cleanup pass — Matthew Gibson is in CSV but not Gregory

- **What:** Matthew Gibson (USA row 180, email `leandeavor@gmail.com`, owned by Nico) is on Scott's master sheet as an active client AND is one of the handover-note targets per Scott's morning message. He doesn't exist in Gregory yet (handover note couldn't apply to him; surfaced to scott_notes A6 + A9). 7 other unmatched-with-email or unmatched-without-email CSV rows are similar candidates — see scott_notes A9 + A10.
- **Why it matters:** these clients are operationally real but invisible to Gregory. Scott's daily Gregory review will miss them. Path 2 outbound roster also doesn't include them.
- **Next action:** for each unmatched-with-email row (Matthew Gibson, Anthony Huang, Melvin Dayal): confirm with Scott whether to create or whether they're duplicates of an existing Gregory client (then add to alternate_emails). For unmatched-without-email rows (5 clients): Scott decides per row. Once Matthew Gibson is created, re-run the cleanup script — the handover-note append is idempotent and will pick him up.
- **Logged:** 2026-05-04 (M5 master sheet reconcile A6/A9/A10).

## Cleanup pass — re-run cadence + idempotency monitoring

- **What:** `scripts/cleanup_master_sheet_reconcile.py` is designed to be re-run as Scott edits the master sheet. The first run (2026-05-04) made 95 explicit DB writes touching ~70 unique clients. Idempotency is achieved per-RPC (no-op when unchanged), per-trustpilot (UPDATE only when value differs), and per-handover-note (gate on literal-text-not-present). But each re-run does fire the cascade trigger for any negative-going status transition that's already true, writing a fresh `client_standing_history` row attributed to Gregory Bot with `cascade:status_to_<status>:by:<gregory-bot-uuid>`. Documented intentional in M5.6, but worth knowing if scanning history.
- **Why it matters:** if Scott's master sheet stops drifting (Path 2 outbound landed yesterday, so Gregory ↔ Make.com automation is closing the loop), this script becomes a periodic sanity check. If it stays drift-y because Scott still edits the master sheet manually, the script becomes a regular sweep tool. Either way: the audit trail builds up `cleanup:m5_master_sheet_reconcile` history rows over time.
- **Next action:** decide cadence after a few runs. Options: (a) ad-hoc when Scott sends a "match Gregory to my sheet please" Slack, (b) weekly cron (would need a Vercel function wrapper or Make.com trigger), (c) deprecate the script entirely once Path 2 + future Path 3-equivalent loops close all the holes. Lean: (a) until the next two cleanup-pass uses tell us whether (b) or (c) is right.
- **Logged:** 2026-05-04 (M5 master sheet reconcile first run).

## Path 2 outbound — slack_channels staleness vs Slack-side archive state

- **What:** the endpoint trusts our `slack_channels.is_archived` column. We have no reconciler that updates that flag when a channel is archived on Slack's side. A channel archived in Slack but still `is_archived=false` in our table will surface a `slack_channel_id` Make.com then fails to post to (Slack API returns `channel_not_found` or similar).
- **Why it matters:** undetected drift = Make.com automation silently failing to deliver to specific clients, with the failure logged on Make.com's side rather than ours. Likely rare today (channels don't get archived often) but the gap is real.
- **Next action:** either (a) add a reconciler that periodically checks Slack `conversations.info` for each non-archived `slack_channels` row and flips `is_archived=true` on Slack-archived channels, OR (b) accept the drift and let Make.com surface "channel not found" failures back to Drake/Zain operationally. (b) is the V1 stance. Trigger to revisit: any reported case of accountability/NPS automation failing to deliver to a specific client.
- **Logged:** 2026-05-04 (Path 2 outbound ship — V1 carve-out, deferred).

## Client→Slack-identity coverage gap — 60 of 188 non-archived clients filtered from Path 2 roster

- **What:** Path 2's deploy-time numbers showed 100 actionable / 195 non-archived = 95 filtered server-side. After M5 cleanup + M5.7 ship the count is 128 / 188 = 60 filtered. Of those 60, the breakdown is some combination of: NULL `clients.slack_user_id`, no row in `slack_channels` matching the client, and (rarely) NULL `clients.email`. CLAUDE.md's prior per-message coverage note (`~94 of 2,914 messages from unknown authors`) is a different angle on the same underlying gap.
- **Why it matters:** these clients can't be acted on by Make.com's accountability or NPS automation until their Slack identity resolves. If most are paused/leave/churned, the gap is mostly cosmetic; if meaningful chunks are active clients, Scott will notice missing rows on his daily check.
- **Next action:** triage SQL — count the 60 by `status`. If active count is meaningful, build a one-shot resolver: hit Slack `users.lookupByEmail` per unresolved `clients.email`, populate `slack_user_id` on hits.
- **Logged:** 2026-05-04 (Path 2 outbound deploy — surfaced the per-client view of an existing gap).

## EditableField `<select>` missing id/name/htmlFor — a11y gap

- **What:** the `<select>` rendered by `components/client-detail/editable-field.tsx` (renderEditor's enum / three_state_bool branch, around lines 280-305 of the post-hotfix file) has no `id` or `name` attribute, and the `<Label>` rendered above it at line ~197 has no `htmlFor` linking the two. Same gap exists on the text/textarea/integer/numeric/date `<Input>` and `<Textarea>` variants. Surfaced during the M5.6 hotfix diagnosis when Drake noticed browser dev tools warning about un-labeled form fields; ruled out as a cause of Bug 1 (silent-click bug) but the a11y problem is real.
- **Why it matters:** screen readers can't announce field labels reliably. Browser autofill heuristics rely partly on `name`/`id` to recognize fields. Form validation tooling (and tests) that reference fields by name don't work. None of these are V1-blocking — the dashboard is internal-only with no screen-reader users today — but the gap will bite the moment Gregory ships beyond the agency.
- **Next action:** thread a stable per-instance id from the `EditableField` props down to the input element and to the `<Label htmlFor=...>`. Either (a) generate via `useId()` if React 18+ is in scope (it is — check `package.json`), or (b) take an `id` prop and have call sites pass slugged labels (e.g. `id="client-status"` for the Status field). Option (a) is more idiomatic and zero-config at call sites. Sweep all input variants in the same pass: `<select>` (line ~280), `<Input>` (line ~349), `<Textarea>` (line ~248). ~20-line refactor; no behavior change. Worth bundling with any other EditableField change.
- **Logged:** 2026-05-04 (M5.6 hotfix surface — diagnosis ruled out as cause of Bug 1 but the underlying a11y issue stands).

## M5.6 silent-toggle backfill — 17 clients flipped accountability/nps without history row

- **What:** the M5.6 migration 0022 backfilled `accountability_enabled` and `nps_enabled` to `false` on 82 negative-status clients. 65 of them got a `cascade:backfill:m5.6` row in `client_standing_history` (those whose `csm_standing` flipped from a non-`at_risk` value or NULL). The other 17 already had `csm_standing='at_risk'` from prior CSM judgment / master-sheet seed, so the backfill flipped the toggles without writing a history row — `csm_standing` didn't change, so the history insert (which is keyed on csm_standing transitions) had nothing to write. There is no `client_accountability_history` / `client_nps_enabled_history` table in V1 either, so the toggle change for these 17 is invisible in the audit trail.
- **Why it matters:** if a CSM later asks "why is accountability off for client X?" and X is one of the 17, the only signal is the migration commit message + this entry. Most queries against the audit trail (e.g. the cascade-attribution query in `docs/schema/client_standing_history.md`) won't surface them. Static snapshot of the 17 client IDs is preserved at `docs/data/m5_6_silent_toggle_backfill.md`.
- **Next action:** if Path 2 audit requirements OR a CSM workflow demands a per-toggle history table, build `client_accountability_history` and `client_nps_enabled_history` (mirror `client_status_history`'s shape: `id, client_id, value boolean, changed_at, changed_by, note`). Backfill from `webhook_deliveries` (post-Path-2 records) plus the 17-client snapshot above. Not urgent — V1 doesn't need toggle-level audit yet.
- **Recovery SQL — identify the silent-toggle 17 post-hoc.** This query mirrors the snapshot file's set as long as none of the 17 has had `csm_standing` cleared+re-set OR a CSM has manually flipped the toggles back on:
  ```sql
  select c.id, c.full_name, c.status, c.csm_standing,
         c.accountability_enabled, c.nps_enabled
  from clients c
  where c.archived_at is null
    and c.status in ('ghost','paused','leave','churned')
    and c.csm_standing = 'at_risk'
    and c.accountability_enabled = false
    and c.nps_enabled = false
    and not exists (
      select 1 from client_standing_history csh
      where csh.client_id = c.id
        and csh.note = 'cascade:backfill:m5.6'
    )
  order by c.status, c.full_name;
  ```
  Cross-check against `docs/data/m5_6_silent_toggle_backfill.md` — divergence means one of: (a) a client had csm_standing cleared and re-set (creating a real history row, removing them from this query's set), (b) a CSM has manually flipped a toggle back to true (the row no longer matches the toggle filter), or (c) a future cascade re-fire wrote a fresh history row. All three are expected lifecycle outcomes; the snapshot file is the immutable "as of M5.6 apply" reference.
- **Logged:** 2026-05-04 (M5.6 close-out — 17 silent toggles accepted per Drake's (a)+(d) call instead of building toggle-level history tables now).

## STATUS_DEFAULT_SELECTED duplicated across client/server boundary

- **What:** the M5.5 filter bar's default-status trio (`['active','paused','ghost']`) is hard-coded twice — once in `app/(authenticated)/clients/filter-bar.tsx` (Client Component, used to pre-check the Status dropdown when the URL param is absent) and once in `app/(authenticated)/clients/page.tsx` (Server Component, used by `readFilters` to inject the same default into the DB query). Both copies are identical; neither imports from the other because the `'use client'` boundary made a shared module path awkward at M5.5 ship time.
- **Why it matters:** if the default trio ever changes (e.g. Scott decides Ghost shouldn't be on by default, or Leave should be), two files need editing. Drift between them produces a silent UX bug — the dropdown UI shows one default while the server query applies a different one, and a fresh page load looks like the filter is "checked but ignored."
- **Next action:** extract to a third file like `lib/clients-filter-defaults.ts` (or fold into `lib/client-vocab.ts` since it's adjacent to the status vocab). Both call sites import the constant. ~5-line refactor, zero behavior change. Worth doing alongside any future filter-default tweak; not urgent on its own.
- **Logged:** 2026-05-03 (M5.5 close-out — intentional defer at ship time).

## NPS backfill — 4 manual-override-sticky divergences worth Scott discussion

- **What:** the M5.4 backfill's `auto_derive_applied=False` cases were the 4 clients where Scott's existing manual `csm_standing` differs from the segment-mapping. All four: Scott's read is **harsher** than NPS. Tina Hussain (NPS Neutral → mapping content; Scott set at_risk). Jenny Burnett (NPS Neutral → content; Scott at_risk). Mary Kissiedu (NPS Neutral → content; Scott at_risk). Saavan Patel (NPS At Risk → at_risk; Scott problem — one step worse).
- **Why it matters:** signal that NPS is over-optimistic for these clients vs CSM judgment with full context. Useful framing for Scott's Monday onboarding — these are exactly the "manual judgment trumps NPS" cases the override-sticky logic was designed for. The receiver correctly skipped auto-derive on all 4.
- **Next action:** surface the list at Monday's onboarding as discussion items. No code action — the data is correct; this is product/CSM workflow context. If Scott wants a "divergence dashboard" view in the future, it's a small `WHERE csm_standing != <derived from nps_standing>` query against `clients`.
- **Logged:** 2026-05-03 (M5.4 backfill).

## Master-sheet-import seed treatment for auto-derive eligibility — architectural question pending Monday

- **What:** the 137 clients with `csm_standing` set by the M4 Chunk C master sheet importer all carry `changed_by=NULL` on their `client_standing_history` rows (note `'import seed'`). Per the override-sticky rule (`changed_by != Gregory Bot UUID` → skip), these clients are **ineligible for auto-derive forever** unless the rule changes. Concrete impact from M5.4 backfill: only 2 of 59 successful sends actually wrote `csm_standing` via Gregory Bot; the other 57 sticky-skipped because their existing csm_standing came from the importer.
- **Why it matters:** if Scott wants NPS segments to drive `csm_standing` updates going forward (which is what M5.4 was set up for), the master-sheet seed effectively locks the column. Two paths: (a) treat master-sheet-seed as auto-derive-eligible (one-time NULL → Gregory Bot retroactive update on existing history rows, OR change the rule to "changed_by IS NULL OR Gregory Bot"); (b) accept that Scott's master-sheet seeds win and any future auto-derive only fires on net-new clients or clients Scott explicitly clears to NULL. The override-sticky design as built assumes (b); Drake-Scott Monday conversation may flip to (a).
- **Next action:** Monday onboarding decision. If (a): write a one-shot script to update existing master-sheet-seed history rows' `changed_by` to Gregory Bot UUID, OR amend the function logic. If (b): document explicitly in `gregory.md` that master-sheet-seeds are sticky by design.
- **Logged:** 2026-05-03 (M5.4 backfill — exposed the structural implication).

## Airtable NPS Clients name whitespace hygiene

- **What:** multiple rows in Airtable's NPS Clients table have leading/trailing/double whitespace in the Name field — e.g. `' Javier Pena'`, `' Vid'`, `' Marcus Miller'`, `'Edward  Molina'`, `'Jerry Thomas '`. Spotted during the M5.4 backfill dry-run; the script logs them with the exact whitespace preserved.
- **Why it matters:** doesn't affect email-based matching (the receiver's RPC lookup uses `clients.email`, not `clients.full_name`) and doesn't affect Gregory data quality directly. But the Airtable side is messier than ideal — name-based lookups, future Airtable formulas that cross-reference Names, and any human reading the table get noise.
- **Next action:** Airtable-side hygiene pass — Drake or Zain trims whitespace on the affected rows. Or: an Airtable automation that runs `TRIM()` on Name field changes. Low-priority operational hygiene.
- **Logged:** 2026-05-03 (M5.4 backfill dry-run output).

## Receiver-broken-diagnosis — two-step pattern for "is the function actually live?"

- **What:** when a Vercel serverless function appears broken (HTML response on GET instead of friendly JSON, 404 on POST, etc.), there's a two-step diagnostic that catches >90% of cases before deeper investigation: **(1)** `git log origin/main..HEAD` to confirm no unpushed local commits — Code's commits land in local-only state until pushed, and a deploy can't include code that isn't on origin yet. **(2)** Vercel deployment Functions tab — confirm the function actually appears in the build. If absent, either `vercel.json`'s `functions` block is missing the entry, or the file path doesn't match what Vercel expects.
- **Why it matters:** the receiver-shipped-but-broken failure mode tends to look like real code bugs but is usually a deploy/sync gap. Both steps take <30 seconds; either alone catches most cases.
- **Next action:** no code action. Worth referencing in any future "the receiver isn't responding" diagnostic flow — either a runbook addition or a CLAUDE.md operational note.
- **Logged:** 2026-05-03 (M5.4 — captured during deploy verify operations).

## Vercel `auto_derive_applied` response field is best-effort inference — pre-state SELECT could give true precision

- **What:** `api/airtable_nps_webhook.py` returns `auto_derive_applied` by comparing post-RPC `csm_standing` to the segment-mapping. Documented false positive: when a CSM manually set `csm_standing='happy'` (sticky override) and a 'promoter' segment arrives, the RPC skips the auto-derive but the values still match → response says `auto_derive_applied=true`. Verified concretely in the M5.4 backfill: 53 of 59 successes had this false positive (only 2 actual auto-derive writes). The simple comparison was an explicit V1 design choice (accepted by Drake during the receiver chunk).
- **Why it matters:** the response body misleads anyone who reads `auto_derive_applied` as "the auto-derive ran." The source of truth is `client_standing_history.changed_by`. Documented in code comments, gregory.md, and the receiver's response-shape table — but if Make.com or future operators rely on the flag for their own logic, it'll bite.
- **Next action:** if false positives become operationally annoying (someone reads the report wrong, or Make.com tries to route on the flag): add a pre-state `SELECT csm_standing FROM clients WHERE id = ?` before the RPC call, then compute `auto_derive_applied = (pre != post) OR (pre IS NULL)`. One extra round trip, true precision. ~10 lines in the receiver. Defer until needed.
- **Logged:** 2026-05-03 (M5.4 receiver — V1 accepted-imprecision flagged for V2 if it bites).

## `lib/supabase/types.ts` manually edited — next CLI regen will overwrite cleanly

- **What:** The Supabase types regen path is broken in this environment (CLI misroutes per the standing followup; Studio UI's gen-types feature was moved/removed in newer dashboard versions). For new-column work to compile, `lib/supabase/types.ts` is hand-edited each time a migration adds a column. Standing assumption until regen path is restored: every new schema chunk requires a corresponding hand-edit to types.ts in the same commit.
- **Why it matters:** the file was wiped during a regen attempt and recovered via `git checkout HEAD -- lib/supabase/types.ts` before the manual additions. Any further new columns or RPCs added before a working regen path is restored will need the same hand-edit treatment, and the file will gradually drift from cloud reality. CHECK constraints on `clients.status` (M5.3 added `'leave'`) and `clients.trustpilot_status` (M5.3b renamed) didn't need any types-file changes because Postgres CHECK constraints don't lift to TS literal unions in supabase-cli's regen output anyway — those values stay as plain `string`.
- **Next action:** when a working regen path becomes available again (CLI fix, Studio UI restoration, or a new tool), run regen and let it overwrite the manual edits cleanly. Schedule a follow-up regen review at that point.
- **Logged:** 2026-05-03 (M5.4 follow-up — relocation chunk surfaced the gap and accepted the manual-edit bridge).

## Airtable NPS receiver — no idempotency layer; Make.com retries create duplicate writes

- **What:** `api/airtable_nps_webhook.py` ships in V1 without idempotency. Every request gets a unique `webhook_deliveries.webhook_id = "airtable_nps_<uuid4>"`, so duplicate Make.com fires create duplicate audit rows. Worse: if the receiver returns 5xx after the RPC committed (rare race — RPC succeeded, network error before response), Make.com's default retry-on-5xx fires the same webhook again. The 0018 RPC's idempotency on `csm_standing` (no-op when value unchanged → no extra history row) covers most of the damage, but `nps_standing` gets re-written (idempotent value-write, harmless) and a second `webhook_deliveries` row lands.
- **Why it matters:** harmless today (`webhook_deliveries` is just an audit log; csm_standing dedup means no extra history rows on the common path). But once we start querying `webhook_deliveries` for analytics ("how many NPS updates per week?") the duplicate-write inflation matters. Also, if the RPC ever stops being idempotent on csm_standing (e.g. someone adds a side effect), we'd silently get duplicate auto-derived writes.
- **Next action:** add `airtable_record_id`-based deduplication. Two paths: (a) move `airtable_record_id` from `call_external_id` to a dedicated unique partial index, then `INSERT ... ON CONFLICT (airtable_record_id) WHERE source = 'airtable_nps_webhook' DO NOTHING RETURNING ...` and short-circuit on conflict (like the Fathom handler's `webhook-id` dedup); (b) add a small RPC `record_nps_segment_with_dedup(client_email, segment, airtable_record_id)` that wraps `update_client_from_nps_segment` with a "SELECT 1 FROM webhook_deliveries WHERE call_external_id = ? AND source = ?" guard. Path (a) is cleaner. Defer until duplicate-write counts become visible in queries OR until a real retry incident surfaces.
- **Logged:** 2026-05-02 (M5.4 receiver — known V1 gap, surfaced at draft time per Drake's "no idempotency layer in V1" decision).

## `docs/runbooks/apply_migrations.md` is stale around the Studio + ledger workflow

- **What:** The runbook is written entirely around the Supabase CLI workflow (`supabase init`, `supabase start`, `supabase db push`, `supabase migration up`) plus a "First Apply Log" section anchored in the v1-schema-only era. None of it mentions Studio + manual ledger registration + dual-verification, which has been the canonical migration path since the M2.3a CLI misroute incident (where 0012 / 0013 went to local instead of cloud and were recovered via Studio). Every migration since (0014–0025) has shipped via Studio + manual ledger; new sessions reading the runbook for "how do I apply this migration" get the wrong picture.
- **Why it matters:** CLAUDE.md and `docs/claude-handoff.md` both reference Studio + ledger as the operational norm but the runbook itself is the doc Code is most likely to consult first for migration mechanics. The verification queries in § "Verify After Apply" are also scoped to the v1 schema (16 tables, migrations 0001–0007) — fine as historical reference but they don't mirror today's per-migration dual-verify pattern (schema reality + ledger registration, run together against cloud explicitly).
- **Next action:** ~30-min refresh pass. Add a "Cloud apply via Studio" section as the canonical path. Move the `supabase db push` content under a "Local apply" or "(deferred — CLI broken in our environment)" heading. Replace the v1-only verification queries with a generic dual-verify template that ages well (one schema-reality query + one ledger query), shown with a worked example. Tag the "First Apply Log" entry as historical context.
- **Logged:** 2026-05-01 (M5.3 — surfaced while drafting `0019_status_add_leave.sql`; runbook still describes CLI-only path while every migration since 0012 has shipped via Studio + manual ledger).

## `alerts` vs. `client_health_scores.factors.concerns[]` — two-table redundancy

- **What:** the original V1 schema designed `alerts` as the table for actionable CSM-facing signals (churn risk, upsell, etc.). The M3 concerns generation work landed inside `client_health_scores.factors.concerns[]` jsonb instead — concerns are tied to the health score computation, the dashboard reads them from the same row, and one jsonb write was simpler than coordinating two-table writes. Functionally these overlap: concerns ARE alerts.
- **Why it matters:** low-stakes today (`alerts` is empty; concerns are the only live signal source), but the fork becomes a real annoyance when CSM Co-Pilot needs a single read source for "things CSMs should care about." Two write paths, two read paths, two staleness questions.
- **Next action:** resolve when CSM Co-Pilot writes to the unified surface. Two paths: (a) promote concerns out of jsonb into rows on `alerts` (or a renamed `client_concerns` table) with a back-reference to the originating health-score run, or (b) retire `alerts` and let `client_health_scores.factors` be the single source. Defer until CSM Co-Pilot needs the unified surface.
- **Logged:** 2026-05-01 (M4 EOD — known design seam captured before CSM Co-Pilot work starts).

## Master sheet importer — three carry-overs from M4 Chunk C apply

These three are byproducts of Drake's M4 Chunk C triage decisions on the master sheet importer. None blocks the dashboard's daily use; all want a manual touch when there's spare capacity.

- **(a) 21 auto-created non-churn clients need cross-check against existing-cloud-data-in-other-forms.** The first dry-run surfaced 21 paused/active rows in the master sheet that had no match in cloud (verified 0/20 sampled emails found anywhere — primary, alternate, or by name). Drake amended the spec's auto-create rule to cover non-churn unmatched rows too (was: churn only). All 21 land as new clients with sheet-side data and primary CSM assignments. **Risk:** any of them might already be in cloud under a different identity (e.g. a personal-email variant that's stored under a work-email primary, or a slightly-spelled-different name). When time permits, walk the 21 names and check for existing duplicates that should be merged. List captured in `data/master_sheet/import_report_*.txt` after apply.
- **(b) 4 Aleks-orphaned clients need primary_csm reassigned.** Aleks is no longer at the company per Drake. The importer sees `Aleks` in the Owner (KHO!) column on 4 rows (Colin Hill — churn auto-create; Ming-Shih Wang, Jose Trejo, Alex Crosby — non-churn auto-creates after Drake's amendment) and skips the assignment per spec. These 4 clients will land in cloud with `primary_csm = NULL`. Drake handles reassignment manually via the dashboard's Primary CSM dropdown.
- **(c) Some auto-creates have placeholder emails.** Rows in the master sheet without an email value get `<slug>+import@placeholder.invalid` synthesized so the migration 0001 NOT NULL email constraint holds. From the first dry-run: 6 churned (Jarrett Fortune, Chris Ferrente, Robert Haskell, Lenrico Williams, Charles Biller, roula deraz) plus Andy V (paused, post-amendment). If real emails surface later for any of them, edit via the dashboard's Email field — `placeholder.invalid` TLD is RFC-reserved so no risk of accidentally emailing the address.
- **Why deferred:** Drake's call: getting these 21 + 4 + 7 visible in the dashboard NOW (so the CSM team can onboard against real data tomorrow) outweighs the cleanup tax. Manual review + reassignment is a ~30 min batch when convenient.
- **Logged:** 2026-05-01 (M4 Chunk C apply triage).

## Auth context not threaded through Server Actions — `changed_by` is always null in B2 history rows

- **What:** the four history-writing flows shipped in M4 Chunk B2 (status, journey_stage, csm_standing, nps_submissions.recorded_by) all accept a `p_changed_by` / `p_recorded_by` argument but the dashboard Server Actions pass null. The Supabase auth user is available via `@supabase/ssr` cookies, but there's no `auth.users.id → team_members.id` resolution layer yet, and Server Actions don't currently read the auth cookie. Every history row in B2 records `changed_by = null`.
- **Why it matters:** the audit trail tells you what changed and when, but not who. Acceptable for a single-CSM V1 (Drake is the only editor today). Becomes a problem the moment Lou / Nico / Scott / others edit alongside each other in the dashboard — the timeline goes anonymous.
- **Next action:** wire a small helper (`getCurrentTeamMemberId()` or similar) that reads the Supabase auth cookie in a Server Action context, looks up `team_members` by email, and threads the resolved id through the existing nullable `p_changed_by` argument. Exists as a hook in `app/(authenticated)/clients/[id]/actions.ts` — replace the literal `null` passed today. ~30 min plus testing.
- **Logged:** 2026-05-01 (M4 Chunk B2 — wired the RPCs, didn't wire auth).

## metadata.profile read-modify-write race — concurrent edits clobber each other

- **What:** Section 5 (Profile & Background) writes go through `updateClientProfileFieldAction` → `updateClientProfileField` (lib/db/clients.ts), which performs a read-modify-write on `clients.metadata`: SELECT current metadata, build a new object with the updated `metadata.profile.<path>`, UPDATE the row. If two CSMs save different `metadata.profile.*` fields concurrently, the later UPDATE wins and clobbers the earlier write. Top-level `metadata.alternate_emails` / `alternate_names` / etc. are preserved by spreading the existing object (so the merge_clients RPC's writes won't be clobbered — that flow modifies different keys), but two concurrent profile edits collide.
- **Why it matters:** fine for V1 (single-CSM-at-a-time editing pattern). Becomes a real issue once concurrent CSM editing is normal — you save the niche, your colleague saves the offer, your save wins, their offer disappears.
- **Next action:** when concurrent editing becomes real, migrate `updateClientProfileField` to a Postgres function using `jsonb_set` so the read-modify-write happens server-side under a row lock. Or add an `xmin`-based optimistic-concurrency check at the application layer. ~1 hour plus testing. No urgency in V1.
- **Logged:** 2026-05-01 (M4 Chunk B2 — design call: simpler-now, debt-later).

## NPS-entry has no duplicate-submission protection

- **What:** the Section 2 "Add NPS score" form invokes `insert_nps_submission` which always inserts a fresh row. A CSM who clicks Save twice (network blip, double-tap, browser back-then-forward) creates two `nps_submissions` rows for the same client at near-identical timestamps. (Note: post-M5.4 the dashboard no longer surfaces a "Latest NPS" field — `nps_submissions.score` is invisible in V1; the duplicate sits in the table without a UI consumer. `latest_nps` stays in the data layer for V1.5 score-piping.) Total count of `nps_submissions` becomes inflated.
- **Why it matters:** low-stakes for V1 — duplicate NPS rows are easy to spot in the table and easy to delete via Studio. But "the duplicate count drifts the more clients you have" is a slow-growing data-hygiene tax.
- **Next action:** options when usage scales: (a) optimistic UI lock — disable the Save button between submit and revalidation; (b) server-side dedup — reject inserts where a row exists for `(client_id, score)` within the last 30 seconds; (c) a uniqueness check by (client_id, submitted_at::date) when manual entries dominate. (a) is the cheapest and probably enough.
- **Logged:** 2026-05-01 (M4 Chunk B2 — known design gap, deferred).

## Cron sweep race condition — concurrent manual triggers can hit unique-key collision

- **What:** M1.2.5 (2026-04-27) saw two manual `curl` triggers fire ~1 minute apart while debugging the auth-rename + X-Api-Key issues. Both sweeps ran concurrently against the same Fathom window. The cron's per-meeting `_call_already_in_db` check returned False on a few overlapping external_ids because the FIRST sweep hadn't yet INSERTed those rows when the SECOND sweep checked. Result: 2 of 31 cron rows landed `processing_status='failed'` with `duplicate key value violates unique constraint "calls_source_external_id_key"` — both calls actually present in DB from the winning sweep, but the losing sweep's row in `webhook_deliveries` is a noise artifact.
- **Why it matters:** with daily Vercel Cron cadence, the 1-second window between `_call_already_in_db` and `INSERT INTO calls` is unreachable in normal operation — there's only one cron sweep per day. The race only surfaces during human-driven debugging where two manual triggers overlap. Not data loss, not blocking. Just visible-in-the-logs noise that looks like a real failure on shallow inspection.
- **Next action:** if we ever move off daily cron cadence (hourly, or sub-hour) — OR if a future operator adopts a "trigger before reading status" pattern that overlaps two sweeps — tighten dedup by moving `_call_already_in_db` + `INSERT` into a single transaction with `ON CONFLICT (source, external_id) DO NOTHING RETURNING id` (same pattern as the webhook handler's `webhook_deliveries` dedup). ~10 lines in `_upsert_call_row`. Defer until needed.
- **Logged:** 2026-04-27 (M1.2.5 — flagged but not fixed).

## API integration discovery — verify auth scheme empirically before declaring done

- **What:** F2.1's discovery session (Fathom webhook intel) thoroughly read the OpenAPI spec, payload schemas, signature verification, retry semantics — but missed that Fathom's external API uses `X-Api-Key: <key>` for outbound auth, NOT `Authorization: Bearer <key>`. F2.1 produced an architecture doc and 8 commits' worth of code on the assumption of Bearer auth; M1.2's `api/fathom_backfill.py:_fetch_meetings_window` shipped with `Authorization: Bearer ${api_key}` and 401'd against Fathom on first real run. M1.2.5 caught it via Drake's manual-curl probe (`curl -H "X-Api-Key: ..." https://api.fathom.ai/external/v1/meetings` → 200). One-line code fix; the lost time was the deploy → 401 → diagnose loop.
- **Why it matters:** every future external-API integration (CRM, Calendar, n8n webhook receivers, future agent integrations) has the same risk — read the spec carefully, miss one detail, ship code that 401s on first real call. The OpenAPI / docs are the *intended* shape but providers don't always document the actual deployed auth scheme accurately, especially when the spec says `securitySchemes: bearerAuth` but the provider's implementation accepts something else.
- **Next action:** before declaring any API discovery session "done," **run one real curl against the production API endpoint with the documented auth scheme.** A 200 confirms the auth shape; a 401 surfaces the gap before code ships. Add this as a step to a future `docs/runbooks/api_integration_discovery.md` runbook (analog to `adding_new_ingestion_source.md`) — written when the second integration starts (CSM Co-Pilot V2 may add CRM API integration; that's the trigger).
- **Logged:** 2026-04-27 (M1.2.5 deploy caught the F2.1 gap).

## Fathom webhook registration UI viewport bug — workaround needed every time

- **What:** Fathom's webhook registration UI (Settings → API Access → Add Webhook) has a viewport rendering bug where the verify/save button renders below the fold without a scrollbar. On a default browser zoom + standard laptop display, you can fill the form but not submit it. M1.1 lost ~3 days to this — registration appeared complete but Fathom never sent deliveries because the registration object hadn't been finalized server-side. **Workaround:** zoom browser out (Cmd-/Ctrl-`-`) until the verify button is visible, then submit.
- **Why it matters:** any future webhook re-registration (secret rotation, URL change, scope change) will hit this same bug. The runbook in `docs/runbooks/fathom_webhook.md` § Rotate Secret depends on the UI working — if Drake's already zoomed out it's a non-issue, but a future operator following the runbook cold could lose another few days.
- **Next action:** add a one-line note to `docs/runbooks/fathom_webhook.md` § Register that says "zoom out before submitting if the verify button isn't visible." Also, the cleanest long-term fix is to skip the UI entirely — Fathom's `POST /webhooks` API endpoint works fine (per F2.1 doc read). For the next rotation, register via API instead of UI.
- **Logged:** 2026-04-27 (M1.1 root cause).

## Fathom API key + cron auth secret — need rotation runbook

- **What:** Two cron-related secrets need documented rotation procedures. (1) `FATHOM_API_KEY` (Fathom team-account API key, used by `api/fathom_backfill.py` to read `/meetings`) — Fathom's API doesn't expose a rotate endpoint, only delete + recreate. (2) `CRON_SECRET` (random secret used by Vercel Cron's `Authorization: Bearer ...` header AND validated by every cron handler in this codebase; consolidated to single-var pattern in M6.2). Rotating CRON_SECRET affects all crons simultaneously since it's the single project-level token.
- **Why it matters:** if either is leaked or a team member with access leaves, we need a known-good rotation path. Doing it under pressure without a runbook is error-prone (cron downtime window between Vercel env update and redeploy).
- **Next action:** when adding the secret-rotation section to `docs/runbooks/fathom_webhook.md` (already an open followup for the webhook secret), extend it to cover both new secrets. CRON_SECRET rotation is now well-documented in `docs/runbooks/accountability_notification_cron.md` § "Rotate the secrets" — could simply cross-reference rather than duplicate. ~30 min to draft. Not urgent — defer until first rotation is needed.
- **Logged:** 2026-04-27 (M1.2 build); updated 2026-05-06 (M6.2 consolidated cron-auth env var to CRON_SECRET).

## PostgREST transient empty-body 400 on count queries — pattern observed multiple sessions

- **What:** Over F1.4, F2.3, and F2.4 the supabase-py client has intermittently failed on `.select("id", count="exact", head=True).execute()` with `postgrest.exceptions.APIError: {'message': 'JSON could not be generated', 'code': 400, 'hint': 'Refer to full message for details', 'details': "b''"}`. The pattern: PostgREST returns an empty response body; postgrest-py tries to parse it as an APIError, fails at pydantic validation, re-raises a synthesized 400. Not a bug in our code — the service itself is returning an empty body. Affects only head-count queries; full SELECT queries are unaffected. Retrying the same query moments later usually succeeds.
- **Why it matters:** test verification scripts that rely on head-count queries flake intermittently, producing false-failure signals when the actual handler + pipeline work correctly. F2.4's test script was patched to use direct psycopg2 queries for count verification (see `scripts/test_fathom_webhook_locally.py` `_count()` helper), which side-steps the issue entirely. Not a production-path concern since the Fathom handler doesn't issue head-count queries, but the Ella agent's retrieval path and future admin queries might.
- **Next action:** none today. Watch for the failure pattern in production code after F2.5 deploys — if it ever hits a user-visible path, file upstream with Supabase + postgrest-py. Until then, any ops script that needs a reliable count should use `.select("id", count="exact")` without `head=True` (returns the data array which the client can `len()` safely) or drop to psycopg2 direct.
- **Logged:** 2026-04-24 (F2.4 — consolidating observations from F1.4 and F2.3 into one entry).

## Fathom webhook — delivery semantics live-test (3 of 4 still open, plan-tier resolved)

- **What:** F2.1 identified four unknowns: (1) `webhook-id` stability across retries, (2) retry count + backoff schedule, (3) summary regeneration firing a second `new-meeting-content-ready`, (4) plan-tier gating. F2.5 (2026-04-24) registered the production webhook via Fathom's UI — **plan-tier (#4) is effectively resolved**: no upgrade prompt, no error, registration succeeded. The other three remain open; they can only be observed once a real delivery (and a retry or regeneration) arrives. Architecture in `docs/architecture/fathom_webhook.md` is defensive on all three so none block production operation.
- **Why it matters:** per-retry behavior (#1, #2) sets expectations for our dedup layer and outage tolerance; summary regen (#3) tells us whether `_sync_summary_content` gets exercised organically. None are blockers — each has a defensible default in the handler — but the actual numbers sharpen operational expectations. If #1 turns out to be unstable, we're already protected by the secondary `(source, external_id)` dedup at the `calls` unique constraint. If #2's retry window exceeds our outage tolerance, that's F2.6 cron backfill's problem to solve. If #3 fires, `_sync_summary_content` updates `documents.content` but doesn't re-embed — see Ella's followups.
- **Next action:** no active work. Observe when first real delivery lands. For #2 specifically, force a retry by returning 500 from the handler briefly (temporarily break the signature verify, say) and observe Fathom's retry cadence — but that's a F2.7 nice-to-have, not a pilot blocker. For #3, wait to see if any delivery shows up with `call_external_id` matching an already-processed call.
- **Logged:** 2026-04-24 (F2.1 discovery); partial resolution 2026-04-24 (F2.5 registration proved plan-tier).

## Fathom webhook secret rotation runbook — needed before first rotation

- **What:** Fathom's API exposes `POST /webhooks` (create) and `DELETE /webhooks/{id}` but no `PATCH`/rotate endpoint. Rotating the production webhook secret requires: (1) create a new webhook at the same URL with a fresh secret, (2) the new webhook's secret is returned in the `POST` response body only once, (3) update the `FATHOM_WEBHOOK_SECRET` env var on Vercel and redeploy, (4) delete the old webhook. Between steps 1 and 3 Fathom may be delivering against both — both must verify against whichever secret was valid at send time. Without a runbook, rotation is error-prone: a mistimed step either drops deliveries (old webhook deleted before new secret is live) or leaks PII (new webhook delivered before env var updated means signature-fail 401s, Fathom retries, eventually dead-letters).
- **Why it matters:** webhook secrets should rotate on suspected compromise (accidental commit, team-member offboarding, vendor breach). Today there's no documented procedure so it'll either be "Drake figures it out at 2am under pressure" or "nobody rotates and we carry a stale secret forever."
- **Next action:** spend an hour drafting `docs/runbooks/fathom_webhook_secret_rotation.md` with the exact command sequence, expected durations, and verification steps. Include the fallback: for a brief overlap window, the handler accepts either of two env-var-loaded secrets (`FATHOM_WEBHOOK_SECRET`, `FATHOM_WEBHOOK_SECRET_PREV`) and verifies against both — that eliminates the racing-deliveries problem. Drop the PREV var 5 min after the new one goes live.
- **Logged:** 2026-04-24 (F2.2 architecture work surfaced the gap).

## Auto-created client review workflow — human-owned queue, dashboard merge surface live

- **What:** the Fathom ingestion pipeline auto-creates a minimal `clients` row when a transcript's non-team participant doesn't match any existing client by email (primary or `metadata.alternate_emails`) or by name (primary or `metadata.alternate_names`). Auto-created rows carry `tags=['needs_review']` and `metadata.auto_created_from_call_ingestion=true` + `auto_created_from_call_external_id` + `auto_created_from_call_title` + `auto_create_reason` + `auto_created_at` breadcrumbs (see `ingestion/fathom/pipeline.py:_build_auto_create_metadata`). Their associated `calls` land medium-confidence and their `documents` land `is_active=false` — chunks exist but are invisible to `match_document_chunks` until promoted. Promotion (merging into a canonical row, flipping retrievability, reactivating the document) happens via the Gregory dashboard's "Merge into…" flow on the Clients detail page (M3.2 — atomic via `merge_clients` RPC, migration 0015). **There is no agent reviewing these rows; Drake or a CSM does it by hand via the dashboard.** Live cloud state post-M5 cleanup: a manageable handful of `needs_review` rows; the M5 walkthrough closed 12 merges + 13 detags.
- **Why it matters:** unreviewed `needs_review` rows leave real coaching call context in the KB but invisible to Ella (because `is_active=false` gates the transcript_chunk documents). That's the desired safety behavior for ambiguous matches, but the cost is invisible-until-reviewed content. If auto-create volume climbs (new client roster churn, parser false negatives), the hand-review workflow starts to cost real time. See `docs/followups.md` § "needs_review tag doesn't auto-clear after manual reconciliation" for the related auto-detag automation gap.
- **Next action:** the dashboard merge surface exists. Drain queue when convenient. If hand-review starts feeling heavy, design a grouping / fuzzy-match overlay on top of the existing dashboard that surfaces inferred canonicals (name fuzzy-match, email domain, co-occurrence on same call) and lets a human one-click merge.
- **Logged:** 2026-04-24 (expanded post-F1.4 with actual queue size + in-queue duplicate list; pruned 2026-05-05 after M5 cleanup walkthrough drained most of the queue).

## 9 client-category calls landed with NULL primary_client_id — orphan transcript chunks

- **What:** F1.4 post-ingest verification surfaced 9 `calls` rows with `call_category='client'`, `classification_method='title_pattern'`, confidence 0.60, AND `primary_client_id IS NULL`. Each has a `call_transcript_chunk` document (is_active=false, chunk counts 2–16 each, ~88 chunks total) with `metadata.client_id=null`. Affected titles: `30mins with Scott (The AI Partner) (...)` for Allison Boeshans, Cindy Yu, Connor Malewicz, King Musa, "Musa  Elmaghrabi " (with trailing/double spaces), Owen Nordberg, Shivam Patel (two variants: trailing-space and clean), tina Hussain. Curious because (a) "King Musa" and "Musa  Elmaghrabi " are the pilot Musa — who F1.2 preloaded and who *did* resolve correctly for his other 3 calls; (b) these landed without also triggering an `AutoCreateRequest`, so the auto-create fallback was bypassed in the classifier.
- **Why it matters:** Ella retrieval is safe (all 9 docs are `is_active=false`, so chunks are invisible to `match_document_chunks`), but those ~88 chunks are orphaned — no canonical client row to promote them to, no auto-row to merge into. A pilot client's calls are among them (Musa × 2), meaning Ella can't surface those two coaching calls to Musa's pilot channel until the underlying classifier issue is fixed and the calls are re-ingested. Additionally this is a symptom of a real classifier edge case — the path through `_classify_by_title` where title_pattern matches but the participant identity on the call is malformed enough that neither resolver hit works AND the AutoCreateRequest path is skipped.
- **Next action:** (1) query sample the underlying transcripts to see what the participant field looks like on one of these calls — specifically the "King Musa" call (external_id 134757219) and "Musa  Elmaghrabi " (134393413) vs Musa's resolved call "30mins with Scott (The AI Partner) (King Musa) Mar 19 2026" to understand the classifier branch that's dropping the auto-create; (2) if the fix is straightforward (e.g., strip whitespace before name-lookup, or ensure `_classify_by_title` always emits AutoCreateRequest when no client resolves), patch `ingestion/fathom/classifier.py` and re-run ingestion for just the 9 affected external_ids via `--only-category client` filter (pipeline upsert will re-process); (3) if complex, leave the orphans as-is and document — pilot rollout isn't blocked since the 9 calls are already absent from retrieval.
- **Logged:** 2026-04-24 (from F1.4 post-ingest verification).

## `call_participants` unique on `(call_id, email)` admits NULL-email duplicates

- **What:** F1.1 audit confirmed the only unique constraint on `call_participants` is `(call_id, email)` (btree). Postgres treats `NULL` as distinct in unique indexes by default, so two rows on the same call with `email IS NULL` would not violate. The Fathom pipeline's `_upsert_participants` always calls `pt.email.lower()`, so a `None` email would raise `AttributeError` rather than silently insert — but a parser change or a new ingestion path that inserts `NULL` emails would bypass the constraint without warning.
- **Why it matters:** minor today (TXT parser always produces an email string per participant), but it's a latent footgun for future ingestion paths — webhook-based, CRM-based, or any path where a participant could legitimately lack an email.
- **Next action:** no action today. If/when we add a non-TXT participant ingestion path, either (a) require email on participants in the schema (`NOT NULL`), or (b) change the unique to `(call_id, coalesce(email, ''))` via an expression index. Flag during that future feature's design, not now.
- **Logged:** 2026-04-24.

## PostgREST 1000-row page cap — use `count='exact', head=True`

- **What:** `db.table("x").select("id").execute()` against cloud silently caps at 1000 rows — PostgREST's default page size. `len(resp.data)` in that case is the page size, not the row count. For accurate counts, always use `db.table("x").select("id", count="exact", head=True).execute().count`.
- **Why it matters:** caught once on 2026-04-23 while building the `CLAUDE.md` snapshot — I reported `document_chunks: 1000` and `slack_messages: 1000` when the actual counts were 4,179 and 2,914. A silent undercount that gets into a doc or a Slack status message is worse than an obvious error, because the number looks plausible at a glance.
- **Next action:** no one-time fix; this is a behavioral reminder for anyone writing ops scripts or quick counts. If we end up writing enough count-queries to want a shared helper, add one to `shared/db.py` (something like `row_count(table_name)`) that always uses the `count='exact', head=True` shape. Until then, be explicit at every call site.
- **Logged:** 2026-04-24.

## RLS revisit trigger for Gregory dashboard

- **What:** Row-Level Security policies for the dashboard. Per gregory.md's locked V1 spec, RLS is "off for V1" — meaning V1 ships with RLS *enabled* on every public table but *zero policies*, plus the dashboard's data layer (`lib/db/clients.ts` and the page-entry `team_members` lookup) using the **service role key** to bypass RLS entirely. The auth client (`lib/supabase/server.ts`, anon key + cookies) is used only to verify the user's session in the auth-gate layout. This split was forced into existence mid-M2.3b after the first deploy returned 0 clients despite 134 in cloud — RLS deny-default was the cause; the data-layer-via-service-role pattern was the resolution. V2 needs proper RLS policies on `clients`, `client_team_assignments`, `calls`, `call_action_items`, `client_health_scores`, `nps_submissions` so CSMs see only their assigned clients (joined via `client_team_assignments` where `role='primary_csm'` and `unassigned_at is null`); at that point the dashboard data layer can move back to the anon client (or keep the service-role split where admin operations like merge tooling still need to bypass).
- **Why deferred:** premature for current 2-user model (Drake + Zain admin). App-level auth gate is sufficient at this scale.
- **Revisit trigger:** first non-admin CSM gets dashboard access.
- **Logged:** 2026-04-28; expanded with V1 service-role-split detail and V2 implementation specifics 2026-04-28 during M2.3b housekeeping.

## Supabase CLI default routing is broken in this environment

- **What:** `supabase db diff --linked` and `supabase db push` are silently comparing/pushing to local Docker Supabase rather than the linked cloud project. Verified by (a) the diff suggesting drop of a function that doesn't exist in cloud, and (b) M2.2's apparently-successful migrations 0011/0012/0013 never actually landing in cloud's database OR ledger (caught at the start of M2.3b when type-regen returned schema that didn't match expectations). `npx supabase gen types typescript --project-id <ref>` is similarly affected for write operations but works for reads via the API.
- **Why deferred:** production Python/Vercel services use cloud directly via `SUPABASE_DB_PASSWORD` and the pooler URL (`supabase/.temp/pooler-url`) — completely unaffected. Only CLI-mediated migration workflows are broken, and those have a working workaround (Studio + manual ledger registration; see below).
- **Revisit trigger:** before the team grows beyond Drake (other devs running CLI commands need this fixed). Diagnosis path: inspect `supabase/.temp/` for stale state, possibly re-run `supabase link`, possibly reset the local Docker stack.
- **Logged:** 2026-04-28.

## Studio + manual ledger registration is the temporary canonical migration pattern

- **What:** until the Supabase CLI default routing is fixed (above), all migration applications go through Supabase Studio SQL Editor with manual ledger registration. The pattern: (1) run the `CREATE`/`ALTER` SQL in Studio's SQL Editor (or via psycopg2 against the pooler URL), (2) `insert into supabase_migrations.schema_migrations (version, name, statements) values (...) on conflict (version) do nothing`, (3) dual-verify (see next entry). Slower than `supabase db push` but reliable.
- **Why deferred:** workaround for the CLI routing bug. Works reliably; not blocking.
- **Revisit trigger:** when the CLI routing bug is fixed, this pattern can retire. Worth a one-page update to `docs/runbooks/apply_migrations.md` documenting this as the temporary canonical pattern (already an open followup).
- **Logged:** 2026-04-28.

## Migration application requires dual verification (schema reality AND ledger)

- **What:** M2.2's `supabase db push` reported success but never wrote to cloud's database OR ledger; the failure was silent because the CLI was routing to local Docker Supabase. The class of bug — single-query verification passing against the wrong database — applies to any migration workflow, not just the broken CLI. Process change: every future migration must verify BOTH (a) schema reality against cloud explicitly via `to_regclass('public.<table>')` or `information_schema.columns`/`pg_proc` queried through a connection that's *known* to target cloud (Studio SQL Editor or psycopg2 via the pooler URL), AND (b) ledger registration via `select version from supabase_migrations.schema_migrations where version = '<n>'`. If either returns 0 rows, the migration didn't actually apply — recover before declaring done.
- **Why deferred:** process discipline, no code work. Embedded in the Studio-pattern entry above; called out separately so the lesson survives even if Studio + manual-ledger goes away.
- **Revisit trigger:** every migration. This is a permanent practice, not a one-off.
- **Logged:** 2026-04-28.

## PostgREST stale-cache symptom can mask deeper issues

- **What:** when `npx supabase gen types` returns schema that doesn't match expectations, the first instinct (flush PostgREST cache via `notify pgrst, 'reload schema'` or Studio's "Reload schema cache" button) addresses only one possible cause. Equally likely: the migration didn't actually apply (see CLI routing bug above). M2.3b lost ~30 minutes chasing a "cache lag" that turned out to be three migrations never having landed in cloud. Diagnostic order: (1) verify the schema object actually exists in cloud via `information_schema` / `to_regclass`, (2) verify ledger registration, THEN (3) flush PostgREST if both pass.
- **Why deferred:** process discipline change, no code work.
- **Revisit trigger:** next time `gen types` returns unexpected results.
- **Logged:** 2026-04-28.

## `psql` not available in Drake's WSL — install errored

- **What:** Drake tried `sudo apt install postgresql-client` to get `psql` for ad-hoc queries; the install errored. For now, ad-hoc cloud queries go through Supabase Studio's SQL Editor; any Code-side query needs to use the existing Python connection patterns (`scripts/*.py` via psycopg2 with `SUPABASE_DB_PASSWORD` from `.env.local`).
- **Why deferred:** working around it via Studio is fine for now. Install fix isn't blocking any feature work.
- **Revisit trigger:** when Drake has 10 minutes between sessions to debug the apt errors, OR when a workflow genuinely requires `psql` available in terminal (e.g., a runbook that assumes it).
- **Logged:** 2026-04-28.

## SearchableClientSelect fetch-all-on-mount — fine for V1, watch growth

- **What:** the merge dialog (M3.2) and the upcoming Calls page primary-client-id picker (M3.3) both render a client dropdown by fetching the full eligible-client list server-side on mount and filtering client-side as the user types. ~188 clients today; the round trip is one cheap PostgREST query and the rendered list fits comfortably in a 64-row scroll container. No keystroke-driven DB calls.
- **Why it matters:** the pattern has a soft ceiling. At ~500–800 clients the dialog open will start to feel sluggish (network + client-side initial-render cost); at ~5000+ rows the JS-side filter cost on every keystroke becomes visible. Neither limit is anywhere near today's scale.
- **Revisit triggers:** (a) `select count(*) from clients where archived_at is null` crosses ~800, (b) anyone reports the merge dialog or the Calls primary-client picker feeling slow on dialog open. Resolution path: server-filtered query bound to debounced search input — ~30 lines of refactor, no API change at the consumer level. Until then: the current implementation is correct for V1 scale.
- **Logged:** 2026-04-29 (M3.2 build).

## `merge_clients` transcript-doc query is whole-table filter — fine at current scale

- **What:** the `merge_clients` plpgsql function (migration 0015) reactivates transcript_chunk documents by querying `documents where document_type = 'call_transcript_chunk' and metadata->>'call_id' = any(<source's call ids as text[])`. Mirrors the Python script's "fetch all transcript chunks, filter on metadata.call_id in Python" approach, but server-side via the PostgREST equivalent. There's no index on `documents.metadata->>'call_id'` because that filter has only ever been used by the merge path.
- **Why it matters:** scan cost is proportional to total transcript_chunk doc count. Today: ~3000 documents in cloud, scan is fast. As ingestion grows past ~50k transcript_chunk docs the scan starts to become the merge bottleneck; a partial index `on (metadata->>'call_id') where document_type='call_transcript_chunk'` would fix it cleanly. Not a correctness issue — just a perf one.
- **Revisit triggers:** (a) `select count(*) from documents where document_type='call_transcript_chunk'` crosses ~50k, OR (b) merge dialog spinner ever takes more than ~2s on submit. Resolution: add the partial index in a small migration. Until then: status quo.
- **Logged:** 2026-04-29 (M3.2 build).

## Surface `alternate_names` on Clients detail page

- **What:** Section 1 (Identity) on the Clients detail page renders `full_name` but not `metadata.alternate_names`. After a merge, the absorbed display-name variants live in that field and are invisible to dashboard reviewers without opening Studio. Fix: display as a read-only "Display name variants: Name A, Name B" line below the full_name field. Source data is on the client row itself; no new query needed — the page entry already pulls full `metadata` via `getClientById`.
- **Why it matters:** not blocking, no behavior bug. Both fields are correctly populated by the M3.2 merge RPC. The data is correct; only the dashboard's read-back is missing.
- **Revisit triggers:** (a) next Clients detail page polish pass, (b) a reviewer asks "what merged into this client?" and Studio is the only answer, (c) audit needs surface for understanding why a given client matched a participant by an alt-name.
- **History:** the `alternate_emails` half of this entry was resolved 2026-05-06 — Section 1 now exposes `metadata.alternate_emails` as an editable comma-separated text input (no dedup / no validation by design).
- **Logged:** 2026-04-29 (M3.2 live verification).

## `calls.summary` column is unused — cron path writes to `documents` instead

- **What:** the `calls.summary` text column (migration 0003) is empty for all cloud rows. Fathom cron-ingested summaries land as `documents` rows of `document_type='call_summary'` keyed on `metadata.call_id`. The Calls detail page Section 4 (M3.3) was originally spec'd to read `calls.summary`; it now reads from `documents` instead, matching reality.
- **Why deferred:** no behavior bug. The dashboard renders the right content; the redundancy is just a column that's never written. Two clean fixes exist; neither is urgent.
- **Resolution options:**
  - **(a) Backfill `calls.summary` at ingest time.** When the Fathom pipeline writes a `call_summary` document, also UPDATE the `calls.summary` column with the same content. Reads then have one source. Costs: write amplification, drift risk if the document is regenerated and the column isn't.
  - **(b) Drop `calls.summary` in a small migration.** Acknowledge that summaries are documents, not call attributes. Costs: nothing — no live reader of the column.
- **Revisit triggers:** (a) we add a query that wants `calls.summary` indexed (rare — summaries are read-once-per-detail-view, not bulk-queried), (b) someone is surprised by the empty column during schema review and wants the redundancy resolved. Until then: status quo, dashboard reads from `documents`.
- **Logged:** 2026-04-29 (M3.3 build).

## Vercel deploys hit intermittent transient build/deploy failures that resolve on redeploy

- **What:** the M3.3 push to production failed at the Vercel deploy step despite a clean build (Next.js detected, all routes emitted, build completed in ~1m). The failure pattern: `status ● Error` with an empty Builds tree (`. [0ms]` and no `λ` function entries underneath); no error message in the build log or `vercel inspect`; production alias kept pointing at the previous good deploy. A redeploy of the same commit (no code change) succeeded.
- **Why it matters:** the failure mode is "loud" — the deploy doesn't silently land in a broken state, the alias doesn't flip, no users see the half-deploy. The blast radius is operator time + deploy minute consumption on the redeploy. Not blocking, but worth tracking so it doesn't become invisible noise.
- **Pattern recurrence:** observed at least once during M3.3 (2026-04-29). If it happens again in close succession or starts taking multiple redeploys to land, escalate to investigation.
- **Revisit triggers:** (a) the same failure mode hits twice in a row on the same commit, (b) a deploy lands in a broken state instead of failing visibly (alias flips to a non-functional deployment), (c) it starts happening multiple times per deploy session. Resolution path: check Vercel status page first; then dig into deployment Events via the dashboard UI (CLI doesn't surface those messages); then open a Vercel support ticket if pattern persists.
- **Logged:** 2026-04-29 (M3.3 deploy).

## Gregory brain golden eval harness deferred — same V1 carve-out as Ella

- **What:** M3.4 ships without a formal eval harness. The unit tests cover signal math, scoring rubric, JSON parsing, and end-to-end wiring (37 tests), but there's no golden dataset of "client X should land in tier Y because of reasons Z" that gates rubric changes.
- **Why deferred:** the rubric is iterative — V1.1 is starting points, not locked. Building golden cases against numbers we expect to change wastes effort. Once the rubric stabilizes (~3-6 cron runs in, Drake reviews and tunes), build a 20-case golden dataset that covers the four signal-availability matrix corners (everything-known / cadence-only / action-items-only / nothing-known) plus tier-boundary cases.
- **Revisit triggers:** (a) Drake tunes the rubric in scoring.py and wants regression coverage on the change, (b) a brain run produces a tier that's clearly wrong (a green client who should be red, or vice versa) and we want a fixture to pin that case forever. Aligned with Batch B work.
- **Logged:** 2026-04-29 (M3.4 ship).
