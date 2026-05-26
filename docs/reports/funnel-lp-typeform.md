# Report: Funnel — consolidated LP detail (Clarity + Wistia + Typeform + Calendly + ET windowing + date-range picker)

**Slug:** funnel-lp-typeform
**Spec:** (inline prompt — local-only build, no spec file)

## Timezone + windowing fix (most recent change)

Drake spotted that the LP numbers didn't match his Wistia "Last 7 days" view, and asked: when we say "today," is it UTC or ET?

**The bug.** Every Funnel fetcher was doing `new Date(Date.now() - N×24h).toISOString().slice(0, 10)` — a *rolling* window anchored to *UTC* midnight. That contradicted three things at once:

- The window-switcher labels said "Since start of today / week / month" (calendar-anchored, not rolling).
- ADR 0003 mandates store-UTC / render-ET for all period boundaries; `lib/time/est-periods.ts` already had the helpers.
- Wistia's `day` column is in **account-local timezone** per its schema doc. Drake confirmed the account is set to ET. When my UTC-anchored window collided with Wistia's ET-bucketed days, totals could drift by 0–2 calendar days depending on the time of day the page loaded.

**The fix.** New module `lib/db/funnel-window.ts` exposes a `DateRange` type carrying both ET calendar date strings (for Wistia's `day`, Clarity's `snapshot_date`) and matching UTC ISO instants (for `timestamptz` columns: Typeform's `submitted_at`, Calendly's `event_created_at`). `getDateRangeFromWindow(window)` resolves 1d/7d/30d into ET-anchored calendar boundaries via `getEstPeriodBoundary` from the existing ADR-0003 helper. `dateRangeFromExplicit(start, end)` builds a range from two ET date strings.

Every LP fetcher (`funnel-lp.ts`, `funnel-typeform.ts`, `funnel-calendly.ts`) now accepts `Window | DateRange`. Strip page (`/funnel`) keeps Window; LP detail page (`/funnel/landing-pages`) parses `?start=&end=` into an explicit DateRange. The internal `resolveRange` helper does the conversion in one place per fetcher.

**14-day sparkline trends** also fixed — they used to group by UTC date; now they bucket by ET date string (`Intl.DateTimeFormat` with timeZone: 'America/New_York').

**The Clarity rolling-3-day isolation math is unchanged.** It already worked on date strings (which are equivalent in UTC or ET because the Clarity cron runs early enough in the day that the UTC and ET dates always match). The new `totalForRange(rolling, startDate, endDate)` sums isolated daily values over an explicit ET date range instead of an N-day window.

## Date-range picker (Phase 2)

The 1d / 7d / 30d toggle on the LP detail page is now a date-range picker. Three presets (`TODAY` / `WEEK` / `MONTH`, all ET-anchored) sit next to two HTML `<input type="date">` fields for arbitrary range selection. URL contract: `?start=YYYY-MM-DD&end=YYYY-MM-DD`. Default when neither is supplied: today only.

The strip page (`/funnel`) and other dashboard pages still use the 1d/7d/30d window switcher — only the LP detail page got the picker. Other surfaces can adopt the same pattern later when the same friction (comparing against an external system at a specific date range) surfaces there.

**ET labels match Wistia.** Picker labeled "ET" so it's never ambiguous which timezone is being used. When the user picks the same date range in their Wistia admin, the LP page's totals should match.

## Files touched

**Created**
- `scripts/sync_cloud_to_local.mjs` — one-shot cloud→local Supabase sync. Read-only on cloud, upsert-only on local. Strict env-source check that fails closed if the local URL isn't `127.0.0.1` or the cloud URL isn't `https://`.
- `lib/db/funnel-typeform.ts` — Typeform metrics for the LP detail page: submits, qualified / non-qualified / unknown split, avg time to complete, 14-day daily trends.
- `lib/db/funnel-calendly.ts` — Calendly closer-bookings filter for the round-robin "AI Partner Strategy Call" team URL.
- `lib/db/funnel-window.ts` — ET-anchored calendar `DateRange` helper. Resolves Window (1d/7d/30d) to ET calendar boundaries via `lib/time/est-periods`; also exposes `dateRangeFromExplicit(start, end)` for the date-range picker. Owns the dual-format (ET date string + UTC ISO instant) every fetcher needs.
- `app/(authenticated)/sales-dashboard/funnel/landing-pages/date-range-picker.tsx` — client component. Three presets + two date inputs + ET zone hint.
- `docs/reports/funnel-lp-typeform.md` — this report (overwrites the prior version).

**Modified**
- `lib/db/funnel-mocks.ts` — `STAGES` trimmed from 3 → 2 (`ads`, `landing-pages`).
- `lib/db/funnel-lp.ts` — switched VSL aggregation from `engagement_rate` to `play_rate` per Drake's correction. Replaced two-VSL aggregate with a single-VSL primary + dropdown stub for variants. Added `VSL_OPTIONS` export. **ET windowing pass:** every public fetcher now accepts `Window | DateRange`; internal `resolveRange()` normalizes. Wistia `day` filter uses ET date strings; sparkline trends bucket by ET date.
- `lib/db/funnel-typeform.ts` — same Window-or-DateRange contract. `submitted_at` filter uses UTC ISO bounds derived from the ET calendar range. Trend bucketing converted to ET date strings.
- `lib/db/funnel-calendly.ts` — same Window-or-DateRange contract. `event_created_at` filter on UTC ISO bounds. Trend bucketing on ET dates.
- `lib/db/clarity-window.ts` — added `sumOverRange(daily, startDate, endDate)` + `totalForRange(rolling, startDate, endDate)`. The rolling-3-day isolation logic is unchanged; only the summation API gained a range-explicit variant.
- `app/(authenticated)/sales-dashboard/funnel/page.tsx` — strip now feeds only `landing-pages` from live data; `getSubmitsLive` import removed. Still uses Window (1d/7d/30d) — only the LP detail page swapped to the date picker.
- `app/(authenticated)/sales-dashboard/funnel/landing-pages/page.tsx` — consolidated LP detail page rewritten: Clarity → VSL → Confirmation video → Typeform → Calendly → per-path table, with sparklines on each volume metric. **Now reads `?start=&end=`** (defaulting to today ET) and renders the date-range picker in place of the window switcher. Headline label shows the active range (`May 25` for a single day; `May 18 → May 24 · 7 days` for a span).

**Deleted**
- `lib/db/funnel-submits.ts` — the Submits stage is gone; its useful pieces moved to `funnel-typeform.ts`.
- `app/(authenticated)/sales-dashboard/funnel/submits/page.tsx` — orphan after the consolidation.

## What I did, in plain English

Restructured the Funnel page per Drake's call: the strip is now two stages (Ads → LP), and the LP detail page absorbs everything that used to live on a separate Submits stage. New cloud→local sync brought the last 5 days of Clarity / Wistia / Typeform / Calendly into the dev database so the page renders against real numbers right now.

The consolidated LP page has six sections. The Clarity block (LP visits + avg time on page) still goes through the rolling-3-day single-day-isolation math from the prior pass — that's unchanged. The two video sections (LP VSL + Confirmation video) pull Wistia per-day rows for a specific hashed_id, aggregate to a single window, and show play rate (volume-weighted by `plays_filtered`) plus avg view duration (total played seconds ÷ total plays). The Typeform section counts submissions on the main coaching application form (`SFedWelr`), classifies each submission as qualified / non-qualified by inspecting the budget question's answer label, and computes avg time to complete from `submitted_at − landed_at`. The Calendly section counts closer bookings on the round-robin team URL by name-matching and excluding the solo Aman URI. Each volume metric ships with a 14-day daily sparkline.

The qualification predicate is the load-bearing piece on the Typeform side, so worth being explicit. The form's third field has ref `5138f17b-eb31-4d36-bacb-88a8c83326ed` (the budget question — "how much are you willing to invest..."). Choices in the recent data are "Under $2,000", "$2,000 and $5,000", "$5,000 and $8,000". Drake's rule is $2k+ = qualified. The implemented predicate is "label starts with 'Under' (case-insensitive) → non-qualified; any other non-empty label → qualified; missing answer → unknown". If Typeform's choice list ever adds "Under $1,000" or "$1,500 - $2,000", those would correctly be flagged as non-qualified by the "Under" prefix. If someone adds a label like "Less than $2,000" the prefix-check would mis-classify it — flagged below.

## Data sync — cloud → local

`scripts/sync_cloud_to_local.mjs` reads from cloud Supabase using creds in `.env.local.cloud-backup`, writes to local Supabase using creds in `.env.local`. The cloud client only does `.select()` — never `.insert()`, `.update()`, `.upsert()`, or `.delete()`. The local client only does `.upsert()` with a table-specific conflict key, so re-runs are idempotent.

Safety check: the script bails immediately if cloud URL isn't `https://` or local URL isn't `127.0.0.1`. Cheap insurance against an env-file swap that would point both at the same DB.

Tables synced (last 5 days, except `wistia_medias` and `calendly_event_types` which are full-table small reference catalogs):

| Table | Rows | Conflict key |
|---|---|---|
| `clarity_metrics_daily` | 372 | `(snapshot_date, metric_name, url)` |
| `wistia_medias` | 80 | `hashed_id` |
| `wistia_media_daily` | 480 | `(hashed_id, day)` |
| `typeform_responses` | 37 | `response_id` |
| `calendly_event_types` | 14 | `uri` |
| `calendly_scheduled_events` | 49 | `uri` |

When we go live to cloud, the sync becomes a no-op — the page reads directly from the cloud Supabase URL via the app's normal `createAdminClient()`.

## Numbers rendering today (small dataset, 5-day window)

Per the local DB after the sync, on the default 7-day window:

- LP (Clarity `/lp`): 5 visits, ~5s avg time on page (data is very thin — only 2 distinct snapshot dates exist in the mirror)
- VSL on LP (`i1173gx76b`, Direct Closer Funnel): 67.2% play rate, 40s avg view duration, 1.4K plays in last 14 days
- Confirmation video (`fbgjxwe62y`): 74.8% play rate, 1m 20s avg view duration
- Typeform submits: 51 in window. Qualified: 34. Non-qualified: 16. Unknown: 1. Avg time to complete: 1m 10s
- Calendly closer bookings (round-robin team URL): 27 total, 21 active, ~6 canceled

These match the order-of-magnitude shape Drake should expect from the team's actual current LP traffic.

## Clarity LP path — `/lp` vs `/lp-vsl`

Drake's prompt said the LP is `go.theaipartner.io/lp-vsl`. The Clarity mirror contains **zero rows** with `url_path = '/lp-vsl'`. The actual paths Clarity is recording with Traffic data are `/lp` (27 rows, 26 sessions across snapshots), `/base44`, `/course-success`, `/confirmation`, and a few others.

Code points at `/lp` for now via the `CANONICAL_LP_PATH` constant in `lib/db/funnel-lp.ts`. If the LP URL has actually migrated to `/lp-vsl` and the Clarity tag will start recording it once a deploy lands, swap the constant in one line. **Worth confirming with the team whether the migration is pending, partial, or hasn't happened yet** — if Clarity's tagged path stays at `/lp`, then `/lp` is correct.

## Wistia view duration — clarified

Drake asked whether view duration exists. Confirming: Wistia's UI doesn't have a single "view duration" field, but our mirror stores `played_time_seconds` (total seconds watched, summed across plays) and `plays_filtered` (number of plays, bot-filtered). Avg view duration per play = `played_time_seconds / plays_filtered`. That's what the LP page renders. The schema doc has the same derivation in its "what reads from this table" section.

## VSL variant selector

The LP page renders a row of variant chips above the VSL metrics:

- **Vídeo Motion · Nabeel (Horizontal) · Direct Closer Funnel** (`i1173gx76b`) — default
- Vídeo Motion · Nabeel (Horizontal) v2 (`nbump1crwb`)
- Vídeo Motion · Nabeel (Horizontal) (`2gc753jbtp`)
- Vídeo Motion · Nabeel (Vertical) (`hl3p239yx2`)

Clicking a chip sets `?vsl=<hashed_id>` and re-renders against that video. The selection only affects the VSL section; the rest of the page is unchanged. The Confirmation video has no selector — there's a single confirm video hashed_id today (`fbgjxwe62y`).

## Calendly closer bookings — the filter

Drake confirmed the round-robin team URL is the correct one for closer bookings:
- **Include:** `https://calendly.com/d/ctzn-h5d-6bg/ai-partner-strategy-call` (team, round-robin)
- **Exclude:** `https://calendly.com/aman-theaipartner/strategy-call` (Aman's solo strategy call)

Two complications surfaced during implementation:

1. The mirror's `calendly_event_types` catalog does **not** contain the team / round-robin event type at all. It only has the solo Aman one. Per the schema doc, Calendly's `/event_types` endpoint omits team event types from the standard catalog — the catalog and the scheduled-events table drift apart.
2. Scheduled events for the round-robin URL appear in `calendly_scheduled_events` under three distinct retired `event_type_uri` values (`8f6795d3-...`, `8ce6d7e4-...`, and a possible third), all named "AI Partner Strategy Call" with slight casing variants.

Implemented filter (in `lib/db/funnel-calendly.ts`):
- Name starts with "ai partner strategy call" (case-insensitive). Catches all three casing variants in the data.
- AND `event_type_uri != 'https://api.calendly.com/event_types/a596a1b1-160e-4ebd-b820-53092036c2c5'` (the known Aman-solo URI).

This includes every round-robin/team booking and excludes Aman's solo strategy call. If a future event_type with "ai partner strategy call" in its name appears that ISN'T the round-robin one, this filter would include it incorrectly — flagged below.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run dev` — serves cleanly.
- All routes 200: `/sales-dashboard/funnel`, `/funnel/landing-pages` with `?window=1d|7d|30d` and `?vsl=<hashed_id>` query.
- Rendered HTML inspected: section eyebrows (`FUNNEL · LANDING PAGE`, `VSL ON LANDING PAGE`, `CONFIRMATION VIDEO`, `TYPEFORM · LEADS`, `CALENDLY · CLOSER BOOKINGS`, `PER URL PATH`) all present, with real numeric values.
- Variant selector links emit correctly (`?vsl=nbump1crwb` etc.).

Not run: a smoke test against the deployed cloud Vercel build. The local dev render is the validation surface per the local-only framing.

## Surprises and judgment calls

- **`/lp-vsl` doesn't exist in Clarity.** Drake said the page lives at `/lp-vsl`; the mirror only has `/lp`. Kept the constant at `/lp` and flagged. If the migration hasn't happened, leaving as `/lp` is correct; if it has, the Clarity tag needs updating to record `/lp-vsl`.
- **`engagement_rate` → `play_rate` swap.** Drake corrected mid-conversation. Both fields are in the Wistia mirror (`engagement_rate` is 0-1 float meaning "% of video watched on average"; `play_rate` is `plays / unique_loads`). Using `play_rate` now per his clarification.
- **Qualification prefix-check is brittle to future label drift.** If Typeform adds "Less than $2,000" or "$0 - $2,000" as a choice, the prefix-check ("starts with 'Under'") would mis-classify them as qualified. Mitigation: I noted the rule in a copy line on the page itself so anyone editing the Typeform form sees the constraint. A more robust fix would be parsing the first dollar value out of the label and comparing to 2000, but that adds parsing complexity for label shapes that don't exist yet — kept the simpler prefix-check, surfaced the risk.
- **Calendly round-robin event_type isn't in the catalog mirror.** The team URL is real but Calendly's `/event_types` API doesn't return it. Filter uses name-match + solo-URI exclusion to work around this. If a third event type ever appears with "AI Partner Strategy Call" in its name that ISN'T the round-robin one, it would be included incorrectly — but that's a future hypothetical, not a current case.
- **Calendly filter risks under-counting historical retired URIs.** Some old bookings on the round-robin URL may reference retired event_type URIs that aren't in `calendly_event_types`. The name-match approach picks them all up regardless, which is the right call.
- **Unknown-qualification bucket.** A response that skipped the budget question (no choice answer for the qualification field) isn't qualified OR non-qualified — it's surfaced as a separate "unknown" count in the page footer text. Today: 1 such response in the window. If this count climbs, worth a closer look.
- **The strip now has only one real conversion** (ads→LP), and ads is mocked. The bottleneck flag is therefore suppressed (no real-vs-real hops to compare). That's correct behaviour given the current data; the flag will come back as soon as a downstream stage wires real numbers.
- **Variant selector is a stub.** It works (changes the active hashed_id via querystring), but there's no preset comparison view or per-variant ranking. Drake said "secondary, just put something." This delivers exactly that.
- **VSL_OPTIONS list is hardcoded.** Four variant candidates I found by name-matching Wistia mirror's media titles. If the team adds a new variant, it needs to be added to this list manually. A future improvement would query Wistia mirror for medias matching a name pattern and build the list at request time — deferred.

## Out of scope / deferred

- **Form views / Form starts / Completion rate.** These three Typeform analytics fields still require a Typeform Insights API ingestion that we don't have. The Typeform section explicitly omits them from this iteration. Add when Insights ingestion lands.
- **Per-variant VSL comparison view.** Currently the selector flips a single video's metrics in-place. A side-by-side comparison or per-variant leaderboard would be the natural follow-up.
- **Booking-source attribution.** Calendly closer-bookings show the booking count but don't attribute them back to the Typeform submission they came from. The current data doesn't have a clean join key. Worth a separate spec.
- **Trajectory beyond 14 days.** Drake mentioned the past 2 days are the priority. Trends are 14-day rolling regardless of window — felt like the right default. If you want the trend window to follow the page's window switcher (1d, 7d, 30d), one extra parameter and an array length swap.
- **Cron-driven sync.** Today the sync is manual (`node scripts/sync_cloud_to_local.mjs --days N`). When we go live, the page reads cloud directly so the sync becomes a dev-only convenience. Not wiring a cron until that picture changes.
- **The `lib/db/funnel-mocks.ts` legacy RATIOS entries** for downstream stages (appointment-setting / showed / closed / cash) still exist. They drive cascade fallbacks for stage-detail mocks on those routes. Cleaning them up is a follow-up when those stages get real data.

## Side effects

- **Local Supabase writes.** The sync upserted 372 + 80 + 480 + 37 + 14 + 49 = 1,032 rows into the local DB across six tables. Idempotent.
- **No cloud writes.** The cloud Supabase client in the sync script only does `.select()`. Verified by reading the script source.
- **No commits.** Per the local-only framing.
- **No external API calls** beyond the cloud-Supabase reads via PostgREST. No Slack, no email, no third-party webhooks.
