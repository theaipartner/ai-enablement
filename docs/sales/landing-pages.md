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
- **Landing-page registry** — `lib/db/landing-pages.ts`. One entry per landing
  page is the single source of truth for that page's assets. Today: two entries
  — `main` (`/lp-vsl`, form `SFedWelr`) and `training` (`/training`, form
  `Os4c0q6V`, VSL `t05pq6ra0u`; live 2026-06-20).
- **Landing-page dropdown** on the Funnel page filter row — a separate control
  from the Campaign → Ad Set → Ad cascade. It's **composable** with the ad
  filter (selecting both scopes the funnel to the intersection cohort). Picking
  a landing page sets `?lp=<slug>` and the "Landing pages →" button opens that
  LP's stats.

---

## The one thing that's deferred (and why)

**Two deferred items, both unblocking when the second LP is real:**

1. **Funnel-box re-scope by landing page.** The lead tagger now accepts **both**
   high-ticket forms (`SFedWelr` + `Os4c0q6V`), so `/training` opt-ins enter
   `lead_cycles` and the funnel boxes — but **combined**, not per-LP. The dropdown
   re-scopes the ads / LP / VSL / Typeform summary, not the cohort boxes; the boxes
   still can't filter per-LP because `lead_cycles` doesn't record *which* form each
   cycle came through. Per-LP boxes would need a `source_form_id` on `lead_cycles`
   (the `source` column is just `'typeform'` for all forms).

2. **Per-landing-page video metrics for *shared* videos.** Each LP has its own
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

## Adding a new landing page

### Step 1 — what you collect (and hand to Builder)

For the new landing page, get these **five things**. Zain / whoever builds the
page + form will have them:

| # | Thing | Where it comes from |
|---|-------|---------------------|
| 1 | **Short name** for the page (e.g. "VSL-B test") | you decide |
| 2 | **Typeform form ID** — its own form, distinct from other LPs | the form's URL / Typeform admin |
| 3 | **VSL Wistia hashed_id(s)** — one or more if variants | Wistia (the media URL: `.../medias/<hashed_id>`) |
| 4 | **Thank-you / confirmation video Wistia hashed_id** | Wistia |
| 5 | **Landing-page URL / path** (e.g. `/lp-vsl-b`) | the page itself |

> The **Typeform form ID (#2) is the important one** — it's how we attribute a
> lead to this page and how the funnel re-scopes to it. Each landing page must
> have its **own** form.

### Step 2 — what Builder does with it

1. Add the entry to `lib/db/landing-pages.ts` (the 5 things above). → LP detail
   page works immediately for the new page.
2. Add the new form to `OPT_IN_FORMS` (`shared/lead_tagging.py`) and
   `HIGH_TICKET_TYPEFORM_FORM_IDS` (`funnel-assets.ts`), then run a full
   backfill-retag (`scripts/backfill_lead_tags.py --apply`). → its opt-ins enter
   `lead_cycles` and the (combined) funnel boxes. *(Done for `Os4c0q6V` 2026-06-26.)*
3. **Optional, for per-LP box scoping:** add a `source_form_id` to `lead_cycles`,
   stamp it in the tagger, and add the filter to the funnel SQL so the dropdown
   re-scopes the boxes per LP. Not yet done — boxes are combined across LPs.
4. **If the new LP would share a VSL or thank-you video with another LP**, have
   the team **duplicate the video** so each LP has its own Wistia hashed_id
   (see deferred item 2 — the per-embed API route was investigated and rejected
   as heavy + incomplete). With a unique id per LP, no extra work — the
   existing pipeline handles it. Skip entirely if the new LP's videos are unique.

Steps 2–4 are why the form has to exist first — Builder matches the form's real
shape (qualification question, hidden fields) rather than guessing.
