# Report (Pt 2 — Resume): Calendly Ingestion — Migration Apply + 7-Day Backfill

**Slug:** calendly-ingestion
**Spec:** docs/specs/calendly-ingestion.md
**Pt 1 (PARTIAL — intact):** docs/reports/calendly-ingestion.md (gate (a) halt)
**Discovery (the input):** docs/reports/calendly-discovery.md
**Status:** code + data complete. Live webhook activation still Drake-gated (steps in the runbook).

Drake approved past gate (a) with "approved", then "do a for now, we will need to do b after though" — (A) = bulk backfill, (B) = the 6-step webhook activation runbook. This pass does (A).

## Files touched

**Modified:**
- `docs/state.md` — new dated section at the top of "Gregory editorial skin shipped" covering migration 0047 + the 7-day backfill outcome + Engine row previews + the casing-variant finding + activation-still-Drake-gated note.

**Not touched in this pass** (all already committed in Pt 1):
- `supabase/migrations/0047_calendly_ingestion_tables.sql`
- `ingestion/calendly/{__init__,client,parser,pipeline}.py`
- `api/calendly_events.py`
- `scripts/{register_calendly_webhook,backfill_calendly}.py`
- `tests/{ingestion/calendly,api/test_calendly_events}.py`
- `docs/schema/calendly_*.md`, `docs/runbooks/calendly_ingestion.md`
- `vercel.json`, `CLAUDE.md`, `.env.example`

## What I did, in plain English

Three sequential operations post-approval.

**1. Apply migration 0047.** Preconditions verified (Docker WSL off, supabase CLI 2.90.0). Ran `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes`. Output matched canonical shape; exit 0.

**2. Dual-verify per `docs/runbooks/apply_migrations.md`.** Via psycopg2:
- **Schema reality:** `to_regclass` returned non-null for all three tables.
- **Columns:** `calendly_event_types` 10, `calendly_scheduled_events` 18, `calendly_invitees` 21. Matches the migration.
- **Indexes:** event_types 1 (PK), scheduled_events 5 (PK + 4 secondary), invitees 5 (PK + 4 secondary). All expected.
- **Triggers:** `*_set_updated_at` present on all three.
- **Ledger:** `0047 calendly_ingestion_tables` at the top.

**3. Smoke + bulk apply.**

Smoke (`--smoke`): 14 event types synced + 1 event (`Ai Partner Strategy Call`, status=active, host=Aman Ali, booked 2026-05-24) + 1 invitee (`azrarehan2015@gmail.com`, status=active, rescheduled=False) end-to-end. Spot-checked the join: event ⇄ invitee through `event_uri` works. Drake confirmed bulk.

Bulk (`--apply`): 7-day lookback + 60-day future window on `start_time`, all statuses (active + canceled). Outcome:
```
event_types_synced:  14
events_synced:       76
events_failed:       0
invitees_synced:     76
invitees_failed:     0
```

~30s wall time. No 429s; no Cloudflare blocks; no failures.

## Verification

- **Migration apply** — canonical output, exit 0, ledger updated.
- **Dual-verify** — all checks PASS.
- **Smoke** — full inventory + 1 event + 1 invitee, 0 failures.
- **Bulk apply** — 76 events + 76 invitees, 0 failures.
- **Status breakdown:** 51 active / 25 canceled (~33% cancel rate; matches discovery's 26% on a 30-day sample).
- **Reschedule lineage observed:** 6 invitees marked `rescheduled` (all with `new_invitee` URI populated — see Surprises below).
- **Top event names** show real casing drift in production data:

| name | count |
|---|---:|
| `AI Partner Strategy Call` | 33 |
| `Ai Partner Strategy Call` | 16 |
| `AI Partner Strategy Call.` (trailing period) | 7 |
| `Partnership Call w/ Aman` | 13 |
| `Sales Interview` | 7 |

### Engine row previews — running on real data

**Row 34 — Closer Bookings, last 7 days (booking-day EDT):**

| booking_day_edt | closer_bookings |
|---|---:|
| 2026-05-24 | 4 |
| 2026-05-23 | 9 |
| 2026-05-22 | 1 |
| 2026-05-21 | 2 |
| 2026-05-20 | 6 |
| 2026-05-19 | 3 |
| 2026-05-18 | 3 |

**28 total in 7 days.** Filter: `status=active AND rescheduled=false AND LOWER(name)='ai partner strategy call'`.

**Row 35 — Closer Booking Next Day (start_time − event_created_at = 1d in EDT):**

7 days shown: 3 / 4 / 1 / 1 / 3 / 1 / 2 = **15 total**.

**Row 36 — Two Days Out (delta = 2d):**

6 days shown: 4 / 1 / 3 / 1 / 1 = **10 total**.

All three preview queries return sensible non-zero values per day — the per-day variance is real, the EDT date math works.

## Surprises and judgment calls

- **Third casing variant of the closer event-type name: `AI Partner Strategy Call.`** (trailing period). Production data has THREE variants (proper / drifted-case / trailing-period). The current `LOWER(name) = 'ai partner strategy call'` filter catches 49 of 56 (33+16) but misses the 7 trailing-period rows. **Surfaced for the aggregation-layer spec to handle** — two clean options:
  - Expand `CLOSER_EVENT_TYPE_NAMES` to include `"ai partner strategy call."` literally
  - Normalize the matched name: `LOWER(REGEXP_REPLACE(name, '[\\s.]+$', ''))` — strips trailing whitespace + punctuation before comparing
  My lean: the regex-strip approach (defends against future variants like commas, dashes, etc.). Aggregation-layer engineer's call; ingestion stores the raw `name` either way so no ingestion-side change needed.

- **Reschedule lineage shows `rescheduled=true` on the CANCELED side too.** Discovery's reading of the docs said `rescheduled=true` marks the NEW (active) invitee created via reschedule, NOT the canceled OLD one. But the live data shows 5 canceled-status invitees with `rescheduled=true` + `new_invitee` populated. Two possible interpretations:
  - The `rescheduled` flag is sticky across reschedule generations — i.e. an invitee that was created via a reschedule AND was THEN itself canceled (e.g. reschedule chain: A → B → C, where B is `rescheduled=true` AND eventually `status=canceled` when C replaces it).
  - The Calendly field semantic is different than discovery surmised.
  
  Either way, the aggregation-layer "New Scheduled vs Rescheduled" filter needs to be more careful than `WHERE rescheduled=false` alone — it should ALSO filter `status='active'`. Then:
  - "New Scheduled" = `status='active' AND rescheduled=false`
  - "Rescheduled" = `status='active' AND rescheduled=true`
  Currently the Engine row 34/35/36 previews above use both filters, so the numbers are correct. **The schema doc + runbook should be updated to note this.** Flagged here; defer to a doc-hygiene pass with the aggregation-layer spec.

- **`Partnership Call w/ Aman` — 13 events** — third-most-common type after the two strategy-call casing variants. Not currently in `CLOSER_EVENT_TYPE_NAMES`. Aman/team should confirm whether this counts as a closer-call too; the name suggests yes (it's another Aman-led type), but I deferred to the spec's "closer = AI Partner Strategy Call" decision rather than expanding silently. Worth a quick chat with Aman.

- **Bulk was fast (~30s) because volume is small** — 7-day window on a sales-call calendar = ~76 events. Compare to Wistia's 2,480 rows or Close's 5,172 leads (both took minutes). Webhook activation is the meaningful real-time path going forward; backfill is mostly for first-load + recovery.

- **Cancellation timestamps preserved in `cancellation` jsonb** — observed on 25 events. The metric isn't in the Engine sheet's top-6 today, but the raw data is there if a future spec wants "cancellation rate by canceler-type" or "time-to-cancel distribution."

- **`AI Partner Strategy Call.` with trailing period is consistently the 7-count "third variant".** Worth asking the team: is this a copy-paste artifact in the Calendly UI, or is there a separate event-type with the period? If the latter, the `event_type_uri` for those events should differ from the others — could be confirmed in `raw_payload`. Out-of-scope investigation for this report.

- **No webhook activation yet** — Drake-gated 6 steps in the runbook. Until activation, the cron-equivalent recovery path is re-running `scripts/backfill_calendly.py --apply` periodically. The receiver is deployed (via the `vercel.json` change in Pt 1) but every POST will 500 with `misconfigured` until `CALENDLY_WEBHOOK_SECRET` is set in Vercel env.

## Out of scope / deferred

Remaining for Drake to complete production activation:

- **Step 1 — Confirm Vercel deploy** of `api/calendly_events.py`:
  ```bash
  curl https://ai-enablement-sigma.vercel.app/api/calendly_events
  # → {"status":"ok","endpoint":"calendly_events","accepts":"POST"}
  ```
- **Step 2 — Register the subscription:**
  ```bash
  .venv/bin/python scripts/register_calendly_webhook.py \
    --register --url https://ai-enablement-sigma.vercel.app/api/calendly_events
  ```
- **Step 3 — Copy the signing key** from the response (Calendly may only show it once).
- **Step 4 — Add `CALENDLY_WEBHOOK_SECRET=<key>` to Vercel env vars** + redeploy.
- **Step 5 — Verify a real booking flows end-to-end:** create a test booking in Calendly; within seconds:
  ```sql
  SELECT count(*) FROM webhook_deliveries
  WHERE source='calendly_webhook' AND received_at >= now() - interval '5 min';
  -- expect ≥ 1
  ```
- **Step 6 — If signature 401s** on first delivery: inspect `webhook_deliveries.headers.calendly-webhook-signature` (timestamp preserved; v1 redacted) and adjust `_parse_signature_header` / `_verify_signature` in `api/calendly_events.py`. Most likely culprits: separator character (period vs colon vs comma), HMAC input order (timestamp+body vs body+timestamp), encoding (hex vs base64).

Held for separate / future specs:

- **Aggregation-layer SQL views** for the six Engine-sheet metrics. Will need to handle the trailing-period name variant + the `status='active' AND rescheduled=false` filter pair.
- **`Partnership Call w/ Aman` as a potential second closer-type** — Aman to confirm.
- **"Follow Up Meetings" metric definition** (Engine row 95) — Calendly has no native concept; Aman/team picks definition.
- **`no_show` consolidation** — Calendly's native field vs the Engine sheet's other source for No Shows.
- **Schema-doc + runbook update** to clarify reschedule lineage semantics (`rescheduled=true` can appear on canceled rows too; aggregation needs `status='active' AND rescheduled=...`).

## Side effects

- **Migration 0047 applied to cloud Supabase.** Migration count 46 → 47. Three new tables now live with their indexes + triggers.
- **Calendly API:** ~160 read-only calls during bulk (1 /users/me + 1 /event_types page + 2 /scheduled_events pages [active+canceled] + 76 /scheduled_events/{uuid}/invitees per event). Well under the 60-120/min rate limit; no 429s observed.
- **Supabase:** 14 + 76 + 76 = 166 rows written across three tables. Idempotent; safe to re-run.
- **Local filesystem:** no new probe dumps. `.env.local` unchanged.
- **Slack / external services:** none touched.
- **Vercel:** no changes in this pass — code-cutover landed in Pt 1's push. The receiver function exists at `/api/calendly_events` but POST will 500 with `misconfigured` until `CALENDLY_WEBHOOK_SECRET` is in Vercel env (Drake's step 4).
- **No new env vars** added to Vercel — `CALENDLY_API_KEY` + `CALENDLY_WEBHOOK_SECRET` are documented in `.env.example` but adding to Vercel is Drake's gate-(d) work.
- **No new tests** in Pt 2 — coverage shipped in Pt 1 (56 tests, all green; 861 total passing).
