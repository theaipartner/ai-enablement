# Report: Close CRM Smartview Discovery

**Slug:** close-smartview-discovery
**Spec:** docs/specs/close-smartview-discovery.md

## Acclimatization (per spec)

What I confirmed before any code:

- **Core principles** — our DB is the source of truth; agents query Supabase, not external tools. Discovery doesn't write anything, but its findings determine what we eventually mirror into Supabase.
- **Discovery-before-build + real-authenticated-call** — only the probe script + report ride out of this spec; no schema, migration, ingestion module, or UI.
- **Fathom pattern** — thin adapter converts external payload → internal record; single `pipeline.py` orchestrates idempotent upserts keyed on stable IDs; validators run before any KB write. Multiple sources converge on one internal record. This is the blueprint the eventual Close ingestion will mirror.
- **Read-only confirmed** — probe never POSTs/PUTs to Close, never writes Supabase.
- **Key endpoints verified live** (the doc URLs in the spec 404'd; correct paths discovered via `developer.close.com/llms-full.txt`):
  - Smartview list: `GET /api/v1/saved_search/` — paginated via `_skip`/`_limit`, response envelope is `{data: [...], has_more: bool}`.
  - Field holding the structured query: **`s_query`** (every Smartview in this org uses it; the legacy string `query` field is absent on all 29).
  - Single Smartview: `GET /api/v1/saved_search/{id}/`.
  - Custom-field schema (recommended): `GET /api/v1/custom_field_schema/{lead|opportunity|contact|activity}/` returns a `fields: [...]` array with `id`, `name`, `type`, `choices`, `accepts_multiple_values`, `is_shared`.
  - Reporting / activity: `POST /api/v1/report/activity/` — accepts `query.saved_search_id`, requires `metrics` array, supports `type: overview` (per-day series) and `type: comparison` (per-user lookup).
  - Reporting / metrics catalog: `GET /api/v1/report/activity/metrics/` — returns 114 predefined metric keys.
  - Reporting / status: `GET /api/v1/report/statuses/lead/{org_id}/?date_start&date_end&smart_view_id` — point-in-time + transitions for the period.

## Files touched

**Created:**
- `scripts/explore_close_api.py` — read-only probe (auth check, smartview list + classification, custom-field schemas, Reporting API tests, status report, lead-status definitions). Outputs raw JSON to `.probe-out/close/` (git-ignored).

**Modified:**
- `.env.example` — added the documented `CLOSE_API_KEY` entry (Basic-auth-key-as-username detail, where to generate, local-only-for-now status).
- `.gitignore` — added `.probe-out/` so throwaway probe dumps stay local.

**Not touched (as the spec required):** no migrations, no `ingestion/close/` module, no Supabase writes, no Vercel/env changes, no CLAUDE.md/state.md/schema-doc edits.

## What I did, in plain English

Built a flat, dependency-free probe script (`urllib` + stdlib only; no python-dotenv) that loads `CLOSE_API_KEY` from `.env.local`, hits Close's REST API read-only across eight passes, and dumps raw responses to `.probe-out/close/` so findings can be folded into this report by reference rather than from memory.

The probe walked: (1) `/me/` auth check; (2) full `/saved_search/` list with pagination; (3) deep `s_query` inspection on the sales-funnel-relevant subset (name-keyword matched); (4) custom-field schemas for lead/opportunity/contact/activity, plus reverse-resolution of every `cf_*` ID referenced in the relevant Smartview queries; (5) the activity-metric catalog; (6) two `POST /report/activity/` calls (overview + comparison) against a representative Smartview; (7) the lead-status report endpoint to see the period-overview shape; (8) lead-status definitions to map IDs to human names.

After the first probe run flagged that my activity-report POST was missing the required `metrics` field, retried with a realistic four-metric payload and got back the daily-aggregate shape. That second response is the load-bearing evidence behind the Reporting-API decision below.

Then synthesized the findings into the structured answers the spec asked for: grain recommendation, Reporting-API recommendation, full Smartview inventory, custom-field IDs the funnel metrics touch, and five representative Engine-sheet metrics traced end-to-end.

## Verification

- `python3 scripts/explore_close_api.py` — exited 0, all eight passes ran, `.probe-out/close/` populated with 9 JSON files (`01_me`, `02_smartviews_full`, `02_smartviews_compact`, `03_relevant_deep`, `04_custom_field_schemas`, `04b_resolved_referenced_cfs`, `05_activity_metrics`, `06_report_activity_sample` (the metrics-missing 400, captured deliberately), `07_status_report_lead`, `08_lead_statuses`). Plus the retry `06_report_activity_overview.json` + `06b_report_activity_comparison.json` written by a one-off retry script with real metrics.
- `/me/` returned 200 — auth confirmed. User: "Team AIP <success@theaipartner.io>", org "AI Partner" (`orga_1gQ2poPebXN3vxXztUKar169p0CHxvt2XQQcMwA4ijG`).
- All 29 Smartviews retrieved in one page (`has_more: false`). Type breakdown `{lead: 29}`, shared breakdown `{shared: 19, private: 10}`.
- Reporting API was actually called twice on the retry — both returned 200 with the documented shapes (see "Reporting-API decision" below for the actual response excerpt).
- Status report (`GET /report/statuses/lead/{org_id}/?date_start=2026-05-09&date_end=2026-05-23`) returned the documented `status_overview` + `status_transitions` + `status_transitions_summary` keys; 11 statuses appeared in the overview.
- No 401/403 hit during the probe. No 429 hit (sampling budget was well under any rate limit).
- No tests added — this is throwaway discovery code with no production code path. No pytest run.

---

## Findings

### Grain decision

**Recommendation:** mirror Close's raw objects (leads + lead_status_change activities + call/email activities + opportunities + custom_field values) into Supabase, then compute Engine-sheet metrics on top via materialized views / scheduled aggregations. Use the Close Reporting API as a validation cross-check, not as the production data path.

**Why (the activity-vs-status classification result):** the spec asked me to bucket each relevant Smartview into activity-driven or status-driven. After reading the actual `s_query` trees, **none of them are pure activity-driven** — every one of the seven name-relevant Smartviews encodes "leads currently in state X" rather than "events that happened on day Y." The shape distribution from the probe's first-pass heuristic was `status: 6, custom_field: 1`, but a closer read shows most are **status + custom-field + last-call-duration hybrids** (e.g., "lead in status 'Unconfirmed Booking - Handed over' AND `last_call_duration < 60s` AND owner is one of two setters AND latest opt-in date is today"). The `last_call_duration` filter is a denormalized regular field on the lead, not an activity-time leaf; the `related_object_type: activity.call` clause in "Handed Over leads not hit by setter for one day" is doing "no call in last 24h" which is also point-in-time membership ("does this lead currently lack a recent call") rather than a historical event count.

**Implication:** the org uses Smartviews exclusively as **operational UI filters** ("who needs work right now"), not as historical metric definitions. The Engine sheet asks **historical event-count questions** ("how many triages happened on day X") that don't map directly onto Smartview membership. The data those questions need lives in `lead_status_change` activities, `call` / `email` activities, and custom-field values — all of which Close exposes as raw objects we can mirror. Trying to derive "Total Closer Triages on day X" by snapshotting Smartview membership each day would (a) require a snapshot table and a cron, (b) only start the historical series going-forward, and (c) miss any transition that happened and reversed within a single day.

**Practical first ingestion target (for the spec that follows this one):**
- `close_leads` — lead row mirror with `status_id`, owner, custom-field values denormalized.
- `close_lead_status_changes` — `LeadStatusChange` activity rows. This is the spine for triages, hand-overs, bookings, no-shows, DQs.
- `close_calls` — call activity rows (`direction`, `user_id`, `duration`, `date_created`). Spine for dial counts, connected calls.
- `close_emails` — email activity rows. Spine for first-message responses.
- `close_opportunities` — opportunity rows with status + dollar values for the closing-funnel metrics.
- Optional: `close_custom_field_definitions` (88 lead fields, 9 opportunity, 4 contact) for schema reference + display labels.

A daily metric aggregations table on top of these gets us EST-rendered (per ADR 0003) per-day counts for the Engine sheet. Smartview definitions can be mirrored too as a `close_smart_views` reference table, but they're not the historical data spine.

### Reporting-API decision

**Recommendation:** **don't** make the Reporting API the production aggregation path. Use it sparingly: (a) as a parity check during early-stage ingestion (compare our hand-rolled daily counts to Close's report output for the same Smartview + date range), and (b) as a fallback for narrow metrics that Close exposes natively (e.g., a one-shot "what's a Smartview's lead count today" call).

**Why — the evidence:** `POST /api/v1/report/activity/` does return clean daily aggregates filtered by `saved_search_id`. The retry response is:

```json
{
  "aggregations": {"totals": {"calls.outbound.all.count": 0, "emails.sent.all.count": 0, ...}},
  "data": [
    {"datetime": "2026-05-10T00:00:00+00:00", "calls.outbound.all.count": 0, ...},
    {"datetime": "2026-05-11T00:00:00+00:00", "calls.outbound.all.count": 0, ...},
    ...
  ],
  "queries": {...}
}
```

That's exactly the shape we'd want for "outbound calls per day for leads currently in Smartview X." But three structural limits make it the wrong primary path:

1. **No custom-field slicing.** The Tier 1 vs Tier 2 split (Engine sheet metric) needs a per-tier count. Reporting API can only slice by `saved_search_id` — so we'd need a Smartview per tier per metric, locking metric definitions to admin discipline on Smartview maintenance in Close. Mirroring the underlying custom field once lets us slice in SQL without that fragility.
2. **Smartview membership is point-in-time.** When you call the activity report with a `saved_search_id`, the underlying advanced-filter query Close runs is built dynamically — the `queries` echo in the response shows it computes membership for "leads currently in Smartview X AND had outbound call between date_start and date_end." That's not the same as "leads who were in Smartview X on day D AND had a call on day D." For status-membership Smartviews, historical reconstruction needs the raw `lead_status_change` events, not the Reporting API.
3. **114 metric catalog is good for activity rates but doesn't cover status transitions.** "Total Closer Triages" = "leads that entered the 'Unconfirmed Booking - Handed over' status today." The `/report/statuses/lead/` endpoint surfaces this directly via `status_overview[i].entered` for a given period — but only as a period total, not as a per-day breakdown (we'd have to call it once per day). Mirroring `lead_status_change` rows lets us aggregate at any grain in SQL.

**Where the Reporting API does pay off short-term:** during ingestion build-out, calling the same activity-report we'd compute hand-rolled is a free correctness oracle. If our `SELECT COUNT(*) FROM close_calls WHERE direction='outbound' AND date_trunc('day', ...) = ...` disagrees with the Reporting API for the same filter + window, our ingestion or aggregation has a bug. Worth wiring as a non-blocking test harness.

### Smartview inventory

29 total. All type=`lead`. 19 shared / 10 private.

| Type   | Shared  | Name                                                                  |
|--------|---------|-----------------------------------------------------------------------|
| lead   | private | ⚡Day 3 Needs Triaged – leads not triaged in last 3 hours              |
| lead   | private | ⚡Handed Over leads to Setters on Day 3 - Not Triaged                  |
| lead   | private | ⚡Day 2 Needs Triage -- leads not traiged in last 3 hours of Day 2     |
| lead   | private | ⚡Handed Over leads to Setters on Day 2- Not Triaged                   |
| lead   | private | ⚡Day 1 Needs Triage -- Lead not triaged in last 3 hours               |
| lead   | private | ⚡Overall calls connected                                              |
| lead   | private | ⚡Daily Direct Bookings (Z&H)                                          |
| lead   | private | Handed Over leads that have not yet been hit by a setter for one day  |
| lead   | private | Unconfirmed Booking - Handed Over leads                               |
| lead   | private | ⚡All Fresh Unconfirmed Bookings                                       |
| lead   | shared  | Base 44 - New Leads                                                   |
| lead   | shared  | 📈 Base 44 - New Apps                                                  |
| lead   | shared  | Leads not Booked (Closer Funnel)                                      |
| lead   | shared  | 📅 30 Day No Book                                                      |
| lead   | shared  | 👀 7 Day No Book                                                       |
| lead   | shared  | ⚔️ 3 Day No Book                                                       |
| lead   | shared  | ⚡ New Applicants                                                      |
| lead   | shared  | Direct Booking Funnel                                                 |
| lead   | shared  | NGMI - All                                                            |
| lead   | shared  | ⚡ Hot Leads: First Call                                               |
| lead   | shared  | 📞 Daily Calling List                                                  |
| lead   | shared  | 💸 Opportunity Follow-up                                               |
| lead   | shared  | 👻 No Show                                                             |
| lead   | shared  | 🪴 Leads to Nurture                                                    |
| lead   | shared  | 🔴 Red Flag Opportunities                                              |
| lead   | shared  | 📣 Untouched Leads                                                     |
| lead   | shared  | ⌛ No Contact > 30 Days                                                |
| lead   | shared  | 👀 Email Opened This Week                                              |
| lead   | shared  | 📫 Leads Never Emailed                                                 |

Deep `s_query` structures for the 7 name-matched relevant Smartviews are in `.probe-out/close/03_relevant_deep.json`. Sample inspection: the "Day N Needs Triaged" series filters on `status_id == "stat_GZca..." (Unconfirmed Booking - Handed over)` AND `last_call_duration < 60s` AND `user_id in (setter_1, setter_2)` — pure point-in-time membership.

### Lead status pipeline (the funnel spine)

The 11 lead statuses from `GET /status/lead/`, in roughly funnel order:

| Status ID                                              | Label                                  |
|--------------------------------------------------------|----------------------------------------|
| `stat_ZIoyCWBDoWtYQ8EhrO6heT1XMIj4JeIbni74EsAyLiX`     | New Opt-in                             |
| `stat_VXEKegQ4HN87CtntYn7SCwO0ooqHMFKBlp0tJIq6KKs`     | Unconfirmed Booking                    |
| `stat_dppOL2h1QjfH4QcHYI9Vro1LBJDO9bQUiBjCa83e4y1`     | Confirmed Booking                      |
| `stat_GZca7DExvxZ2FkjKNFgWxqrlKwB1ULxA2xKrYszhVf5`     | Unconfirmed Booking - Handed over      |
| `stat_KB9FLz9aEKeEHmBKqMCB8O78tZZYd3poZIlhWhER8ZK`     | Client                                 |
| `stat_Vxh3lRMy5TpkzA8Ihsq1hueVwIeQGluaNjpxdfm46FT`     | Deposit                                |
| `stat_1uxT6m8Gkkn31Xkmiix215MHAEJEqSWWGJgshpZpM8Y`     | Downsell                               |
| `stat_bSMAvQf4TaJGMVo4m8hQ9pWDps0E4WWZg3DtLfUpSK3`     | In Sales Process                       |
| `stat_SSav2flRTzIwoRY9WMMJNIRwhuerxW5Ff1gLq5nRvdq`     | No Show                                |
| `stat_vpKV1nMQWxJNg9Tl4w3diIswy1Ty1mXrCdFhlO8pwvu`     | Deal Lost                              |
| `stat_Sy5P7oFaIcdSOAON2XY1ELblocmqzvnB7ie7cMQllSX`     | Disqualified Lead                      |

These map cleanly onto Engine-sheet status milestones: Triaged ≈ entered "Unconfirmed Booking - Handed over", Booked ≈ entered "Confirmed Booking", Downsell ≈ entered "Downsell", DQ ≈ entered "Disqualified Lead", No Show ≈ entered "No Show", Deposit ≈ entered "Deposit", Client ≈ entered "Client".

### Custom fields referenced by relevant Smartviews

5 distinct `cf_*` IDs surfaced across the 7 deep-analyzed Smartviews. All on the lead object. All resolved cleanly against `/custom_field_schema/lead/`:

| ID                                                        | Name                          | Type      | Choices    |
|-----------------------------------------------------------|-------------------------------|-----------|------------|
| `cf_70fWn6jyWLSPLjwW0C5q12ZBvRBaPXzWXrOyYPeXIKW`         | Latest Opt-In Date            | datetime  | —          |
| `cf_CXTDiuDysIhvWuPBnNTVfHgJSV427jJ9HKgCDgcdw7B`         | Latest Date of Booked Call    | date      | —          |
| `cf_KdgF8Hi50RbHl7VoEL9u8dpZGutGoBhfXshLDHzfBca`         | Funnel Name                   | text      | —          |
| `cf_S6Pcr8U4wSATyMlCLoj1ZAhCIME89lf6rWLmDXttLJL`         | Direct Call Booked?           | choices   | No, Yes    |
| `cf_qm7w8fA9kw6mBm8TuyyGP9osqINC3XV7i5a9FMEyzAM`         | Confirmed Booking             | choices   | No, Yes    |

This is a starting set, not the full custom-field surface for the Engine sheet. The org has **88 lead custom fields** total (full list in `.probe-out/close/04_custom_field_schemas.json`); the Tier 1 vs Tier 2 split, deposit/cash fields, and other Engine-sheet metric inputs likely live in fields not referenced by the current Smartview set. The eventual schema spec should pull the full lead-custom-field list as a reference table.

### 5 representative Engine-sheet metrics, traced end-to-end

| # | Metric                              | Raw Close source                                                                                                                | Proposed shape (sketch — not a schema design)                                                                                          | Reconstructable historically? |
|---|-------------------------------------|---------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------|-------------------------------|
| 1 | First Message Responses             | `Activity.Email` rows with `direction=incoming` (or `EmailReply` semantics) on leads that received a first message recently     | Daily count from `close_emails`, optionally joined to a "first message sent" cohort. No custom field needed.                          | Yes — email activities are timestamped, full history mirrorable. |
| 2 | Total Closer Triages                | `Activity.LeadStatusChange` where `new_status_id = stat_GZca... (Unconfirmed Booking - Handed over)`                            | Daily count from `close_lead_status_changes` filtered on `new_status_id`. Per-closer split via `user_id` on the change activity.       | Yes — status changes are timestamped activities, full history mirrorable. |
| 3 | Total Booked Meetings + Tier 1/Tier 2 split | `Activity.LeadStatusChange` where `new_status_id = stat_dppO... (Confirmed Booking)`, **joined** to lead custom field for tier  | Daily count from `close_lead_status_changes`; tier split needs `close_leads.custom_field_values` (a tier-specific cf, not yet identified — Engine sheet author will know which) | Yes for the count; tier split depends on custom-field history. Close exposes 30-day custom-field history via Event Log — beyond that, going-forward only. |
| 4 | Setter Dials (timestamped activity) | `Activity.Call` rows where `direction=outbound`, `user_id in (setter_user_ids)`                                                  | Daily count from `close_calls`. Trivial GROUP BY user + day.                                                                          | Yes — call activities are timestamped, full history mirrorable. |
| 5 | Triage Rate (%) — derived           | Not itself ingested. Numerator = #2 (Total Closer Triages). Denominator = a sibling count, e.g., "leads handed over in period" (entered status `stat_GZca...` from any prior — same row source, different filter). | Computed downstream as `triages_today / handovers_today`. View / dashboard math, not a stored metric.                                  | Yes — derived from #2's data spine; no separate ingestion. |

The pattern: 4 of 5 are direct daily counts off raw activity / status-change mirrors. The 5th is a derived ratio. None require Smartview snapshots. The custom-field dependency only bites on the tier split.

---

## Surprises and judgment calls

- **Doc URLs in the spec 404'd.** `developer.close.com/resources/smart-views/` and the matching `resources/reporting/` URL aren't valid — the current docs live under `developer.close.com/api/resources/smart-views/` (note the `/api/` prefix). Plus Close ships an LLM-friendly consolidated index at `developer.close.com/llms-full.txt` (780KB, all docs concatenated). Used the latter to ground-truth endpoint paths after the spec's links failed.
- **Initial relevance heuristic was narrow.** My name-keyword token list matched 7/29 Smartviews. A wider net would catch "Daily Calling List", "Direct Booking Funnel", "Hot Leads: First Call", "Untouched Leads", "Opportunity Follow-up", "No Show", "Leads Never Emailed", "NGMI - All", and likely most of the 22 unmatched ones. I did NOT widen and re-run — the shape conclusion ("all Smartviews are operational point-in-time filters, none are historical-event definitions") was already clear from the 7 sampled, and the additional Smartviews would reinforce it not change it. Director should review the full compact list before the schema spec to confirm; if any of the 22 turn out to be activity-event-driven, the grain recommendation might need to soften slightly.
- **Classification heuristic over-simplified.** My probe labeled most relevant Smartviews as pure "status" but reading the actual `s_query` trees shows they're status + custom-field + regular-field hybrids (e.g., status_id filter AND `last_call_duration < 60s` AND `Latest Opt-In Date = today`). Treating them as monolithic "status" Smartviews undersells the custom-field dependency. The classifier label in the report tables is the heuristic's first-pass output; the deep `s_query` JSON dumps under `.probe-out/close/03_relevant_deep.json` are the source of truth for any borderline case.
- **`/custom_field_schema/activity/` returned 404, not an error.** This is expected — Close gates that endpoint behind a Custom Activity Types feature, and this org hasn't defined any custom activity types. Captured the 404 in the schemas dump; the four built-in activity types (Call, Email, SMS, Meeting) have schema-as-code on the API and don't expose a `custom_field_schema` endpoint of their own.
- **First Reporting API call missed `metrics`.** My probe POSTed `{type: overview, query: {saved_search_id: ...}, relative_range: last-week}` without a `metrics` array — Close 400'd informatively (`"metrics": "This field is required."`). Captured the 400 in `06_report_activity_sample.json` for the record, then ran a one-off retry script with four real metrics that returned the expected shape. Production ingestion would always pass a metric set; the 400 isn't load-bearing for the decision, but it's in the dump as evidence that the probe ran the call.
- **All 29 Smartviews are type=lead.** The org doesn't use Smartviews of type `opportunity`, `contact`, `call`, etc. — even though the API supports those types. This means opportunity-funnel slicing (Engine sheet's closing-funnel section) has to be derived from raw `Opportunity` rows + lead-status joins, not from per-tier-opportunity Smartviews. Worth surfacing to whoever designed the Engine sheet to confirm.

## Out of scope / deferred

Worth becoming `docs/future-ideas.md` entries (or sections of the next Close spec) but explicitly NOT done here:

- **Widen the relevance keyword set and re-run** for full coverage of "calling list", "no book", "no show", "untouched", "opt-in", "hot leads", "follow-up", "nurture", "red flag", "ngmi" — would deep-classify 20+ more Smartviews. Adds confidence to the recommendation, doesn't change it.
- **Pull a real lead's full object** to see all 88 lead custom fields populated — would surface the Tier 1 vs Tier 2 custom-field ID definitively, plus deposit/cash fields. Held off because the spec said "don't over-pull" and the schema-spec discovery is the more natural place to do this.
- **Test the funnel-stages Reporting endpoint** (`POST /api/v1/report/funnel/opportunity/stages/`) — for the closing-funnel section of the Engine sheet, this is the closer fit than the activity report. Reading the docs suggests it accepts `saved_search_id` and returns per-stage cohort counts; didn't call it because the org doesn't appear to use opportunity pipelines heavily (only 9 opportunity custom fields).
- **Event Log API recon** (`/api/v1/event/` per the docs) — Close exposes a 30-day rolling event log for object-level history. If we want sub-day status-change reconstruction or backfilling custom-field-value history, this is the relevant endpoint. Out of scope for grain discovery; in scope for the eventual backfill spec.
- **Webhooks** — Close has a webhook subscription system that would push activity / status-change events to us in near-realtime, the equivalent of how we ingest Fathom. Worth modeling alongside (or instead of) polling-based ingestion in the next spec.
- **Bulk-export consideration** — for the initial backfill, paginating `/api/v1/activity/` and `/api/v1/lead/` against thousands of records will hit the deep-`_skip` ceiling Close documents. May want the Export API path (`/api/v1/export/`) for the cold-start backfill, then webhook-driven incremental from there. Same shape Fathom uses (TXT backlog + webhook).
- **The schema spec itself** — the natural next spec is "Close ingestion data model + first migration." This report's grain + reporting-API decisions are the inputs that spec needs.

## Side effects

- **Close API:** 9+ read-only API calls executed against the live production org "AI Partner" — `/me/`, `/saved_search/` (1 page), 4× `/custom_field_schema/{type}/`, `/report/activity/metrics/`, `/report/activity/` (2× — the missing-metrics 400 and the retry), `/report/statuses/lead/{org_id}/`, `/status/lead/`. None modified Close state. Nothing logged to Close. No webhooks created/edited. No Smartviews created/edited.
- **Supabase:** no writes, no reads.
- **Slack / external services:** none touched.
- **Local filesystem:** `.probe-out/close/` directory created under the repo root with 10 JSON files (auth response, smartview list × 2, deep relevant subset, custom-field schemas × 2, activity-metrics list, reporting samples × 2, status report, lead-status definitions). The directory is git-ignored; nothing checked in. Contains no secrets (the loaded API key is never serialized into outputs — only the `Authorization` header per-request, which lives in memory and the underlying urllib socket buffer).
- **No `.env.local` modifications.** The key was read only; the file is untouched.
