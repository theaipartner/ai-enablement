# Report: Microsoft Clarity Discovery

**Slug:** clarity-discovery
**Spec:** docs/specs/clarity-discovery.md

Read-only discovery against the Microsoft Clarity Data Export API. **One real call** to `GET /export-data/api/v1/project-live-insights?numOfDays=3&dimension1=URL`. Burned 1 of the 10-req/day cap; 9 remaining. All 7 spec questions answered with real data.

## Files touched

**Created:**
- `scripts/explore_clarity_api.py` — throwaway probe (single-call, ≤1 req/day). Dumps to `.probe-out/clarity/` (gitignored).
- `docs/reports/clarity-discovery.md` — this file.

**Not touched** (nothing shipped):
- No ingestion module, schema, migration, UI, cron, env vars, runbooks, or `state.md` entry. Discovery only.

## What I did, in plain English

Verified the official Microsoft Learn docs first (`learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api`) — current page, last updated 2025-12. Discovered immediately that **the spec said POST but the official endpoint is GET with query params**; the docs' own curl and Python examples both use GET. Probe was written as GET accordingly.

Wrote a single-call probe to maximize information per req-budget. The call `numOfDays=3&dimension1=URL` returns ALL metric blocks Clarity has, segmented per URL, over the 72-hour window — that one response simultaneously serves as auth-check, URL-list discovery, per-URL metric inventory, and definitive answer to the row-37 thank-you-page-time question. No second call needed.

Aggregated the per-URL rows in-process to surface (i) the path-level rollup that aggregation will need to do anyway and (ii) the landing/thank-you-page candidates by name. Path-grouping is critical: Clarity does NOT normalize URLs — query strings are preserved, so 45 raw "URLs" collapse to just 8 distinct paths in 3 days.

## Verification

- **Probe:** `.venv/bin/python scripts/explore_clarity_api.py` → HTTP 200, 9 metric blocks, exit 0.
- **Raw response dump:** `.probe-out/clarity/url-segmented-3d.json` (1 file, kept locally; gitignored).
- **Digest:** `.probe-out/clarity/digest.json` (per-metric URL-field detection + row counts).
- **Budget:** 1 / 10 reqs burned today (2026-05-24). 9 in reserve through 2026-05-25 UTC reset.

## Answers to the 7 spec questions

### Q1 — Response shape

Top-level body is a **JSON array of 9 metric blocks**, each `{metricName: str, information: [row, row, ...]}`. Each row is a metric-specific object with the dimension value(s) merged in (here `Url`). Real shape:

```json
[
  {"metricName": "DeadClickCount",   "information": [/* 18 rows */]},
  {"metricName": "ExcessiveScroll",  "information": [/* 18 rows */]},
  {"metricName": "RageClickCount",   "information": [/* 18 rows */]},
  {"metricName": "QuickbackClick",   "information": [/* 18 rows */]},
  {"metricName": "ScriptErrorCount", "information": [/* 18 rows */]},
  {"metricName": "ErrorClickCount",  "information": [/* 18 rows */]},
  {"metricName": "ScrollDepth",      "information": [/* 18 rows */]},
  {"metricName": "Traffic",          "information": [/* 46 rows */]},
  {"metricName": "EngagementTime",   "information": [/* 18 rows */]}
]
```

Real sample rows (trimmed querystrings for readability):

```json
// Traffic
{"totalSessionCount": "15", "totalBotSessionCount": "0", "distinctUserCount": "18",
 "pagesPerSessionPercentage": 1.0, "Url": "https://go.theaipartner.io/lp?..."}

// EngagementTime
{"totalTime": "85", "activeTime": "17",
 "Url": "https://go.theaipartner.io/base44?..."}

// DeadClickCount (representative of the 6 quality-signal blocks)
{"DeadClickCount": "2", "Url": "https://go.theaipartner.io/lp?..."}
```

**One row in Traffic has `Url: null`** — appears to be the "all URLs" aggregate row. Ingestion should treat null-URL rows as a separate "total" record or drop them.

### Q2 — URL/page segmentation

**Yes — works.** Dimension name is `URL` (passed as `dimension1=URL` in query string); the field on response rows is `Url` (capital U, lowercase rl). **URLs are returned UN-NORMALIZED — full query strings preserved.** This is the most important finding for ingestion.

Real distribution over the 72-hour window (last 3 days):

| Path | Distinct URL+QS variants | Sessions (sum) | Distinct users (sum) |
|---|---:|---:|---:|
| `/lp` | 15 | 15 | 18 |
| `/base44` | 18 | 1 | 18 |
| `/confirmation` | 3 | 2 | 3 |
| `/course-success` | 2 | 1 | 2 |
| `/book-a-call` | 2 | 1 | 2 |
| `/application-completed` | 1 | 1 | 1 |
| `/go-0ef8d` | 2 | 0 | 2 |
| `/conf` | 2 | 0 | 2 |
| `<null>` | 1 | 0 | 2 |

**45 distinct URL strings → 8 distinct paths.** Every variant differs only by `event_id`, `ip`, `fbp`, `fbc`, `utm_*`, etc. Aggregation MUST group by `urlparse(u).path` (or a domain-aware key) — using the raw URL as the dimension produces hundreds of one-pageview groups.

### Q3 — Landing Page Visits (Engine row 25)

**Available.** Source field: `Traffic.totalSessionCount` filtered to the landing-page path. The clear candidate is **`/lp`** (literally "lp" = landing page; carries 15 sessions in 3 days, dominant in traffic). Drake/Aman confirm which path canonically counts as "the landing page" — `/lp` is the strong default; `/base44` may also count depending on funnel definition.

`distinctUserCount` is also available per URL — alternative to sessions if "unique visitors" is the preferred metric.

### Q4 — Average Time on Landing Page (Engine row 26)

**Available.** Source field: `EngagementTime.totalTime` (total time on page in seconds) OR `EngagementTime.activeTime` (interactive time only, excludes idle), filtered to the landing-page path. Both come as strings; cast to int. Real values for `/lp` in the last 3 days:

| Metric | Per-row sum | Rows | Avg per URL+QS row |
|---|---:|---:|---:|
| `totalTime` | 551s | 12 | 45.9s |
| `activeTime` | 79s | 12 | 6.6s |

**Aggregation note:** the avg-per-row above is WRONG for "average time per session" — each row corresponds to one URL+QS variant, not one session. The correct rollup is `sum(totalTime) / sum(Traffic.totalSessionCount)` joined on path. Aggregation-layer engineer's call which of `totalTime` vs `activeTime` matches the Engine-sheet semantic.

### Q5 — Average Time on Thank-You Page (row 37 investigation)

**Definitively YES — available.** `EngagementTime` has per-URL rows for **multiple** thank-you-page-shaped paths over the 3-day window:

| Candidate thank-you path | EngagementTime rows | Total time (s) | Active time (s) |
|---|---:|---:|---:|
| `/confirmation` | 2 | 66 | 63 |
| `/course-success` | 1 | 32 | 21 |
| `/book-a-call` | 1 | 6 | 6 |
| `/application-completed` | 1 | 4 | 0 |

**Row 37 is a Clarity metric, not a Wistia metric.** The earlier "Wistia" tagging on the Engine sheet is incorrect — Clarity can supply time-on-thank-you-page per URL. Drake/Aman pick which specific path canonically counts as "the thank-you page" (likely `/confirmation` for booking → call flow, `/course-success` for course purchase; might be both depending on funnel).

### Q6 — Dimension limits

Confirmed:

- **3 dimensions per request** (`dimension1`, `dimension2`, `dimension3` as separate query params — NOT a `dimensions[]` array as the spec hypothesized).
- **10 reqs/project/day** hard cap (HTTP 429 "Exceeded daily limit" when exceeded — per docs; not hit during this probe).
- **1000 rows per response** (we got 174 total rows across 9 blocks, comfortably under).

Pulling per-URL metrics fits in one dimension; budget is healthy.

### Q7 — Going-forward-only confirmation

Confirmed by both docs and behavior. `numOfDays` ∈ {1, 2, 3} only — anything > 3 returns the latest 3 days. **No historical backfill is possible at all.** History older than 72 hours that wasn't captured by our cron is gone from the API forever.

**Implication for the ingestion spec (not built here — note for Director):**

- Daily cron pulling `numOfDays=3` (always; for self-healing). Stores each day-snapshot into `clarity_metrics_daily` keyed on `(snapshot_date, metric_name, url, dimension_hash)`.
- 3-day re-pull window means a 1- or 2-day cron outage self-heals automatically. A > 3-day outage = permanent gap.
- One source row per (snapshot_date, url) per metric, ON CONFLICT DO UPDATE so re-pulls overwrite cleanly with the latest-known value (Clarity may refine historical aggregates).
- Aggregation by URL path happens at query time, not ingest time — store raw `Url` so we can re-aggregate if the path-normalization rule changes.

## Surprises and judgment calls

- **HTTP method is GET, not POST** (spec said POST). Verified against the official Microsoft Learn page (`learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api`, last-updated 2025-12) and confirmed by our successful 200 call. Both the official curl example and Python example use GET. Probe and any future ingestion module should use GET. **Update the spec / runbook accordingly when ingestion lands.**
- **URLs are NOT normalized — full query strings preserved.** 45 distinct URL strings collapse to 8 paths. Hardcoded in the dimension. Aggregation MUST strip querystrings (`urlparse(u).path`). The ingestion table should store the raw URL AND a derived `url_path` column for query convenience, both populated by ingestion.
- **`Url` field name capitalization is `Url`** (not `URL` or `url`). Trivial but worth noting because the dimension name in the request is `URL` (all caps) — request vs response casing differs.
- **Docs are slightly stale** — sample response in docs shows `distantUserCount` (typo for distinct) and `PagesPerSessionPercentage` (camelCase). Real response uses `distinctUserCount` and `pagesPerSessionPercentage` (lowercased first letter). If you're using docs to generate types, hit the real API once first.
- **Clarity sees only `go.theaipartner.io`** — no `theaipartner.io` proper or other subdomains in the 8-path list. Confirms that the Clarity install is on the `go.` funnel subdomain only. If the thank-you-page Aman cares about is on a different domain (e.g., a Kajabi course-completion page off-domain), it WON'T appear in Clarity. Drake confirms the thank-you-page lives on `go.theaipartner.io`.
- **EngagementTime has both `totalTime` and `activeTime`** in seconds per URL row. Drake/aggregation-layer engineer picks which matches the Engine sheet's intent. `totalTime` includes idle browser-tab time; `activeTime` is only when the user is interacting (clicks, scrolls, etc). For "average time on landing page" as a funnel-engagement metric, `activeTime` is usually the better signal. For "did the visitor sit on the thank-you page for 8 seconds (confirming arrival)", `totalTime` is fine.
- **6 metric blocks beyond the 3 Engine-sheet rows** — `DeadClickCount`, `ExcessiveScroll`, `RageClickCount`, `QuickbackClick`, `ScriptErrorCount`, `ErrorClickCount`. All free (single API call returns them anyway). **Recommendation: mirror everything raw**; aggregation reads the columns it needs. Future spec might surface RageClickCount as a UX-quality alarm.
- **`Url: null` row in Traffic** — one row has no URL; appears to be the "all sessions across all URLs" aggregate row. Ingestion should either drop null-URL rows or store them as a separate "total" record per snapshot_date.
- **`/base44`'s session count is 1 but distinct user count is 18** — anomalous. Likely heavy bot traffic on that path; `totalBotSessionCount` in the raw data may explain. Worth Drake checking what `/base44` is — could be a product/route name (the `base44` startup?) embedded in the funnel. Not a Clarity problem, just data observed.
- **`/conf` (short) appears 2× with 0 sessions, 2 distinct users.** Two paths look like they could be confirmation pages: `/conf` vs `/confirmation`. Drake confirms whether these are the same canonical thank-you page or separate funnels.

## Out of scope / deferred

- **Ingestion module (`ingestion/clarity/*`), schema (`clarity_metrics_daily` table + migration), runbook, cron entry, env-var addition to Vercel, `state.md` update.** Nothing shipped. All ingestion design decisions belong to a follow-up `clarity-ingestion` spec Director writes after Drake reviews this report.
- **Decision: which path = THE landing page?** `/lp` is the strong default but Drake/Aman confirm.
- **Decision: which path(s) = THE thank-you page(s) for row 37?** `/confirmation` is the strong default for the booking→call funnel; `/course-success` likely for course purchase. Aman picks; both can be mirrored.
- **Decision: `totalTime` vs `activeTime`** for the "Average Time on Landing/Thank-You Page" metric. Aggregation-layer engineer picks based on Engine-sheet semantic.
- **`pagesPerSessionPercentage` field** — present in Traffic block, unclear semantic from name alone (is it pages/session as a percentage of what?). Not currently on any Engine-sheet row; defer until needed.
- **Engine-sheet correction:** row 37 should be re-tagged from "Wistia" to "Clarity" once this finding propagates to the sheet. Out of scope for Builder; flag for Drake.
- **Multi-dimension probe** — if a future need wants per-URL × per-Browser or per-URL × per-Country breakdowns (e.g., "time on landing page from US Chrome users only"), we have 2 unused dimensions. Cheap to add; defer until needed.
- **The 6 quality-signal metric blocks** (Dead/Rage/Quickback/etc.) aren't on the Engine sheet today. Worth a single-line followup in `docs/future-ideas.md` if Drake wants — they're free data that could surface UX-quality alarms.
- **`Url: null` aggregate row in Traffic** — decide ingestion treatment (drop vs. store as total). Defer to the ingestion spec.

## Side effects

- **1 API call** to the Clarity Data Export endpoint (out of 10/day). No retries; no follow-ups. 9 remaining for re-probes through the 2026-05-25 UTC reset.
- **No DB writes** (Supabase untouched).
- **No Vercel / env / secrets changes.**
- **No external messages** (Slack, email, etc.).
- **Local filesystem:** `.probe-out/clarity/url-segmented-3d.json` (~50KB) and `.probe-out/clarity/digest.json` (~10KB) written. Both under the gitignored `.probe-out/` tree.
- **Token handling:** read from `.env.local` only, never logged, never written to any file in the diff. The 700-char JWT was loaded into memory, used for one Authorization header, discarded.
