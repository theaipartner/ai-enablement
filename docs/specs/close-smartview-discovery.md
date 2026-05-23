# Close CRM Smartview Discovery
**Slug:** close-smartview-discovery
**Status:** in-flight

## Why this exists

This is the first step of the next major arc: a CEO/business-engine dashboard surface inside Gregory (creator/admin-gated, sibling to `/cost-hub`). The data spine is **Close CRM**, ingested via its Smartviews + REST API. The eventual goal is to mirror Close's sales-funnel data into Supabase and render it on a new Gregory surface, modeled on a daily-tracker artifact ("Overall Engine" sheet) that itemizes ~30 Close-sourced metrics across the appointment-setting and closing funnel (first-message responses, triages, dials, hand-downs/offs, DQs, downsells, booked meetings by tier, etc.).

**This spec builds none of that.** This is a pure discovery pass — "discovery before build" per CLAUDE.md § Working Norms § Operational patterns. We do not yet know the *shape* of what Close returns, and that shape determines the entire downstream schema + ingestion design. Writing a schema or ingestion module before this investigation is the mistake this spec exists to prevent. **No migrations, no schema, no ingestion module, no UI in this spec.** The only artifacts are a throwaway probe script and a findings report.

Drake will read the findings report with Director and make two decisions off it (storage grain; whether Close's native Reporting API replaces hand-rolled aggregation) before any schema spec is written. So the report's job is to give Director + Drake enough real evidence to make those calls — not to propose the answer.

## Context Builder needs

**Auth.** Close uses HTTP Basic auth where the API key is the *username* and the password is *empty* (note the trailing colon: the request sends `<api_key>:` base64-encoded). The key is in `.env.local` as `CLOSE_API_KEY`. Confirm that exact var name exists in `.env.local` before anything else; if it's absent or named differently, **hard stop** and report (do not guess at alternate names, do not proceed). The official Python library `closeio-api` handles the Basic-auth detail for you; a plain `requests`/`httpx` call works too if you set the auth tuple to `(api_key, '')`. A 401 during discovery is almost always the trailing-colon / empty-password detail — check that first.

**Base URL + key endpoints (verify against the live API + current docs as you go; don't trust these as gospel — confirming them is part of discovery):**
- `GET /api/v1/me/` — cheapest auth check; returns the authed user + org. Use this as the very first real call to confirm the key works before doing anything else.
- Smartviews are the `saved_search` object (a.k.a. "Smart Views" in the UI). They are saved search queries with the filter logic stored in a query/`s_query` structure on the object. There is a list endpoint that returns all of them. **Finding and confirming the exact current endpoint path + the field name holding the query structure is part of the task** — read https://developer.close.com/resources/smart-views/ and the API reference, then verify against a real call.
- Lead objects, Activity objects (calls, emails, etc.), and Opportunity objects are the underlying data the Smartviews filter over. The Advanced Filtering / search endpoint (`POST /api/v1/data/search/`) runs queries and by default returns only matched IDs unless you pass a `_fields` object.
- **Close has a native Reporting API** (https://developer.close.com/resources/reporting/) that accepts a `saved_search_id` (Smartview ID) plus an optional date range and returns aggregated metrics (status overviews, etc.) as JSON or CSV. This is potentially load-bearing — see Investigation question 3.
- OpenAPI spec is published at `https://api.close.com/api/openapi.json` if you want ground truth on schemas.
- List endpoints paginate via `_skip`/`_limit` or cursors; rate limits return 429 — back off if you hit them. You should not need bulk pulls for discovery; sample sizes are small (see below).

**Repo placement.** This is throwaway investigation code. Put the probe script at `scripts/explore_close_api.py`. Do **NOT** create an `ingestion/close/` module — we don't yet know the shape that module should take, and seeding a structure now pre-commits a design. The eventual ingestion home will mirror `ingestion/fathom/` once the schema spec lands, but that's a later spec's call.

**Don't over-pull.** This is reconnaissance, not a backfill. Sampling budget: list all Smartviews (one call, cheap), and for the deep-dive sample pull at most ~20 leads / ~20 activities / a single small Reporting API call. Keep total API calls modest; respect 429s. Do not page through the entire org's data.

## Acclimatization checklist

Read these first and confirm understanding in 4-5 bullets before writing any code:

1. `CLAUDE.md` § Core Principles (esp. #1 "our database is the source of truth" and #2 "agents query our DB, not external tools") — this is *why* we mirror Close rather than query it live later. Discovery doesn't write to the DB, but the principle frames what the findings need to enable.
2. `CLAUDE.md` § Working Norms § Operational patterns — "Discovery before build" and the real-authenticated-call requirement.
3. `ingestion/fathom/` — skim the module layout (pipeline, client/adapter split, how it persists). This is the pattern the *eventual* Close ingestion will mirror. You are NOT building it now; you're reading it so the findings report can speak to how Close's shape maps onto our established ingestion conventions.
4. The probe is read-only against Close. Confirm you understand that nothing in this spec writes to Close (no POST/PUT creating saved searches or leads) and nothing writes to Supabase.

State in your report's opening bullets what you confirmed, including the actual Smartview list endpoint path you verified and the actual field name that holds the query structure.

## The investigation

The probe script should be re-runnable and should print/save its findings in a form you can fold into the report. Investigate, in order:

**1. Auth + inventory.** Confirm `CLOSE_API_KEY` works via `GET /me/`. Then list every Smartview in the org. For each, capture: name, ID, type (lead vs contact), whether it's shared or private, and its raw query/filter structure. Drake has said there are "lots" of Smartviews — list ALL of them (id + name + type + shared/private) in a compact table, but only deep-analyze the query structure for the sales-funnel-relevant ones (the ones whose names map to appointment-setting / closing funnel metrics — triages, dials, hand-downs, hand-offs, DQs, downsells, booked meetings, setter/closer activity, etc.). Don't dump 80 full query blobs; dump the compact list + the deep structure for the relevant subset.

**2. Classify the shape of each relevant Smartview — the load-bearing question.** For each sales-funnel Smartview, determine whether it is:
   - **Activity-driven** (filters on timestamped events — e.g. "a call activity happened", "status changed on date X"). These bucket cleanly into per-day counts because the underlying object has a date.
   - **Status-driven / point-in-time membership** (filters on "leads currently in status X" or "leads with custom field Y = Z"). These give you a snapshot of *current* membership but do NOT naturally answer "how many on January 3" historically, unless there's an underlying timestamped activity or a status-change history to lean on.

   This distinction decides whether each Engine-sheet metric is cleanly reconstructable as a daily historical series or only as a going-forward snapshot. Report the activity-vs-status split explicitly — ideally a count of how many relevant Smartviews fall in each bucket, with examples. This is the single most important output of the discovery.

**3. Test the native Reporting API against a real Smartview — potential shortcut.** Pick one representative sales-funnel Smartview and call the Reporting API with its `saved_search_id` and a date range (say, the last 14 days). Report exactly what comes back: does it return per-day / per-period aggregates we could use directly? What metrics does it expose? Is the granularity daily, or only totals-over-range? Could it replace hand-rolled aggregation for some/all of the Engine-sheet metrics, or is it too coarse / wrong-shaped? This answers a genuine architecture fork: if Reporting gives clean daily numbers per Smartview, the ingestion design is dramatically simpler than mirroring raw objects and aggregating ourselves. Be concrete — paste the (trimmed) actual response shape, not a paraphrase.

**4. Custom-field reconnaissance.** Several Engine-sheet metrics smell like custom fields (e.g. "Tier 1 vs Tier 2 Booked Meetings", "Closer Triage Downsells", deposit/cash fields that may live on leads or opportunities). For the relevant Smartviews, note which custom fields their queries reference, and pull the custom-field definitions (Close exposes these at the `custom_field` endpoints — verify the current path) so we have the field IDs + types + (for choice fields) the choice values. This feeds the eventual schema design.

**5. Map ~5 representative Engine-sheet metrics end-to-end.** Pick 5 metrics spanning the range of difficulty and trace each from sheet-row → Close object/query/field → proposed-but-not-built Supabase shape. Suggested sample (adjust if the data argues for different picks, and say why):
   - **First Message Responses** (likely activity-driven, simple count)
   - **Total Closer Triages** (the classify-the-shape test case — is this activity or status?)
   - **Total Booked Meetings** + **Tier 1 / Tier 2 split** (the custom-field test case)
   - **A timestamped activity metric** like Setter Dials (clean daily bucketing)
   - **One computed/rate row** like Triage Rate (%) — to confirm it's derivable from raw rows we'd ingest, i.e. NOT itself ingested. State which raw inputs it needs.

   For each: what raw Close data produces it, at what grain, and whether it's cleanly historical or going-forward-only. Don't design the schema — just sketch "this would land as roughly {fields} keyed by {grain}" so Director can reason about grain (daily-snapshot table vs raw-object mirror) from real evidence.

## What success looks like

A findings report at `docs/reports/close-smartview-discovery.md` (six-section Builder report structure) that lets Director + Drake settle, with real evidence:
- **Grain decision:** daily metric snapshots vs mirroring Close's raw objects (leads/activities/opportunities) and deriving metrics on top. The activity-vs-status classification (Q2) is the evidence base for this.
- **Reporting-API decision:** does Close's native reporting replace hand-rolled aggregation for some/all metrics, or not (Q3).
- A complete Smartview inventory (compact table) + deep query structure for the sales-funnel subset.
- The custom-field IDs/types the funnel metrics depend on.
- 5 representative metrics mapped raw→proposed-shape.

Concrete acceptance: `GET /me/` returned 200; all Smartviews listed; ≥ the 5 sample metrics traced; the Reporting API was actually called once and its real response shape is in the report; activity-vs-status split is stated with counts. The report should make a *recommendation* on grain + reporting-API with reasoning, but frame it as input to Director's call, not a settled decision.

## Hard stops

- **`CLOSE_API_KEY` missing or differently-named in `.env.local`** → stop, report what you found in the env, don't proceed. (Drake says it's there as `CLOSE_API_KEY`, local-only; if reality differs, that's a surface worth knowing.)
- **Any 401/403 you can't resolve via the trailing-colon/empty-password auth detail** → stop and report the exact error + what you tried. Don't brute-force auth variants.
- **Anything that would write to Close** (creating/editing a saved search, lead, activity) → never. This is read-only reconnaissance. If a question seems to require a write to answer, note it as an open question in the report instead.
- **Repeated 429s** → back off, and if you can't complete the sampling within a reasonable call budget, report partial findings rather than hammering the API.

No Supabase writes, no migrations, no Vercel/env changes — none of this spec's work touches shared state, so there's no deploy/migration gate here. The only credential is the local `CLOSE_API_KEY`, read from `.env.local`, never echoed into logs, report, or committed code.

## Think this through yourself — what could go wrong

Before you finalize, consider: What if the Smartviews don't cleanly map to the Engine-sheet metric names (the sheet author may have used different labels than the actual Close views)? What if a metric the sheet attributes to "Close Smartviews" actually can't be derived from Close at all (lives in a Closer EOC Form or Calendly instead)? What if the Reporting API returns something between "perfect daily aggregates" and "useless" — partial coverage? What if status-driven Smartviews mean we *can't* reconstruct historical daily numbers and can only start the series going-forward? Surface these honestly in the Surprises section — a discovery that finds "this is harder than the sheet implies" is a successful discovery, not a failed one.

## Mandatory doc updates

- `.env.example` — add a documented `CLOSE_API_KEY` entry (Basic-auth-key-as-username/empty-password note, where to generate it in Close: Settings → Developer → API Keys, local-only-for-now status). This is the one standing-doc edit riding in this spec; it's small and concrete.
- The findings report itself at `docs/reports/close-smartview-discovery.md`.
- Do **not** update CLAUDE.md, state.md, or create schema docs in this spec — there's no shipped subsystem yet. If the report surfaces something that *should* eventually land in those, note it in the report's "Out of scope / deferred" section for a future spec.
