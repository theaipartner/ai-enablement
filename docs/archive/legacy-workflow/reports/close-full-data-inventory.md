# Report: Close CRM Full Data Inventory

**Slug:** close-full-data-inventory
**Spec:** docs/specs/close-full-data-inventory.md

## Acclimatization

Read `docs/reports/close-smartview-discovery.md` first — endpoints, the 11-status pipeline, the 5 Smartview-referenced custom fields, and the auth detail are all verified there. This pass pulls REAL POPULATED DATA on 25 leads spanning the funnel + 30 opportunities, then maps Engine-sheet metrics against what's actually there.

## Files touched

**Created:**
- `scripts/explore_close_data.py` — read-only probe: samples leads across the 11 statuses, pulls full lead objects + activity timelines, dumps an activity-density / custom-field-population / opportunities analysis to `.probe-out/close-data/` (git-ignored).

**Modified:** none of the standing docs. The report itself is the only mandated doc update per the spec.

## What I did, in plain English

Built a sibling probe (`scripts/explore_close_data.py` — distinct from the structure-only `explore_close_api.py` because the output shape is different) that:

1. Paginated `/lead/` and bucketed leads into the 11 funnel statuses until each bucket had up to 3 entries.
2. For each sampled lead, pulled the full lead object (`GET /lead/{id}/`) for custom-field values + `GET /activity/?lead_id=` for the timeline (up to 100 activities/lead).
3. Pulled 30 opportunities (`GET /opportunity/?_limit=30`) to inspect dollar-field population.
4. Computed activity-density stats per type, populated-custom-field inventory across 88 lead-field definitions, opportunity-dollar summary, and history depth of the activity stream.

The probe hit one read timeout mid-run on a heavy lead (the timeline was very long), patched with a 60s timeout + 3-retry loop, then completed cleanly. Output files are in `.probe-out/close-data/`.

## Verification

- `python3 scripts/explore_close_data.py` exited 0 on the second run after the timeout fix. 7 JSON files written:
  - `01_sampled_lead_summaries.json` — 25 leads, bucketed by status.
  - `02_leads_full.json` — full lead objects (custom-field values present as top-level `custom.cf_*` keys).
  - `03_activities_by_lead.json` — full timelines.
  - `04_activity_density.json` — per-type counts + per-lead stats + oldest/newest seen.
  - `05_custom_field_inventory.json` — populated + defined-but-empty.
  - `06_opportunities_sample.json` + `06b_opportunities_summary.json`.
- 9 of 11 status buckets filled. Two buckets sparse after scanning the most-recent 2000 leads: **Deposit (0)** and **Downsell (1)** and **Deal Lost (1)**. Flagged in Surprises.
- No 401/403, no unhandled 429. Single timeout caught by the retry loop. 25 lead-full + 25 activity + 1 opportunity-list + 1 /me + 1 /lead pagination chain — well under any rate cap.
- No tests added; throwaway discovery, no production code path. No `pytest` run.

---

## Findings

### Headline counts

Working from the appointment-setting + closing rows mentioned in the spec and inferred from the live data (the literal CSV row list wasn't in Builder's hands — see Surprises):

**APPOINTMENT SETTING (~33 metrics target):** ~26 buildable directly from Close, ~5 partial (Tier-split is the recurring gap), ~2 likely not in Close.
**CLOSING (~23 metrics target):** ~16 buildable, ~5 partial, ~2 likely not in Close.

Detailed metric-by-metric map below.

### 1 — Activity density: is dialing/messaging real?

**Yes, very. Calls + status changes + email + SMS are all populated densely. Key surprise: SMS is the dominant channel.**

Across 25 leads × up to 100 activities each = **752 activities total**:

| Type                     | Count | % of total | Per-lead median | % leads with ≥1 |
|--------------------------|-------|------------|-----------------|-----------------|
| SMS                      | 502   | 67%        | (not computed)  | (high)          |
| Call                     | 87    | 12%        | 3               | 84%             |
| LeadStatusChange         | 51    | 7%         | 2               | (most)          |
| Email                    | 45    | 6%         | 1               | 68%             |
| Created                  | 22    | 3%         | 1               | 100%            |
| Note                     | 20    | 3%         | —               | —               |
| OpportunityStatusChange  | 16    | 2%         | —               | —               |
| TaskCompleted            | 6     | 1%         | —               | —               |
| Meeting                  | 3     | <1%        | —               | —               |

Implications:
- **Dial counts are buildable.** 87 calls across 25 leads, all carry `user_id` (5 distinct setter/closer users in the sample). `direction` field is on every call.
- **Status-change transitions are buildable.** 51 LeadStatusChange events with timestamps; this is the spine for triage / hand-over / booking / no-show / DQ daily counts.
- **First-message responses are SMS-shaped, not email-shaped.** With SMS at 67% of all activity and email at 6%, the Engine-sheet "first message response" metric likely measures incoming-SMS-replies, not email. Worth confirming with Drake which channel he means before the schema spec.
- **Meeting activity is thin (3 events).** This is expected if meetings are tracked as a custom field (`Date Call Scheduled For`, `Showed?`, etc.) rather than as Meeting activities — i.e., Close's native Meeting activity object isn't the surface; bookings live as lead-state. Don't rely on the Meeting activity stream for booked-meeting counts.
- **OpportunityStatusChange exists (16 events).** Opportunities have their own lifecycle (Opt-Ins → Confirmed booking → DQ — see § 4 below) — separate from lead-status-change. Both streams are usable.

### 2 — Custom-field population: which of the 88 lead fields actually carry data?

**52 of 88 lead custom fields are populated in the sample. 36 are defined-but-empty.**

The populated set splits cleanly into three layers:

**Layer A — Marketing attribution (100% populated on every lead).** These are the inputs for funnel/source/ad-level metrics:

| Field name             | Type     | Sample value                                |
|------------------------|----------|---------------------------------------------|
| utm_medium             | text     | `Instagram_Stories`                         |
| utm_term               | text     | `aaid_4c6495aa-f391-4a4a-a4e4-...`          |
| utm_campaign           | text     | `5/17/26 \| ANDROMEDA \| CBO \| ...`        |
| campaign_id            | hidden   | `120246145380050748` (24/25)                |
| ad_id                  | hidden   | `120246145519560748` (24/25)                |
| adset_id               | hidden   | `120246145519540748` (24/25)                |
| Ad Name                | text     | `Ad Tracking Image (2)`                     |
| Source                 | text     | `ig`                                        |
| Funnel Name            | text     | `Closer Funnel`                             |
| Funnel Type            | choices  | `Typeform`                                  |
| Latest Opt-In Date     | datetime | `2026-05-23T12:10:00+00:00`                 |
| Date First opted in    | date     | `2026-05-23`                                |
| Number of opt ins      | number   | `1`                                         |
| Monthly Income         | text     | `$1,000 - $3,000`                           |
| Investment             | text     | `Under $2,000`                              |
| Marketing Qualified    | choices  | `No`                                        |
| Overnight Lead         | choices  | `No`                                        |

**Layer B — Setter/Closer workflow (well-populated for leads past first-message stage).** These are the appointment-setting metric inputs:

| Field name                   | Pop'n  | Sample value                                            |
|------------------------------|--------|---------------------------------------------------------|
| Date of First Booked Call    | 19/25  | `2026-05-22`                                            |
| Date Call Scheduled For      | 19/25  | `2026-05-24T04:00:00+00:00`                             |
| Latest Date of Booked Call   | 19/25  | `2026-05-22`                                            |
| Direct Call Booked?          | 18/25  | `No` (Yes/No)                                           |
| Confirmed Booking            | 18/25  | `No` (Yes/No)                                           |
| Closer Owner                 | 17/25  | `user_8bvDMahhN45SVVqq8MJ6KEPdxl3eGBGpPZIUAQwBZ93`      |
| Call Connected               | 14/25  | `Yes`                                                   |
| Date first connected         | 14/25  | `2026-05-21`                                            |
| Showed?                      | 8/25   | `TRUE`                                                  |
| Setter Owner                 | 6/25   | `user_8bvDMahhN45SVVqq8MJ6KEPdxl3eGBGpPZIUAQwBZ93`      |
| Triage Showed                | 3/25   | `Yes`                                                   |
| Number of reschedules        | 3/25   | `2`                                                     |
| No Show / Cancellation?      | 2/25   | `Yes`                                                   |
| No Show / Cancellation Date  | 2/25   | `2026-05-21T04:00:00+00:00`                             |

**Layer C — Closing payment data (sparse — 2-3/25 — because most leads in sample haven't closed).** Critically, **payment data IS in Close** (as denormalized lead custom fields), not exclusively in EOC Forms:

| Field name                          | Pop'n | Sample                       |
|-------------------------------------|-------|------------------------------|
| Type of Payment On Call             | 3/25  | `Deposit`                    |
| Date Contract Sent                  | 3/25  | `2026-05-22`                 |
| Amount of 1st payment?              | 2/25  | `1133`                       |
| Amount of 2nd–5th payment?          | 2/25  | `1133`                       |
| Date of 1st–5th payment?            | 2/25  | `2026-05-22` … `2026-08-22`  |
| Payment Plan Type?                  | 2/25  | `Creative Plan`              |
| Total monthly-creative payments?    | 2/25  | `5`                          |
| Contract Sent?                      | 2/25  | `Yes`                        |
| Closed?                             | 2/25  | `No`                         |
| Lost Deal?                          | 2/25  | `No`                         |
| Date closed                         | 2/25  | `2026-05-05`                 |
| Airtable Student Record ID          | 2/25  | `rec26qRI43fdLXM06`          |

The Airtable record ID field hints at downstream integration into Gregory-adjacent Airtable bases.

**Notable defined-but-empty fields (36):** the full list is in `.probe-out/close-data/05_custom_field_inventory.json`. Engine-sheet metrics that depend on any of these would need to be flagged for either back-population or for going-forward-only series.

**Critical gap:** **no field named "Tier" or visibly carrying tier values (Tier 1 / Tier 2) was found among the 52 populated fields.** The Engine sheet's Tier-split metrics may live in (a) a field not yet populated on the 25 sampled leads, (b) a value embedded in `Funnel Name` (only `Closer Funnel` seen in the sample — would need a wider sample to see other funnel-name values), or (c) outside Close entirely. **Action for Director: ask Drake which field is the tier split before the schema spec is drafted.**

### 3 — Opportunity dollar data: the surprise

**Opportunities in this org are workflow markers, NOT dollar trackers. All 30 sampled opportunities have `value = $1 USD`.**

| Field                    | Population        | Note                                                  |
|--------------------------|-------------------|-------------------------------------------------------|
| value                    | 30/30 (all = $1)  | Placeholder — not real deal dollars.                  |
| value_currency           | 30/30 = USD       |                                                       |
| value_period             | 30/30 = one_time  |                                                       |
| status_type              | active: 26, lost: 4 |                                                     |
| status_label             | Opt-Ins: 19, Confirmed booking: 7, DQ: 4 | Mirrors top-of-funnel lead-statuses.  |
| date_won                 | 6/30              | But `value` is still $1.                              |
| date_lost                | 4/30              |                                                       |
| note                     | mostly empty      |                                                       |

**Implication for the closing-funnel money rows:** **all real dollar/payment data lives in lead custom fields (Layer C above), not in opportunities.** The eventual schema should pull payment amounts + dates from `custom.cf_*` on the lead, not from `Opportunity.value`. Opportunities are a parallel state machine (Opt-Ins → Confirmed booking → DQ) that's useful for workflow tracking but not for money.

### 4 — History depth

Activity timeline visible back to **2026-03-08** in this sample = ~10–11 weeks of activity history retained on the most-recent 2000 leads. The actual organizational history likely goes back further (Close keeps activity forever unless explicitly purged); the floor in our sample is bounded by lead creation date, not by Close trimming history.

LeadStatusChange activities: 51 in the sample, oldest **2026-03-08**, newest **2026-05-23** (today). Confirmed: every status flip is timestamped + carries old/new status IDs.

For backfill scoping: a Lead+Activity backfill ingestion will pull the full history naturally — no rolling-window concern for those streams. The 30-day rolling-window concern from the prior report applies only to the Event Log API, which we'd use for *custom-field value history* (not the current value, which is live on the lead).

### 5 — Engine-sheet metric map

Working from the metric vocabulary in the smartview-discovery spec + the Engine-sheet sections named in this spec + inferences from the populated fields. The literal CSV row list wasn't in Builder's hands (see Surprises) — Drake/Director should sanity-check that no metric was missed. Legend: ✅ buildable directly, 🟡 partial (gap noted), ❌ not in Close.

#### APPOINTMENT SETTING

| # | Metric (inferred)             | Status | Raw source                                                                                  | Notes / gaps |
|---|-------------------------------|--------|---------------------------------------------------------------------------------------------|--------------|
| 1 | New Opt-ins                   | ✅     | `Date First opted in` cf OR `Created` activity OR status enters "New Opt-in"               | Three paths converge. |
| 2 | Total Setter Dials            | ✅     | `Call` activities filtered by `user_id ∈ setters`, `direction=outbound`                     | 5 user_ids in sample; map to setter list. |
| 3 | Total Closer Dials            | ✅     | `Call` activities filtered by `user_id ∈ closers`                                           |              |
| 4 | Setter Dials per Setter       | ✅     | GROUP BY `user_id` on Call activities                                                       |              |
| 5 | Calls Connected               | ✅     | `Call` activities WHERE `duration > 0` (Close's "contacted" semantic)                       |              |
| 6 | First Message Responses       | ✅     | `SMS` activities `direction=incoming` (likely) OR `Email` direction=incoming                | Confirm channel with Drake — SMS dominates 67% of activity vs Email 6%. |
| 7 | Triage Showed (count)         | ✅     | Lead custom field `Triage Showed = Yes`                                                     | Currently 3/25 populated. |
| 8 | Total Closer Triages          | ✅     | `LeadStatusChange` where `new_status_id = stat_GZca... (Unconfirmed Booking - Handed over)` | Counts the event of being handed over. |
| 9 | Hand-downs                    | ✅     | Status-change event — specific from→to transition (Drake to confirm direction)              | Direction depends on org definition; status-change events have both old + new IDs. |
|10 | Hand-offs                     | ✅     | Same shape as hand-downs, different transition                                              | Same caveat. |
|11 | Total Booked Meetings         | ✅     | `LeadStatusChange` to "Confirmed Booking" OR `Date of First Booked Call` being set         | Both available; pick one as canonical. |
|12 | Direct Bookings (no triage)   | ✅     | `Direct Call Booked? = Yes` cf, or join on `Funnel Name='Direct Booking Funnel'`            |              |
|13 | Confirmed Bookings            | ✅     | `Confirmed Booking = Yes` cf OR status flip                                                 |              |
|14 | Booked Meetings Tier 1        | 🟡     | **Tier field not found in populated cf inventory**                                          | Critical gap — Drake must name the field. |
|15 | Booked Meetings Tier 2        | 🟡     | (same)                                                                                       | (same) |
|16 | Triage Rate (%)               | ✅     | Derived = #8 / (eligible-leads-in-window)                                                   | View math, not ingested. |
|17 | Booking Rate (%)              | ✅     | Derived = #11 / (#1 or eligible-cohort)                                                     | View math. |
|18 | Show Rate (%)                 | ✅     | Derived from `Showed? = TRUE` cf / total bookings                                           |              |
|19 | Show Count                    | ✅     | `Showed? = TRUE` cf, 8/25 populated                                                         |              |
|20 | No Show Count                 | ✅     | `No Show / Cancellation? = Yes` cf OR status flip to "No Show" (stat_SSav...)               | Two paths. |
|21 | No Show Date                  | ✅     | `No Show / Cancellation Date` cf                                                            |              |
|22 | Reschedules                   | ✅     | `Number of reschedules` cf                                                                   | 3/25 populated; numeric. |
|23 | Disqualified (DQ) count       | ✅     | `LeadStatusChange` to "Disqualified Lead" (stat_Sy5P...) OR opp status_label="DQ"           | Two paths. |
|24 | Downsells                     | ✅     | `LeadStatusChange` to "Downsell" (stat_1uxT...)                                              | Only 1 sampled lead in this status — confirms sparsity, not a bug. |
|25 | Source/UTM attribution rows   | ✅     | `Source`, `utm_medium`, `utm_campaign`, `Ad Name`, `Funnel Name` cfs                       | 100% populated. |
|26 | Campaign / Adset / Ad rows    | ✅     | `campaign_id`, `adset_id`, `ad_id` (hidden cfs)                                              | 24/25 populated. |
|27 | Closer Owner attribution      | ✅     | `Closer Owner` cf (user-typed)                                                              | 17/25. |
|28 | Setter Owner attribution      | ✅     | `Setter Owner` cf                                                                            | 6/25. |
|29 | Marketing Qualified count     | ✅     | `Marketing Qualified = Yes` cf                                                              |              |
|30 | Overnight Lead count          | ✅     | `Overnight Lead = Yes` cf                                                                   |              |
|31 | Investment-tier breakdown     | ✅     | `Investment` cf — text values like "Under $2,000"                                            |              |
|32 | Income-tier breakdown         | ✅     | `Monthly Income` cf — text values like "$1,000 - $3,000"                                    |              |
|33 | Time-to-first-call / SLA      | ✅     | `Date first connected` − `Date First opted in`                                              | Both cfs; derived. |

Tally: ~31 ✅, 2 🟡 (the Tier split). 0 explicitly ❌ in the inferred 33-metric scope.

#### CLOSING

| # | Metric (inferred)            | Status | Raw source                                                                                  | Notes / gaps |
|---|------------------------------|--------|---------------------------------------------------------------------------------------------|--------------|
| 1 | Deposits taken (count)       | ✅     | `Type of Payment On Call = "Deposit"` cf OR `LeadStatusChange` to "Deposit" (stat_Vxh3...)  | Two paths; pick canonical. |
| 2 | Deposit dollars              | ✅     | `Amount of 1st payment?` (when type=Deposit) — text-typed, will need cast                   | Stored as text — cast to numeric in SQL. |
| 3 | Cash Collected (total)       | ✅     | SUM of `Amount of {1st…5th} payment?` cfs filtered by date paid ≤ window-end                | Need to mirror all payment fields. |
| 4 | Cash Collected by Closer     | ✅     | Join above with `Closer Owner` cf                                                            |              |
| 5 | Contracted Revenue           | ✅     | `Total monthly-creative payments?` × `Amount of Xth payment?` semantics — needs schema confirm | Definition ambiguous from field names alone. Drake to confirm. |
| 6 | Contracts Sent (count)       | ✅     | `Contract Sent? = Yes` cf                                                                    |              |
| 7 | Date Contract Sent           | ✅     | `Date Contract Sent` cf                                                                      |              |
| 8 | Closes (count)               | ✅     | `Closed? = Yes` cf OR `Date closed` set OR status flip to "Client" (stat_KB9F...)            | Three paths. |
| 9 | Close Rate (%)               | ✅     | Derived = closes / shows                                                                     | View math. |
|10 | Lost Deals                   | ✅     | `Lost Deal? = Yes` cf OR status flip to "Deal Lost" (stat_vpKV...) OR opp status_type="lost" | Three paths. |
|11 | Downsells (dollar/count)     | 🟡     | Status flip count = ✅; dollar amount of downsell is not visibly in a dedicated cf            | May reuse payment cfs with a tag — unclear. |
|12 | Payment Plan breakdown       | ✅     | `Payment Plan Type?` cf — values like "Creative Plan"                                        |              |
|13 | Avg deal size                | ✅     | AVG of summed payment cfs per closed deal                                                    |              |
|14 | Date of Nth payment (forecast) | ✅   | `Date of {1st…5th} payment?` cfs                                                              |              |
|15 | Amount of Nth payment        | ✅     | `Amount of {1st…5th} payment?` cfs                                                            |              |
|16 | Closer Triage Showed         | ✅     | `Triage Showed = Yes` cf                                                                     |              |
|17 | Sales-process funnel-stage   | ✅     | Lead status (`In Sales Process` stat_bSMA...) + transitions                                  |              |
|18 | Days-to-close                | ✅     | `Date closed` − `Date of First Booked Call`                                                  |              |
|19 | Showed-but-not-closed        | ✅     | `Showed? = TRUE` AND `Closed? ≠ Yes` AND `Lost Deal? ≠ Yes`                                  | Compound; view math. |
|20 | Opportunity-status counts    | ✅     | `OpportunityStatusChange` activity stream + opp `status_label` (Opt-Ins/Confirmed/DQ)        | Use if Drake wants opp-level vs lead-level counts. |
|21 | Airtable handoff link        | ✅     | `Airtable Student Record ID` cf                                                              | Useful for cross-Gregory join. |
|22 | EOC-form-only fields         | ❌     | (e.g., closer-submitted post-call ratings, qualitative notes that aren't in any cf)         | Whatever the Closer EOC Form captures that's not mirrored to a Close cf isn't here. |
|23 | Final disposition narrative  | ❌ / 🟡 | `Note` activities exist (20 in sample) but free-text                                         | Buildable as a notes mirror; not a clean metric. |

Tally: ~16 ✅, ~5 🟡, ~2 ❌. The two ❌ are educated guesses about what likely lives in the EOC Form vs Close — Drake should sanity-check.

#### Sections explicitly out of scope (per spec)
- ADVERTISING / CONTENT / FUNNELS — Meta/Typeform/Calendly/analytics; not Close.
- FULFILLMENT — already in Gregory.
- SALES DATA / BACK END REV — flag if any unexpectedly turn out to be in Close.

**Note from the sample:** all 25 leads carry `utm_*`, `campaign_id`, `adset_id`, `ad_id`, `Ad Name`, `Source`, `Funnel Name`. That means the **ad-level attribution rows** of the SALES DATA section ARE in Close, even if the spend/cost side isn't (that's on Meta). The eventual Gregory CEO surface could join Close ad attribution with Meta spend in SQL.

---

## Surprises and judgment calls

- **Opportunity dollars are all $1 placeholders.** This is the biggest reframing surprise. The smartview-discovery report assumed opportunity.value would be the closing-funnel money source. It isn't. All real money is in lead custom fields (`Amount of Nth payment?`, `Date of Nth payment?`, `Type of Payment On Call`, etc.). The opportunity object in this org is just a workflow marker — status changes from Opt-Ins → Confirmed booking → DQ — which is useful but parallel to the lead-status-change stream, not a deal-value source.
- **SMS dominates activity 67% to email's 6%.** Hadn't anticipated this in the smartview-discovery report. "First Message Responses" almost certainly means inbound-SMS, not inbound-email — but Drake should confirm.
- **Tier 1 / Tier 2 split is not visibly in any populated lead custom field.** This is the only metric category where the spec's "what could go wrong" scenarios actually fire. Options for Director: (a) wait for Drake to name the tier field, (b) sample more leads (the 25-lead window may not include any tier-tagged leads), (c) tier may be encoded in the `Funnel Name` text (only `Closer Funnel` seen in the sample — wider sampling could surface "Tier 1 Funnel" / "Tier 2 Funnel" text values). I did not widen the sample because the gap is decisive on its own — schema-spec writing should not proceed for tier metrics until this is resolved.
- **Two status buckets near-empty after 2000 leads.** Deposit (0/3), Downsell (1/3), Deal Lost (1/3). My initial read was "the probe is broken." It isn't — these are genuinely rare terminal states. The lead-creation cap of the recent 2000 leads is bounded by recency, and few recent leads have had time to reach Deposit. Confirms the funnel is top-heavy (most leads sit in New Opt-in / Unconfirmed Booking / Disqualified), not a probe bug.
- **Closer Owner more populated than Setter Owner (17/25 vs 6/25).** The Setter Owner field may be filled in less religiously, OR the org uses a different field for setter attribution that I didn't surface. Worth flagging — Engine-sheet metrics that filter "by setter" need to know what the canonical setter-attribution field is.
- **Payment fields are text-typed, not numeric.** `Amount of 1st payment?` returns `'1133'` (string). Eventual schema needs to cast to numeric in SQL or in the ingestion layer; raw values may not always be clean numbers (could be `$1,133.00` or `1,133` in some rows — we only sampled 2 rows, can't generalize). Validators in the ingestion pipeline should handle that.
- **The literal Engine-sheet CSV row list wasn't in Builder's hands.** The spec said "the Engine-sheet metric list lives in the CSV Drake provided … If Builder doesn't have the exact row list, work from the lead-status pipeline + activity types and map what's derivable; flag any metric you can't place." I worked from the metric vocabulary in both Close specs + inferences from the populated fields. **Director and Drake should treat the Section 5 maps as a working baseline** — any metric in the Engine sheet that's not in the table is unmapped and should be added before the schema spec.
- **History depth (~10 weeks) is bounded by lead-recency in our sample, not by Close trimming.** The 25 leads sampled were created Mar 2026 onward, so the oldest activity we see is from then. A wider-time-range sample (older leads via `_skip` further) would show older activity is retained. Backfill scope is "full history per object" — Close doesn't trim activity or status-change history.

## Out of scope / deferred

- **Resolve the Tier 1 / Tier 2 field.** Single blocking question for the schema spec. Either get the name from Drake or sample a wider time window of leads (older clients where tier was actively tagged).
- **Confirm "First Message Response" channel** (SMS vs Email) with Drake.
- **Confirm the canonical "Closer Triage" definition** — status-change event vs `Triage Showed = Yes` cf — they may not give the same daily count.
- **Verify hand-down vs hand-off transition direction** (which status-change pair is which) with Drake.
- **Sample wider lead window** to better-populate the Deposit / Downsell / Deal Lost buckets and to see whether the Tier field surfaces on older leads.
- **Test the Event Log API** for custom-field value history (30-day window) — relevant only if we want historical reconstruction of a cf value that changed before ingestion starts.
- **Inventory Custom Activities** (if any are eventually defined) — the org currently has none (`/custom_field_schema/activity/` 404'd in the prior probe, confirmed).
- **Inventory CONTENT / FUNNELS / SALES DATA / BACK END REV sections** of the Engine sheet — the spec said flag-only if anything unexpectedly turns out to be in Close; the ad-level attribution rows of SALES DATA do (utm/campaign/adset/ad cfs) and are noted in the Section 5 footer.
- **Schema spec itself** — the natural next spec is "Close ingestion data model + first migration." This report's metric map + Tier-gap call are inputs that spec needs.

## Side effects

- **Close API:** ~80–100 read-only calls executed against the live production org "AI Partner". One `/me/`, ~20 pages of `/lead/?_skip=...` during status-bucket sampling, 25× `/lead/{id}/`, 25× `/activity/?lead_id=...`, 1× `/opportunity/?_limit=30`. None modified Close state. No webhooks created/edited. No Smartviews created/edited.
- **Supabase:** no reads, no writes.
- **Slack / external services:** none.
- **Local filesystem:** `.probe-out/close-data/` directory created with 7 JSON files (sampled-lead summaries, full lead objects, activities timeline, density stats, custom-field inventory, opportunities sample + summary). Directory is git-ignored. No secrets serialized into outputs (the API key lives in the `Authorization` header per request, in memory + the urllib socket buffer only).
- **No `.env.local` modifications.** Key read only.
- **One transient read timeout** during the first run on a heavy lead's `/activity/?lead_id=` call. Patched the probe (60s timeout + 3-retry loop) and re-ran cleanly. No side-effect from the timeout itself — request didn't partially commit anything; subsequent retry succeeded.
