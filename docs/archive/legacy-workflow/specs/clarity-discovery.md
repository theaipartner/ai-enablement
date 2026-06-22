# Microsoft Clarity Discovery
**Slug:** clarity-discovery
**Status:** in-flight
**Target branch:** main

## ⚠️ Landscape note

Five sources live/building: Close (webhooks), Meta (cron), Wistia (cron), Calendly (webhooks, just activated) all on `main`; Typeform building in parallel on `worktree-b`. **Stay on `main`.** A parallel Builder is on `worktree-b` doing Typeform — don't touch it. `git status` + `git log --oneline -10` first; re-read current file state.

## Why this exists

Microsoft Clarity is the next source. The Engine sheet has TWO Clarity-sourced rows in the FUNNELS section:
- **Landing Page Visits** (row 25)
- **Average Time on Landing Page** (row 26)

PLUS a third metric to investigate: **Average Time on Thank-You Page** (row 37). Row 37 is currently mis-tagged "Wistia" on the sheet but reads like a PAGE metric (time-on-page), not a video metric — which is Clarity's territory, not Wistia's. **Discovery must determine whether Clarity can supply time-on-page for the thank-you-page URL.** If yes, row 37 is a Clarity metric (resolving the earlier mis-tag); if no, it stays a Wistia video-watch-time interpretation.

**This is discovery ONLY — no schema, no migration, no ingestion module, no UI, no cron.** Clarity's API is unusual and constrained (see below), and "landing page"/"thank-you page" mean specific URLs we need to identify from real data. Probe + findings report only. Drake + Director decide viability + URL mapping before any ingestion spec.

## Clarity's API constraints (THE defining characteristic — verify against current docs)

Clarity is a session-recording/heatmap tool with a deliberately narrow Data Export API:
- **Endpoint:** `POST https://www.clarity.ms/export-data/api/v1/project-live-insights` (verify current path). Bearer auth.
- **Only returns the last 1, 2, or 3 days** (`numOfDays` param: 1–3). NO arbitrary historical range. **Data older than 3 days is gone from the API forever.**
- **Max ~10 API requests per project per day.** Hard cap.
- Returns aggregated dashboard metrics (Traffic, Engagement Time, Scroll Depth, etc.) segmented by **dimensions** (Browser, Device, OS, **URL/Page**, etc.) — up to 3 dimensions per request.
- No pagination.

**Implication for the eventual ingestion (note in report, don't build):** you CANNOT backfill history. The ingestion model is forced: a daily cron pulls `numOfDays=1` (or re-pulls the 3-day window for self-healing) and stores each day into our DB, building history going-forward. A multi-day cron outage = a permanent gap. This is the Clarity-specific design constraint.

## Questions discovery must answer with real data

1. **Response shape** — what does `project-live-insights` actually return? What metrics (traffic/visits, engagement time, scroll depth, etc.), and how are they structured? Paste a real trimmed response.
2. **URL/page segmentation** — can we segment metrics by page URL? (Needed because "landing page" + "thank-you page" are specific URLs, not the whole site.) What does the URL dimension look like — full URLs, paths, normalized? List the actual URLs/pages Clarity sees so Drake can identify which is the landing page and which is the thank-you page.
3. **Landing Page Visits** — which metric/field = visits/traffic to a specific page? Confirm it's filterable to one URL.
4. **Average Time on Landing Page** — does Clarity expose an "engagement time" / "time on page" metric per URL? This is the row-26 source.
5. **Average Time on Thank-You Page (row 37 investigation)** — can Clarity give time-on-page for the thank-you-page URL specifically? This determines whether row 37 is a Clarity metric (resolving the Wistia mis-tag) or not. Answer definitively.
6. **Dimension limits** — confirm the 3-dimensions-per-request + 10-requests/day caps, and whether pulling per-URL metrics fits comfortably within them (it should — URL is one dimension).
7. **Going-forward-only confirmation** — confirm the 1–3 day window (no historical backfill) so the ingestion spec is designed correctly.

## Auth + how to probe

- **Token:** `CLARITY_API_KEY` in `.env.local` (Drake confirms present). Bearer auth: `Authorization: Bearer <token>`. Confirm a real call returns 200 before anything; **hard stop** if missing/misnamed/401 (note: Clarity token generation is admin-only — an auth failure may mean the token wasn't generated with the right project/scope; surface that).
- **Project ID:** from the Clarity dashboard URL `clarity.ms/app/<PROJECT_ID>/...`. Builder may need to confirm whether the API needs an explicit project id or infers it from the token. Check.
- `urllib`, no SDK dep (matches the other ingestion clients). Note: Clarity may gate default Python user-agents behind Cloudflare like Calendly did — if a 1010/403 hits, set a normal User-Agent header (the Calendly client `ingestion/calendly/client.py` is the reference for this).
- **Respect the 10-req/day cap during probing** — this is the tightest budget of any source. Plan the probe to use only a handful of calls: ideally ONE call pulling metrics segmented by URL over numOfDays=3, which should reveal shape + the URL list + the time-on-page metric all at once. Don't burn the daily budget on redundant calls.

## The investigation

Probe script `scripts/explore_clarity_api.py` (throwaway, dumps to git-ignored `.probe-out/clarity/`), read-only:
1. **Auth check** — one minimal call confirms the token works. Hard stop on 401.
2. **Pull metrics segmented by URL** (numOfDays=3, dimension=URL/Page) — ideally the single richest call that reveals: available metrics, the URL list, traffic/visits per URL, and engagement-time/time-on-page per URL. Paste the real (trimmed) response.
3. **Identify the pages** — surface the full list of URLs/pages Clarity sees, so Drake can point at the landing page + thank-you page. Flag the candidates if obvious from naming.
4. **Answer the 3 metrics** — Landing Page Visits, Avg Time on Landing Page, Avg Time on Thank-You Page: for each, name the Clarity metric/field + dimension filter, and whether it's available (definitively yes/no on the thank-you-page time question).
5. **Confirm constraints** — the 1–3 day window + 10-req cap, so the ingestion spec is designed for going-forward-only daily snapshots.

## What success looks like

Findings report at `docs/reports/clarity-discovery.md` (six-section structure):
- Real response shape pasted.
- The URL/page list Clarity exposes (so Drake identifies landing + thank-you pages).
- The 3 metrics mapped to Clarity fields + per-URL filterability — with a DEFINITIVE answer on whether time-on-thank-you-page is available (resolving the row-37 Wistia mis-tag question).
- Confirmation of the going-forward-only constraint + the implied ingestion shape (daily self-healing cron, table keyed on (day, page_url), no backfill possible).
- A recommendation framed as input to Director's call, not a settled schema.

Concrete acceptance: auth worked; one URL-segmented call succeeded within the req budget; the page list is shown; the 3 metrics answered; the thank-you-page-time question answered yes/no; the no-backfill constraint confirmed.

## Hard stops

- `CLARITY_API_KEY` missing/misnamed or unrecoverable 401/403 → stop + report (may mean admin needs to regenerate the token with the right project/scope).
- **Approaching the 10-req/day cap** → stop, report what you have. Do NOT burn the budget retrying.
- Cloudflare 1010/403 → add a normal User-Agent header (Calendly client is the reference), retry once.
- Anything that writes to Clarity → never (it's read-only export anyway). No Supabase writes, no migrations, no env/Vercel changes. Local token read-only, never echoed.

## Think this through

The URL dimension might return normalized paths vs full URLs vs query-string-stripped — affects how we identify a specific page (report what it actually is). "Landing page" might be multiple URLs (variants, UTM params) — surface them so Drake decides which count. Time-on-page might be a session-level engagement metric not cleanly attributable to a single page (report Clarity's actual definition — "engagement time" may be whole-session, not per-page; if so, the per-page time metrics may not exist and rows 26/37 need rethinking). The 10-req cap is the tightest of any source — a careless probe could exhaust it and block re-probing for 24h (be frugal). The thank-you-page might not appear in Clarity at all if it's on a different domain/subdomain not tracked by the Clarity install (report whether it's even present). Surface all honestly — a discovery that finds "time-on-page isn't cleanly available" is a successful discovery.

## Mandatory doc updates

- The report at `docs/reports/clarity-discovery.md`.
- No CLAUDE.md / state.md / schema-doc edits (nothing shipped). Anything for a future entry → note in the report's "Out of scope / deferred."
