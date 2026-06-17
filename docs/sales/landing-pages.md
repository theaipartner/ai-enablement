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
  page is the single source of truth for that page's assets. Today: one entry
  (`main` = the high-ticket LP).
- **Landing-page dropdown** on the Funnel page filter row — a separate control
  from the Campaign → Ad Set → Ad cascade. It's **composable** with the ad
  filter (selecting both scopes the funnel to the intersection cohort). Picking
  a landing page sets `?lp=<slug>` and the "Landing pages →" button opens that
  LP's stats.

---

## The one thing that's deferred (and why)

**Two deferred items, both unblocking when the second LP is real:**

1. **Funnel-box re-scope by landing page.** The dropdown doesn't yet re-scope
   the funnel boxes — it can't until every lead is tagged with *which landing
   page's form* it came through, and right now our pipeline only ingests one
   Typeform (`SFedWelr`), so there's nothing to filter on.

2. **Per-landing-page video metrics for *shared* videos.** Each LP has its own
   Typeform, but the **VSL / thank-you videos may be shared** across LPs. We
   want each LP's page to show that video's stats *as embedded on that LP* —
   not its grand total. But we pull `wistia_media_daily`, which is **per-media,
   account-wide** (one set of daily numbers per video, summed across *every*
   page it's embedded on). So today (one LP) it's correct; the day a video is
   shared across two LPs, both LPs would show the *combined* numbers. Fixing
   this needs Wistia broken out **by embed / page URL** (Wistia tracks the
   `embed_url` per play, but the timeseries endpoint we ingest today doesn't
   expose it — likely a per-play events ingestion; needs a discovery pass to
   confirm the endpoint + limits). Only bites when a video is actually shared.

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
2. Teach the lead tagger to **ingest the new form** and stamp each lead with its
   source `form_id` (small migration + tagger change in `lib/db/lead-tags.ts`).
3. Add the `form_id` filter to the funnel SQL (`sales_funnel_counts`). → the
   dropdown now **re-scopes the funnel boxes**, composable with the ad filter.
4. **If the new LP shares a VSL or thank-you video with another LP**, do the
   Wistia per-embed work (deferred item 2 above) so each LP shows that video's
   own numbers. Skip if the new LP's videos are unique to it.

Steps 2–4 are why the form has to exist first — Builder matches the form's real
shape (qualification question, hidden fields) rather than guessing.
