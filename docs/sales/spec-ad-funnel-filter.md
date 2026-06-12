# Spec — Ad filter on the funnel

**Status:** DRAFT (awaiting Drake's answers to § Open questions). 2026-06-12.

## Goal

Let the **existing** `/funnel` page (Total / Direct / Setter / Reactivation) be **sliced
to a single ad or campaign** via a filter at the top. Click an ad → the whole funnel
re-renders for just the leads that came from that ad, so we can see which ads/creatives
actually drive bookings → shows → closes and decide spend accordingly. **Reuse the
funnel; no separate per-ad table.**

## What we already have (no acquisition needed)

- `close_leads.ad_id` / `ad_name` / `campaign_id` / `adset_id` / `utm_campaign` —
  **~99% populated** on the unique-lead cohort (verified 2026-06-11, see
  [[data-model]] § Lead → ad attribution).
- `close_leads.ad_id` → `cortana_ad_daily.platform_entity_id` joins at **100%** for
  readable ad names + spend.
- The funnel already supports filtering (type/stage → roster) via
  `reachedStage` / `matchesLeadFilter` in `lib/db/leads-funnel.ts`, URL-param-driven and
  persisted by `PersistPageState`. The ad filter is the **same pattern, one more
  dimension.**

## Design

### 1. Data — denormalize ad attribution onto `lead_cycles` (the funnel substrate)

Add to `lead_cycles`: `ad_id`, `ad_name`, `campaign_id`, `campaign_name` (text).
- **Why on `lead_cycles` and not just join `close_leads`:** the funnel aggregates over
  `lead_cycles`; carrying the ad columns there makes the filter a `WHERE ad_id = …` and
  the eventual SQL rollup a `GROUP BY ad_id` — no per-query join, no repeated work. This
  is the SQL-aggregation-friendly shape.
- **Populate:** the tagger (`shared/lead_tagging.py` / `lib/db/lead-tags.ts`) already
  builds each `lead_cycle` from the lead — it stamps `ad_id`/`ad_name`/`campaign_id` from
  `close_leads` at the same time. `campaign_name` resolved from `cortana_campaign_daily`
  (campaign_id → entity_name), falling back to `utm_campaign`.
- **Backfill:** one script to fill existing `lead_cycles` rows from `close_leads`.
- **Migration:** add columns (Drake reviews the SQL diff — gate).

### 2. Data layer — an optional ad filter on the cohort

- Add `adId?` / `campaignId?` to the funnel cohort builder (`getSpeedToLeadCohort` and the
  `leads-funnel` predicate). When set, restrict the cohort to `lead_cycles` rows matching
  that ad/campaign. Everything downstream (every stage box, the roster) inherits the
  scope because they all read the same cohort — same guarantee that a box equals the
  roster it opens.
- **Ad-list for the selector:** `SELECT campaign_name, ad_id, ad_name, count(*)
  FROM lead_cycles WHERE <window> GROUP BY …` — grouped by campaign, ads nested, each with
  its in-window lead count. (Once denormalized this is a single grouped query.)

### 3. UI — the slicer at the top of `/funnel`

- A searchable selector above the funnel: **campaigns as groups, ads nested**, each
  showing its lead count. Default **"All ads."**
- Selecting sets a URL param (`?ad=<ad_id>` or `?campaign=<campaign_id>`); the funnel
  re-renders scoped. Persisted via `PersistPageState` like window/type/stage.
- **Composes** with the existing window + type/stage filters (ad ∩ type ∩ stage ∩ window).
- The ad scope **flows into the roster** when you click a funnel stage (the stage link
  carries the ad param), so "Direct → Booked for Ad X" opens the matching roster.

## SQL aggregation — design for it now (the next project)

Per Drake: the SQL-aggregation rework is the **very next thing**, so this filter must be
built to slot into it, not be thrown away:

- The ad filter is a **WHERE-clause dimension**, never a JS post-filter. When the funnel
  counts move into a parameterized Postgres function/view (the rework), the signature is
  just `funnel(window, type, stage, ad_id)` — the ad param is already in that shape.
- The **denormalized ad columns on `lead_cycles` are the shared foundation** — both the
  filter (now) and the aggregation rollup (next) read them. So this work is a stepping
  stone toward SQL-agg, not a detour.
- **Sequencing options:**
  - **(A) Ship the ad filter on the current engine now, SQL-agg next** — matches Drake's
    stated order; gets the boss-facing slicer out fastest; the denormalization is the
    bridge. *(Lean.)*
  - **(B) Do the funnel's SQL-agg rework first, then the ad filter is a trivial param** —
    cleaner but slower to the boss-facing result.

## Phasing (Option A)

1. **Migration + populate** — ad columns on `lead_cycles`, tagger stamps them, backfill
   existing rows, dual-verify. *(Drake gates SQL.)*
2. **Filter** — selector UI + URL param + cohort filter on the existing funnel; flow the
   ad scope into the roster.
3. **Fast-follow / with SQL-agg** — spend + ROAS per ad in the selector or a summary
   strip; the funnel SQL-aggregation rework (ad param drops straight in).

## Open questions (need Drake)

1. **Granularity:** filter by individual **ad**, by **campaign**, or **both** (campaign
   groups with ads nested)? *(Lean: both.)*
2. **Selector content:** show just **lead counts** per ad now, or **spend / ROAS** beside
   each ad? *(Lean: counts now, spend/ROAS in the fast-follow with SQL-agg.)*
3. **Scope of the slicer:** main HT funnel only, or also **Reactivation / Revival / DC**?
   *(Lean: main HT funnel first; the others are smaller and some have no ad attribution —
   revival leads have no Typeform cycle.)*
4. **Sequencing:** confirm **Option A** (filter now, SQL-agg next) vs **B**.
</content>
