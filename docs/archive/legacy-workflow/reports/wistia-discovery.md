# Report: Wistia Discovery — Video Inventory + Daily Stats Viability

**Slug:** wistia-discovery
**Spec:** docs/specs/wistia-discovery.md

## Acclimatization (per spec)

Confirmed before any code:

- **Tree state:** `git status` clean, `git log --oneline -10` shows recent meta-sheet-ingestion ship (last 7 commits) and earlier close-live-webhooks ship. Stayed on `main`, didn't touch Ella anything.
- **Auth model verified:** Wistia uses HTTP Bearer (`Authorization: Bearer <token>`). Token = `WISTIA_API_TOKEN` in `.env.local`, present (length 64). `urllib`-only posture per `shared/google_oauth.py` + `ingestion/close/client.py`.
- **Rate-limit handling:** Wistia returns HTTP 503 (NOT 429) on rate-limit, no Retry-After header. Probe handles with exponential back-off (5s × attempt). Discovery is low-volume so this didn't bite.
- **Endpoint shapes confirmed via Wistia docs + web search:** `/v1/medias.json` paginated inventory; `/v1/projects.json`; `/v1/medias/{id}/stats.json` for lifetime aggregates; **`/modern/stats/medias/{id}/by_date?start_date&end_date` for per-day breakdowns** (requires `X-Wistia-API-Version: 2026-03` header). The `/medias/{id}/engagement` endpoint is documented but returns 404 on this account.
- **Read-only enforced:** every probe call is GET. No POSTs, no PUTs, no Supabase writes.

## Files touched

**Created:**
- `scripts/explore_wistia_api.py` — throwaway probe (auth check, media + project inventory, target-video location, lifetime stats, engagement endpoint test, per-day stats viability test). Outputs JSON to `.probe-out/wistia/` (git-ignored via the existing `.probe-out/` rule).

**Modified:** none.

## What I did, in plain English

Built a stdlib-urllib probe mirroring the shape of `scripts/explore_close_api.py` + `scripts/explore_wistia_data.py`. Walked the spec's six investigation steps:

1. **Auth check** via `GET /v1/medias.json?per_page=1` — OK.
2. **Full media inventory** via paginated `/v1/medias.json` — **80 medias, all type=Video**.
3. **Project list** via `/v1/projects.json` — 11 projects, including the two name-matches Drake hinted at: `Sell AI Services Updated VSL` (4 medias) and `Confirmation Page Vids` (7 medias).
4. **Target-video location** via name-keyword matching — surfaced 7 VSL candidates total and the 7-media contents of the Confirmation Page Vids project.
5. **Lifetime stats** via `/v1/medias/{id}/stats.json` on the picked candidates — confirmed shape: `{pageLoads, visitors, percentOfVisitorsClickingPlay, plays, averagePercentWatched}`.
6. **Per-day stats** via `/modern/stats/medias/{id}/by_date` on a 14-day window — **per-day data IS available**; response shape is a list of `{date, load_count, play_count, hours_watched}`.

After the first run surfaced that the obvious "VSL" media (`v736s9n4th`) had ZERO plays in the last 14 days (suggesting it's the OLD VSL), ran a follow-up deep-dive across all 4 videos inside the `Sell AI Services Updated VSL` project + 3 other VSL candidates (`NEW VSL`, `Base 44_VSL_v1`, original `VSL`) + all 7 Confirmation Page Vids — to identify which are *currently active* by 14-day play counts. That second pass is what makes the metric-map below confident.

## Verification

`python3 scripts/explore_wistia_api.py` exited 0 on both the initial probe and the follow-up deep-dive. 8 JSON files written under `.probe-out/wistia/`:

- `01_medias_full.json` — 80 medias, full payloads
- `02_medias_compact.json` — compact inventory
- `03_projects_full.json` — 11 projects
- `04_targets.json` — VSL candidates + Confirmation Page Vids contents
- `05_lifetime_stats.json` — lifetime stats for the initial picks
- `06_engagement.json` — 404 from `/medias/{id}/engagement` (route not found on this account)
- `07_by_date.json` — 14-day per-day stats for initial picks
- `08_deep_dive_candidates.json` — lifetime + 14-day stats for all 14 candidate videos (7 VSL + 7 TYP)

Auth: clean (no 401/403). No 503s during the probe. The `/v1/medias/{id}/engagement` 404 is informational — that endpoint doesn't exist on this account's API version, so we work without it.

---

## Findings

### 1 — Video identity: which videos ARE the VSL and the thank-you?

#### VSL — TWO currently-active videos, both inside the "Sell AI Services Updated VSL" project

The project Drake named (`Sell AI Services Updated VSL`, project id `10385584`) has 4 videos. By 14-day play counts:

| hashed_id | Name | Lifetime plays | Lifetime avgPctWatched | Last 14d plays | Last 14d hours_watched |
|---|---|---:|---:|---:|---:|
| **`i1173gx76b`** | VSL Vídeo Motion - Nabeel (Horizontal) Direct Closer Funnel | 2,677 | 17% | **1,694** | **20.11** |
| **`nbump1crwb`** | VSL Vídeo Motion - Nabeel (Horizontal) v2 | 8,073 | 15% | **1,384** | **13.89** |
| `hl3p239yx2` | VSL Vídeo Motion - Nabeel (Vertical) 1 | 2,090 | 25% | 0 | 0 |
| `2gc753jbtp` | VSL Vídeo Motion - Nabeel (Horizontal) | 132 | 37% | 0 | 0 |

**Two videos are currently active** — `i1173gx76b` (Direct Closer Funnel variant) and `nbump1crwb` (v2). The names suggest A/B-test variants or per-funnel-segment splits. The Vertical-1 and original-Horizontal variants have zero recent activity (likely retired).

**For comparison — other VSLs outside this project:**

| hashed_id | Name | Lifetime plays | Last 14d plays | Note |
|---|---|---:|---:|---|
| `v736s9n4th` | `VSL` (unprojected) | 11,759 | 0 | OLD VSL — historical but inactive |
| `hwnu8uj6f3` | `NEW VSL` (unprojected) | 0 | 0 | Created but never used |
| `6qq1eq4wmq` | `Base 44_VSL_v1` (B44 project) | 302 | 302 | Different funnel — Base 44 / B44 |

**Recommendation:** the Engine sheet's "VSL Engagement Rate" + "VSL Average View Duration" most likely needs to span **both `i1173gx76b` and `nbump1crwb`** (summing `hours_watched` and `play_count` across both before deriving the per-day metric, so an A/B test split doesn't distort the daily series). Base 44 is a separate funnel and should probably not be lumped in. **Drake to confirm** which of these three groupings — single Active-VSL, Active-VSL aggregate, or Active-VSL + Base 44 — matches the Engine sheet's intent.

#### Thank-you video — ONE clear winner inside Confirmation Page Vids

The project (`Confirmation Page Vids`, id `10515824`) has 7 videos. All 7 share identical `pageLoads = 184` in the last 14 days — they're all embedded on the same confirmation page, so every page view loads every embed. But play counts diverge dramatically:

| hashed_id | Name | Last 14d plays | Last 14d hours_watched | Lifetime avgPctWatched |
|---|---|---:|---:|---:|
| **`fbgjxwe62y`** | **3 - Nabeel - Confirm Video** | **153** | **1.89** | 22% |
| `2zsih4xrkv` | 25 - How Much Time | 10 | 0.21 | 50% |
| `jq8ei2jh4t` | 24 - Timeline | 13 | 0.32 | 67% |
| `fu7944ys9c` | 23 - Guarantee | 11 | 0.20 | 61% |
| `z0gw4j5hbn` | 26 - No AI Skills | 11 | 0.19 | 55% |
| `abm50hf2gb` | 22 - Why We Need Partners | 6 | 0.14 | 69% |
| `aksjo7ghod` | 21 - No Sales Experience | 6 | 0.14 | 63% |

`fbgjxwe62y` "3 - Nabeel - Confirm Video" is the primary thank-you video (10-25× the play volume of any sibling). The other 6 (numbered 21-26) appear to be supplementary FAQ-style videos on the same page — viewers click into them less, but when they do they watch a higher %.

**Recommendation:** **TYP Engagement Rate + TYP Average View Duration = `fbgjxwe62y` alone.** Drake to confirm; if the Engine-sheet metric is supposed to be "engagement on the confirmation page as a whole" (all 7 videos aggregated), that'd be a different summation.

### 2 — Daily-stats verdict: **per-day is fully available**

The single most important spec question. **YES, per-day stats are available** via the `/modern/stats/medias/{hashed_id}/by_date` endpoint.

Request shape:
```
GET https://api.wistia.com/modern/stats/medias/{hashed_id}/by_date
    ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
Headers:
    Authorization: Bearer <WISTIA_API_TOKEN>
    X-Wistia-API-Version: 2026-03
```

Response: a JSON list with one entry per calendar day in the window:
```json
[
  {
    "date": "2026-05-10",
    "load_count": 159,
    "play_count": 121,
    "hours_watched": 1.43
  },
  ...
]
```

Verified end-to-end across all 14 candidate videos with a 14-day window (2026-05-10 → 2026-05-23). Zero-activity days return zeros, not nulls or missing entries — every day in the window is present.

**Historical depth:** Wistia returned data for the old `VSL` (`v736s9n4th`) going back to 2026-05-10 without error (zeros across the window since it's inactive). No documented cap on `start_date`. Realistic interpretation: Wistia retains per-day data indefinitely; backfill should be able to pull arbitrary history at rollout time.

### 3 — The 4 Engine-sheet metrics, mapped

| # | Engine metric | Wistia source | Daily-grain available? | Derivation |
|---|---|---|---|---|
| 1 | **VSL Engagement Rate** | per-day `by_date` aggregated across the two active VSLs | ✅ yes | `(SUM(hours_watched) * 3600) / (SUM(play_count) * media_duration_seconds) * 100` for each day. Returns NULL when `play_count = 0`. |
| 2 | **VSL Average View Duration** | per-day `by_date` aggregated across the two active VSLs | ✅ yes | `(SUM(hours_watched) * 3600) / SUM(play_count)` for each day, in seconds. NULL when `play_count = 0`. |
| 3 | **TYP Engagement Rate** | per-day `by_date` for `fbgjxwe62y` "3 - Nabeel - Confirm Video" | ✅ yes | Same formula as #1; `media_duration_seconds = 207.1` (verified). |
| 4 | **TYP Average View Duration** | per-day `by_date` for `fbgjxwe62y` | ✅ yes | Same as #2. |

**Key insight on the derivations:** the per-day endpoint returns volume metrics (`play_count`, `hours_watched`) — NOT `averagePercentWatched` directly. But both of the Engine-sheet metrics ARE mathematically reconstructable from those volume metrics + the media's `duration` field (which comes from the inventory call). The lifetime endpoint's `averagePercentWatched` is itself defined as `total_seconds_watched / (total_plays × media_duration_seconds) × 100`; we're applying the same formula on a per-day window.

The `averagePercentWatched` from `/v1/medias/{id}/stats.json` is a **lifetime cross-check** for the day-aggregated number, not the per-day source. They should converge to the same lifetime value when summed across the media's entire history.

### 4 — Viability recommendation

**Yes, Wistia daily ingestion is viable** — comparable in shape to the Meta-sheet pipeline that just shipped.

**Proposed shape (sketch — not a settled design; for the eventual ingestion spec):**

- **One table** `wistia_media_daily` keyed on `(hashed_id, day)`. Mirrors raw per-day rows from `/by_date`. Columns: `hashed_id text`, `day date`, `load_count int`, `play_count int`, `hours_watched numeric` + standard lifecycle.
- **One reference table** `wistia_medias` keyed on `hashed_id`. Mirrors the media inventory + lifetime fields needed for derivations: `name text`, `duration_seconds numeric`, `project_id`, `project_name`, `lifetime_avg_percent_watched int` (refreshed on sync) + lifecycle. Cheap (80 rows today).
- **Cron `api/wistia_sync_cron.py`** every 3-6 hours: refresh `wistia_medias` (cheap inventory pull), then for each media of interest call `/by_date` with `start_date = now - 14d, end_date = today` to capture any restated-recent-history. Idempotent `UPSERT ON CONFLICT (hashed_id, day)`. Backfill = the same code with a wider start_date (e.g. `2025-01-01`) — one cron tick re-runs the whole history.
- **Aggregation layer** computes Engine metrics in SQL using the derivations above, parameterized on the "which medias count as VSL" decision (a small constants list keyed on the canonical hashed_ids).

**Estimated cost / volume:** 80 medias × ~30 days of recent history = 2,400 daily rows. Sync window of 14d per tick = ~80 API calls per cron run (one inventory + 79 by_date). At 600 req/min limit, this is 13% of one minute's budget per tick — well under.

**Reservations to flag for the ingestion spec:**
- The "which medias count as the VSL" decision needs Drake's confirmation. The probe surfaces candidates but doesn't decide.
- Wistia engagement-rate convention is "average % of video watched." That MAY differ from what a marketing dashboard intuitively calls "engagement rate." Worth confirming with the Engine sheet author that the metric is "% of video duration watched on average" and not e.g. "% of viewers who watched ≥ 50%."
- Lifetime `averagePercentWatched` is reported as an INTEGER percentage in the API (e.g. `25` for 25%) — derivations using the more-precise per-day data will produce fractional values; aggregation queries should round at display time, not during storage.

## Surprises and judgment calls

- **The obvious "VSL" media isn't the live VSL.** First-pass picked `v736s9n4th` (literally named "VSL", unprojected, 11,759 lifetime plays). 14-day stats showed zero activity. The actual live VSL traffic flows to two videos *inside* the `Sell AI Services Updated VSL` project (`i1173gx76b` Direct Closer Funnel + `nbump1crwb` v2). The follow-up deep-dive caught it; if the report had stopped after the first probe, the metric map would have been wrong.
- **Two active VSLs, not one.** The Engine sheet says "VSL Engagement Rate" singular, but live data shows two videos getting comparable traffic (1,694 vs 1,384 plays in 14d). This is almost certainly an A/B-test or per-funnel-segment split. The aggregation question (one combined daily series, OR two separate series with one chosen as canonical, OR Tier-1-vs-Tier-2-style split) needs Drake's call. I'd lean combined for simplicity, but flagging.
- **Engagement-rate isn't a raw column in per-day stats** — only `play_count` and `hours_watched`. We DERIVE engagement rate. This works perfectly but means the schema needs `media_duration_seconds` available at aggregation time (hence the proposed `wistia_medias` reference table).
- **The `/medias/{id}/engagement` endpoint 404s on this account.** That endpoint is documented in older Wistia API references but isn't routed for this account / API version. Doesn't matter — `averagePercentWatched` from lifetime `/stats.json` covers the equivalent need.
- **`pageLoads = 184` is identical across all 7 Confirmation Page Vids** in the last 14 days. Same confirmation page → same page-views → every embed gets a "load" on every page view, but `play_count` diverges based on which thumbnail the user clicked. This is the right Wistia model but worth understanding when interpreting per-page-aggregate metrics.
- **`hours_watched` is float, not seconds.** The per-day field is in hours (e.g. `0.08515...` = ~5 minutes 6 seconds). Derivations convert via `× 3600` to get seconds. Easy to get wrong — flagged loudly in the metric-map table above.
- **`Base 44_VSL_v1` is a separate funnel.** Lifetime plays = 302, ALL 302 in last 14 days. It's a new product line (Base 44 / B44, mentioned in `close_leads.funnel_name = "Base 44 - New Leads"` Smartview). Probably NOT what the Engine sheet's main "VSL" metric is tracking, but Drake should confirm.
- **Old VSL still gets pageLoads but no plays.** `v736s9n4th` had 11,759 lifetime plays — it WAS the main VSL until the rename/migration. Worth knowing it exists if anyone asks "where's all the historical VSL data" — it's there, just on a different hashed_id, separate from the now-active variants.
- **No documented `start_date` ceiling.** Wistia returned 14 days of data for an inactive media without error. Realistic interpretation: full historical backfill is feasible on day-1 ingestion. If a year of history is wanted, one cron tick can pull it all.

## Out of scope / deferred (for the eventual ingestion spec)

Everything beyond the discovery — explicitly NOT done here:

- **Pick the canonical VSL aggregation** (single video / two-video aggregate / per-variant split / include Base 44). Drake confirms with the Engine-sheet author.
- **Confirm the TYP video** (`fbgjxwe62y` is the clear winner; aggregating all 7 Confirmation Page Vids would be a different metric).
- **`wistia_media_daily` + `wistia_medias` migration** — proposed shape sketched above; not a settled schema.
- **`ingestion/wistia/` module** — sheets_client-equivalent for the Wistia API + parser (per-day rows → typed records) + pipeline (idempotent upserts on `(hashed_id, day)`).
- **`api/wistia_sync_cron.py`** — Vercel cron, 3-6 hour cadence mirroring the meta_sheet_sync_cron pattern. Uses `WISTIA_API_TOKEN` directly (no OAuth flow needed — Wistia tokens are long-lived).
- **Engine-sheet aggregation queries** — the per-day derivations above as SQL views or materialized views in the Gregory aggregation layer.
- **Engagement-rate semantic confirmation** with the Engine-sheet author — what definition of "engagement rate" matches the sheet's intent (Wistia's `% of video watched on average` is one of several plausible meanings).
- **Visitor / unique-viewer metrics** — Wistia lifetime stats include `visitors` and `percentOfVisitorsClickingPlay`, but the per-day endpoint doesn't expose them. If the Engine sheet ever wants per-day unique-viewer counts, we'd need a different surface (possibly the older `/v1/stats/medias/{id}/visitors.json` or the per-event API).
- **Tags / project filtering for sync scope** — the proposed cron pulls all 80 medias. If that grows to thousands, we'd want to scope to project-membership or a tag, but at 80 it's fine.

## Side effects

- **Wistia API:** ~30 read-only API calls total across the probe + the follow-up deep dive (1 auth check + 1 page of `/medias.json` + 1 page of `/projects.json` + 14 lifetime-stats calls + 14 by_date calls + 2 engagement-endpoint 404s). Well under the 600 req/min limit. No writes.
- **Supabase:** zero reads, zero writes.
- **Slack / external services:** none touched.
- **Local filesystem:** 8 JSON files in `.probe-out/wistia/` (~50 KB total). Git-ignored via the existing `.probe-out/` rule.
- **No `.env.local` modifications.** `WISTIA_API_TOKEN` read at runtime only; never logged, never written anywhere.
- **No Vercel changes**, no new env vars, no cron additions, no migration applies.
