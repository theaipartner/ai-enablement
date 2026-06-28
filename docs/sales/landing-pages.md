# Sales — Landing Pages

How the dashboard handles landing pages, and **the checklist for adding a new
one**. If you're picking this up cold (new chat, time has passed): start at
"Adding a new landing page" below.

---

## What's already built (shipped 2026-06-16)

- **LP detail page** (`/funnel/landing-pages`) shows, for the selected landing
  page: the **VSL** Wistia metrics, the **thank-you video** Wistia metrics, and
  the **Typeform** metrics. Each video shows the five Wistia metrics —
  **Visits, Plays, Play rate, Time played, Engagement** — plus the **Average
  view duration** we derive. (Clarity + Calendly were removed.)
- **Landing-page registry** — now **DB-backed** (tables `landing_pages` +
  `landing_page_forms`, migration 0110), edited in Gregory at
  `/sales-dashboard/landing-pages` (admin). Was the static `lib/db/landing-pages.ts`
  array; that file is now a DB-backed async loader. Today: two entries — `main`
  (`/lp-vsl`, form `SFedWelr`) and `training` (`/training`, form `Os4c0q6V`, VSL
  `t05pq6ra0u`; live 2026-06-20). An LP owns a SET of forms (editing a form ADDS
  one); each form carries its own qualification config (field ref + qualifying
  answers), replacing the old global `INVEST_FIELD_REF` / ≥$2,000 rule.
- **Landing-page dropdown** on the Funnel page filter row — a separate control
  from the Campaign → Ad Set → Ad cascade. It's **composable** with the ad
  filter (selecting both scopes the funnel to the intersection cohort). Picking
  a landing page sets `?lp=<slug>` and the "Landing pages →" button opens that
  LP's stats.

---

## Per-LP scoping — how it works (shipped 2026-06-27)

Selecting a landing page re-scopes **every section of the Funnel page** — funnel
boxes, lead roster, the last-5-days daily table, the Ads/Landing-Page summary,
and the Digital College funnel. "All landing pages" (no `?lp=`) shows the
combined cohort.

The mechanism: each opt-in cycle records **which Typeform it came through** —
`lead_cycles.source_form_id` (migration 0106), stamped by the tagger
(`shared/lead_tagging.py`). Then:
- **Boxes** — `sales_funnel_counts` takes `p_source_form_id` (migration 0107),
  filtering the cycle base. Because each cycle has exactly one form, the per-LP
  opt-in counts PARTITION the total (Main + Training = All, in opt-in *events*).
- **Roster / daily / DC** — `getSpeedToLeadCohort` / `getDcFunnel` take a
  `formId` and filter `lead_cycles.source_form_id`.
- **Ads/LP summary** — Typeform aggregates the matching form(s); "All" sums every
  high-ticket form (`getTypeformMetrics` defaults to the set). Starts come from
  per-form Insights snapshots, summed across the counted forms; if a form lacks
  snapshot coverage the starts/rate show "—" (never a mixed, impossible rate).

> Each LP needs its own Typeform Insights snapshots for "starts" to populate —
> add the form to `FORM_IDS` in `api/typeform_insights_cron.py`. Starts build from
> snapshot deltas going forward (no historical backfill — seed a launch baseline
> if you need it immediately).

## The one thing that's still deferred (and why)

1. **Per-landing-page video metrics for *shared* videos.** Each LP has its own
   Typeform, but the **VSL / thank-you videos may be shared** across LPs. We
   want each LP's page to show that video's stats *as embedded on that LP* —
   not its grand total. But we pull `wistia_media_daily`, which is **per-media,
   account-wide** (one set of daily numbers per video, summed across *every*
   page it's embedded on). So today (one LP) it's correct; the day a video is
   shared across two LPs, both LPs would show the *combined* numbers.

   **Investigated 2026-06-16 (live Wistia API). Verdict: don't build per-embed
   ingestion — duplicate the video instead.**
   - The Wistia **events** endpoint (`/v1/stats/events.json`) carries
     `embed_url` + `percent_viewed` per play, so Plays / Engagement / Time
     played / Avg view duration *could* be split by LP. **But events have no
     load count**, so **Visits and Play rate can't be derived per-LP** (2 of
     the 5 metrics would be missing). Volume is ~100+ events/day/video → a new
     events pipeline + table + URL normalization + daily aggregation. Heavy and
     incomplete.
   - **Recommended:** when a video would be shared, give each LP its **own
     Wistia media (unique hashed_id)** — duplicate it. A separate hashed_id
     tracks independently, so our **existing** `wistia_media_daily` pipeline
     produces all five metrics + avg view duration correctly per LP with **zero
     code change** (just that LP's registry entry points at its own id). The
     only cost: the team maintains two copies if they edit the video.

---

## Adding a new landing page (in Gregory — no deploy)

Since the registry moved to the DB (migration 0110), you add a landing page on
the admin page: **`/sales-dashboard/landing-pages`** (admin-tier). No code change.

1. **Paste the LP link** → **Discover**. We fetch the page and auto-fill the VSL
   video(s) (from Wistia) and the Typeform it embeds. Discovery is best-effort —
   the Typeform sometimes isn't readable from the page (JS-injected, or a
   `data-tf-live` id), so confirm/pick it from the dropdown if needed.
2. **Set the videos** — VSL(s) and the thank-you/confirmation video are chosen
   from the **Wistia dropdown** (our `wistia_medias` mirror) or pasted by id. The
   confirm video isn't on the LP link (it's on the post-submit page), so pick it
   manually; LPs may share one.
3. **Pick the Typeform** (the attribution key — required; each LP must have its
   own form), then set **qualification**: choose the qualification question and
   tick **which answers qualify** a lead (e.g. everything except "Under $2,000").
4. **Save.** The LP appears in the funnel's landing-page dropdown on refresh.

**What happens to leads:** new opt-ins through the form attribute to the LP
**automatically** — the tagger reads the eligible form set from the DB at runtime,
stamps `lead_cycles.source_form_id`, and the funnel scopes by it. No retag needed
for a fresh LP. If real leads came in **before** you registered it, hit **Retag
now** on the LP's row to backfill those historical opt-ins into cycles.

**Editing** an LP's Typeform **adds** a form (an LP owns a set) — the old form's
leads stay counted. A form can belong to only one LP. **Delete** is allowed only
for an LP with no leads yet (test/junk); otherwise **Deactivate** (hides it from
the dropdown, keeps its cycles).

> **Shared videos caveat (unchanged):** if two LPs pick the *same* Wistia video,
> its metrics are account-wide per media (combined), not per-LP. For true per-LP
> video stats, duplicate the video so each LP has its own hashed_id (the per-embed
> API route was investigated and rejected — see the deferred item above).
