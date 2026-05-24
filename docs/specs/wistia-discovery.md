# Wistia Discovery — Video Inventory + Daily Stats Viability
**Slug:** wistia-discovery
**Status:** in-flight
**Target branch:** main

## ⚠️ Landscape note

A lot shipped on `main` today (Close live webhooks, Meta sheet ingestion — both live in production) and there's a separate Ella worktree on `ella-worktree`. **Stay on `main`.** `git status` + `git log --oneline -10` before starting; re-read current file state, don't assume.

## Why this exists

The Engine sheet's FUNNELS section has **four Wistia-sourced rows**: VSL Engagement Rate, VSL Average View Duration, TYP (thank-you-page) Engagement Rate, TYP Average View Duration. Wistia is the next data source after Close + Meta.

**This is discovery ONLY — no schema, no migration, no ingestion module, no UI, no cron.** Wistia's Data API is strong for *media/project* metadata but the historical *daily stats* surface is uncertain — we don't know whether we can get per-day engagement / view-duration (which the per-day Engine sheet needs) or only lifetime aggregates. That uncertainty is exactly why we probe before building. The output is a throwaway probe script + a findings report. Drake + Director read it and decide viability before any ingestion spec.

Two questions discovery must answer with real data:
1. **Video identity** — confirm which medias are the VSL and the thank-you-page video(s), and capture their stable `hashed_id`s.
2. **Daily-stats viability** — can we get per-day engagement-rate + average-view-duration per video, or only lifetime totals? This decides whether the four sheet rows are buildable as a daily series at all.

## Context from Drake (bake into the investigation)

- **VSL** is the media named (approximately) **"Sell AI Services Updated VSL"**. Confirm exact name + capture hashed_id.
- **Thank-you video** lives in a **"Confirmation Page Vids"** project (Drake's wording suggests a project/folder containing MULTIPLE video types, of which the thank-you video is one — and there may be only one thank-you video right now). So: the TYP metric may map to ONE media inside a multi-media project. Discovery must surface the project's full media list so Drake can point at the right one. Don't assume — list and let Drake confirm.
- Drake is "fairly sure, not 100%" on these names — so the probe's job is to make the actual inventory visible for confirmation, not to trust the names blindly.

## Auth + API context (verify against current docs + the live API)

- **Token:** `WISTIA_API_TOKEN` in `.env.local`. Confirm it exists + is non-empty before anything; **hard stop** if missing/misnamed.
- **Auth:** Bearer — `Authorization: Bearer <token>`. (HTTP Basic with `api` as username + token as password also works, but use Bearer.) Use `urllib`, no SDK dep, matching the codebase posture (`shared/google_oauth.py`, `ingestion/close/client.py`).
- **Base URL:** `https://api.wistia.com/v1`.
- **Rate limit:** 600 req/min per account; Wistia returns **HTTP 503** (NOT 429) on violation, with no Retry-After. Treat 503 as back-off. Discovery is low-volume so this shouldn't bite, but handle it.
- **Key endpoints (confirm current shapes against the live API + https://docs.wistia.com):**
  - `GET /v1/medias.json` — lists all medias: name, hashed_id, project, duration, type, created/updated. Paginates via `page` + `per_page` (max 100). This is the video-identity inventory.
  - `GET /v1/projects.json` — lists projects (to find "Confirmation Page Vids" + its contents).
  - **The stats surface is the load-bearing unknown.** Investigate what's actually available:
    - `GET /v1/medias/<hashed_id>/stats.json` — typically LIFETIME aggregate per media (play count, hours watched, engagement, etc.). Confirm what fields it returns.
    - The Stats API may expose time-bound / per-day data via the `/stats/` endpoints or query params (e.g. date filters, `by=day` style breakdowns). **Find out what daily-granularity options actually exist** — this is the single most important output. Read the Wistia Stats API docs, then test against the live account.
    - Check whether engagement (the % watched / engagement-rate the sheet wants) and average-view-duration are derivable per-day, or only lifetime.

## The investigation

The probe script (`scripts/explore_wistia_api.py`, throwaway, dumps to git-ignored `.probe-out/wistia/`) should, in order:

1. **Auth check** — confirm `WISTIA_API_TOKEN` works via a cheap call (e.g. `GET /v1/medias.json?per_page=1`). Hard stop on 401.
2. **Full media inventory** — list all medias (paginate). Produce a compact table: name, hashed_id, project name, duration, type. This is what Drake confirms the VSL + thank-you video against.
3. **Locate the two target videos** — surface the "Sell AI Services Updated VSL" media and the "Confirmation Page Vids" project's media list. Flag the candidate hashed_ids for each of the four sheet metrics. If a name is ambiguous or missing, say so + show the closest matches.
4. **Stats shape — lifetime** — pull `stats.json` for the VSL and show the real response: which fields exist (play_count, hours_watched, engagement, etc.), and specifically whether "engagement rate" and "average view duration" are present or derivable.
5. **Stats shape — daily (THE key question)** — investigate every avenue for per-day data: date-filtered stats endpoints, `by=day` breakdowns, the account-level stats endpoints, anything that returns a time series. Pull a real sample (e.g. last 14 days if possible) and paste the actual response shape. State definitively: **can we get per-day engagement + avg-view-duration per video, or is it lifetime-only?**
6. **Map the 4 Engine-sheet metrics** — for each (VSL Engagement Rate, VSL Avg View Duration, TYP Engagement Rate, TYP Avg View Duration): name the exact Wistia field/endpoint that produces it, the grain available (daily vs lifetime), and whether it's historically reconstructable or going-forward-only.

## What success looks like

Findings report at `docs/reports/wistia-discovery.md` (six-section structure) that lets Director + Drake decide viability, with real evidence:
- **Video identity confirmed:** VSL hashed_id + thank-you-video hashed_id (+ the Confirmation Page Vids project contents so Drake picks the right TYP media).
- **THE daily-stats verdict:** per-day available (with the endpoint/params that deliver it) OR lifetime-only (so the sheet's per-day rows can't be matched from Wistia and we decide what to do).
- The 4 metrics mapped to real fields + grain.
- A clear recommendation: is a Wistia daily ingestion viable, and if so what's the rough shape (table keyed on (day, hashed_id), daily cron pulling per-day stats)? If daily isn't available, lay out the options (lifetime-only snapshots, or park Wistia like Clarity) for Drake to choose — frame as input to his call, not a settled decision.

Concrete acceptance: auth worked; full media list retrieved; the two target videos located (or closest matches shown); lifetime stats shape pasted; the daily-stats question answered definitively with a real sample or a clear "not available via API."

## Hard stops

- `WISTIA_API_TOKEN` missing/misnamed or unrecoverable 401/403 → stop + report (note: token page is Account-Owner-only in Wistia, so an auth failure may mean Nabeel needs to regenerate/scope it — surface that).
- Repeated 503s (rate limit) → back off, report partial.
- Anything that writes to Wistia (creating/editing medias, projects, tokens) → never. Read-only reconnaissance.
- No Supabase writes, no migrations, no env/Vercel changes. Local token read-only, never echoed into logs/report/commits.

## Think this through — what could go wrong

Names not matching exactly (Drake's only ~80% sure — show the inventory so he confirms). "Confirmation Page Vids" being a project with several videos where the thank-you metric should map to just one (or an aggregate — surface the list, don't guess). Stats being lifetime-only (the likely-painful outcome — if so, say it plainly; a discovery that finds "daily isn't available" is a successful discovery). Engagement "rate" meaning something specific in Wistia's vocabulary that differs from the sheet's intent (note Wistia's actual definition). Going-forward-only data if daily exists but only from today onward (like Clarity's constraint). Surface all honestly.

## Mandatory doc updates

- The report at `docs/reports/wistia-discovery.md`.
- No CLAUDE.md / state.md / schema-doc edits (nothing shipped). Anything that should become a future entry → note in the report's "Out of scope / deferred."
