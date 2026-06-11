# Sales — Data Model

The entities, the funnel, and the table manifest. For the *matching rules* that turn
raw rows into these concepts, see [`logic.md`](./logic.md).

---

## The lead definition — the "unique leads list"

This is the single definition the whole product runs off. A **unique lead** is a
person who:

1. is **non-revival** — the `REVIVAL_CF` custom field is empty (revival leads are a
   separate campaign, see below) — and not soft-hidden (`close_leads.excluded_at IS NULL`);
2. has a **Typeform `SFedWelr` match** by email/phone — the high-ticket opt-in gate;
3. **first opted in on or after 2026-05-24** — `close_leads.date_first_opted_in >= '2026-05-24'`.

**Returning leads** (first opted in *before* May 24, re-opted after) are **excluded
everywhere** in the funnel and roster — they made the data messy (Drake's call). They
still render a per-lead page, but it shows "No opt-in cycle yet".

### `lead_cycles` IS the unique leads list

The tagger (`lib/db/lead-tags.ts`) writes one row per opt-in cycle to `lead_cycles`,
and its universe is exactly the unique-leads predicate above. There is **no
`close_fallback`** — no Typeform match means no cycle. A full `--apply` retag **wipes
and rebuilds** `lead_cycles`. `lead_cycles` is the aggregation substrate for the
funnel, roster, per-lead page, DC funnel, and Cash.

### Two counts — keep them distinct

- **Lead list** (roster / speed-to-lead / FMR) = **unique people** (~295).
- **Funnel** = **opt-in events** = Typeform-sourced `lead_cycles` rows whose `opt_in_at`
  is in window (~300–318). One person opting in twice in-window counts twice.

`getSpeedToLeadCohort` membership = `close_leads` (in-window `date_first_opted_in`,
non-revival, `excluded_at IS NULL`) **∩** a `lead_cycles` row with `source='typeform'`
in window. Every cohort row is `optInType:'new'` — the old Close-status qualification
and the re-opt-in branch are gone; the all/unique toggle and the Opt-in badge column
were removed.

---

## The funnel

A **cumulative, monotonic** ladder. Each box counts each lead **once**; reaching a
stage means "got at least this far":

```
opt-ins → connected → booked → confirmed → showed → closed
```

- **`confirmed` exists only on Direct (and Total).** Setter and Reactivation skip it.
- The **closed** node is split `(N HT / N DC)`.
- `books ≥ connected ≥ confirms ≥ shows ≥ closes` — enforced as an integrity guard.
  **Exception:** in the **Total** funnel, Books *can* exceed Connected, because a pure
  self-booked direct booking is not a "connection" (intended).

`reachedStage(row, type, stage)` in `lib/db/leads-funnel.ts` is the single source of
truth — the **funnel box count** and the **roster filter** both call it, so a bar's
number always equals the roster it links to.

### Lead types — read from the tag, not the Close column

Type comes from the tagger (`lead_cycles`), **not** `close_leads.reactivated_at`:

- **Direct** = `tagBecameDirect` — the lead self-booked a strategy-call link.
- **Setter** = not direct.
- **Reactivation** = `tagReactivatedAt` — a lead that lost / went cold on its spot.

**Direct and Setter partition the cohort. Reactivation cross-cuts both** (a Setter
lead that goes cold and is re-booked is Setter *and* Reactivation). This reverses the
old "reactivation ⊂ direct" framing — that invariant is gone. When the tag and the
legacy `reactivated_at` column disagree, **the tag wins** (the column is a legacy
backfill + the fallback for leads with no `lead_cycles` row only).

---

## High Ticket vs Digital College

- **High Ticket (HT)** — the AI Partner program. The default funnel is HT-only.
- **Digital College (DC)** — the low-ticket offer (Base44 + Wix, sold Monthly/Yearly),
  often a downsell.

**Closer identity routes everything** (migration 0076): `DC_CLOSER_NAMES = ("robby",)`
(Adam later) → DC funnel; everyone else (Aman = HT closer) → HT. Routing is read from
the **main closer EOC form** (`airtable_full_closer_report`), not the dedicated DC form.

- **DC showed** = a DC-closer form is *present* (Robby over-marks "Digital College
  Closed", so presence = showed; the outcome value is ignored).
- **DC closed** = a real plan is selected (`dc_plans`), origin `dc_closer`.
- **Downsells** (HT closer selling DC): `dc_close_origin = downsell_ht_meeting` (HT EOC
  with a DC plan) or `downsell_confirmation` (Closer Triage `call_status='Downsold'`).
  A downsell sets `dc_closed_at` but not `dc_booked_at`/`dc_showed_at`, stays
  HT-showed-not-HT-closed, and is credited to the **HT** closer.
- The tagger's `closed_at` / `close_type` are **HT-only**. **Robby's EOC forms are
  fully excluded from HT show/close** (not just his closes).
- `lead_cycles` DC columns (0076): `digital_college_at`, `dc_booked_at`, `dc_showed_at`,
  `dc_close_origin` (`dc_closed_at` pre-existed).

---

## Revival (separate campaign — not part of the main funnel)

The **DC Revival** re-engagement campaign. Leads carry `REVIVAL_CF`
(`cf_QivXkWBvr34UIDkUBKXNCQo6woarc62wEbIacWWbN7P`, "DC Revival Lead") — ~2,115 today.
They have no Typeform cycle, so they drop out of the cohort, the tagger, and every main
funnel. The **`/funnel/revival`** sub-page is the **only** surface that counts them, and
it reads **raw signals, no tagger**. Per-lead anchor = later of (`date_created`,
`2026-05-24 00:00 ET`); a signal counts only if its timestamp ≥ anchor.

Don't confuse **Revival** (this campaign) with **Reactivation** (a unique lead that lost
its strategy-call spot — a `lead_cycles` flag, part of the main funnel).

---

## Cash Collected / ROAS

A Cash block on the Funnel page, separate from the DC funnel. Two rows, each split
HT / DC / total:

- **Upfront** = `amount_paid_today`.
- **Contract** = `contract_amount_to_send` (closers leave `total_contract_amount`
  empty — key off `contract_amount_to_send`).
- **ROAS** = cash ÷ **Closer-Funnel adspend** (`Closer Funnel`-token campaigns in
  `cortana_campaign_daily`, per-day fallback to `meta_ad_daily` account total before
  2026-05-26).
- DC is priced at a flat **$300 per plan unit** (`DC_PLAN_PRICE_USD`), same upfront and
  contract.

---

## Table manifest

Which database tables are sales. (Per-column detail lives in `docs/schema/<table>.md`.)
This is the list the upcoming table audit works from.

### Sales — owned by this product

| Table | Holds | Read by |
|-------|-------|---------|
| `close_leads` | Close lead mirror — opt-in dates, `utm_term`, custom fields (REVIVAL_CF), `excluded_at` | cohort spine, roster, tagger, every funnel |
| `close_calls` | Close call activities — `duration`, `direction`, `user_id` | connected signal, dials, FMR, tagger |
| `close_sms` | Close SMS (inbound = FMR "responded") | FMR, revival funnel |
| `close_lead_status_changes` | status transition stream | tagger (legacy qualification) |
| `close_opportunities` | workflow markers ($1 placeholders, **not** money) | coarse signal, mostly unused |
| `close_custom_field_definitions` | `cf_*` id → name reference | reference |
| `lead_cycles` | **the unique leads list** — one row per opt-in cycle; type + DC columns | funnel, roster, per-lead, DC funnel, Cash |
| `lead_cycle_stages` | per-stage timestamps within a cycle (the funnel ladder) | funnel stage attribution, per-lead journey |
| `lead_tag_runs` | audit log of every tagger run (~69k rows) | tagger diagnostics, lead-tag-log page |
| `calendly_scheduled_events` | event mirror (filter by `name`) | closer drill, booking funnels, call typing |
| `calendly_invitees` | invitee mirror — `no_show`, `rescheduled`, `utm_term`, email | lead matching, reschedule counts |
| `calendly_event_types` | event-type reference (mostly not joined — retired URIs) | reference |
| `airtable_setter_triage_calls` | triage + confirmation forms — `call_status`, `form_type` | connected/confirmed/DQ, tagger, CEO flags |
| `airtable_full_closer_report` | closer EOC (US+AUS) — `call_outcome`, cash/plan fields | closer drill, showed/closed, Cash, DC routing, tagger |
| `airtable_digital_college_sales` | Robby's dedicated DC form | DC drilldown (Talent), per-lead DC |
| `typeform_responses` | opt-in event log (`SFedWelr`) | tagger universe, opt-in counting |
| `typeform_forms` | form/question reference | reference |
| `typeform_form_insights_snapshots` | periodic Typeform analytics snapshots | typeform insights cron |
| `meta_ad_daily` | account-level daily Meta spend (Cortana-fed) | Ads page, adspend fallback |
| `cortana_ad_daily` | per-ad daily attribution | Ads page |
| `cortana_campaign_daily` | per-campaign daily (HT `Closer Funnel` adspend source) | Ads, Cash/ROAS |
| `clarity_metrics_daily` | landing-page metrics (Microsoft Clarity) — ⚠️ **flagged for possible removal** | Landing Pages page + a cost-hub action |
| `wistia_media_daily` | per-day video stats (use the **timeseries** columns) | Landing Pages page |
| `wistia_medias` | video inventory reference | reference |
| `setter_call_reviews` | AI reviews of setter calls (Deepgram → LLM) | Talent, per-lead lifecycle |
| `setter_call_transcripts` | setter-call transcripts (Deepgram) | setter call reviewer, per-lead |

### Shared (sales reads, but fulfillment also uses)

| Table | Note |
|-------|------|
| `calls` | Fathom call records — sales uses `call_category='client'` rows for meeting-duration metrics; CSM uses it too |
| `team_members` | rep identities + access tiers — gates the dashboard, used elsewhere |
| `call_classification_history` | classification log for `calls` rows |
| `webhook_deliveries` | shared webhook-delivery audit log (~121k rows; all ingestion endpoints) |
| `oauth_tokens` | shared OAuth token store (Google, etc.) |

### Fulfillment / CSM / agent infra — **not sales**

`clients`, `client_health_scores`, `client_journey_stage_history`, `client_meetings`,
`client_standing_history`, `client_status_history`, `client_team_assignments`,
`client_upsells`, `calendar_events`, `call_action_items`, `call_participants`,
`nps_submissions`, `agent_feedback`, `agent_runs`, `alerts`, `escalations`,
`pending_digest_items`, `pending_ella_responses`, `slack_channels`, `slack_messages`,
`document_chunks`, `documents`, `director_tasks`,
`monthly_subscriptions`, `cost_extras`.

> These are candidates for the eventual `sales` Postgres schema move and for the
> "what can we delete" audit — but that audit is a later pass. This manifest is the
> starting inventory.
>
> **Verified against the live cloud DB 2026-06-11 — 56 public base tables, all
> accounted for.** Corrections from the first draft: there is **no `lead_tags` table**
> (that name was the tagger *code* at `lib/db/lead-tags.ts`); the lead model is three
> tables — `lead_cycles` + `lead_cycle_stages` + `lead_tag_runs`. Five sales tables were
> missing from the first draft and are now listed: `lead_cycle_stages`, `lead_tag_runs`,
> `typeform_form_insights_snapshots`, `setter_call_reviews`, `setter_call_transcripts`.
> Seven tables have **no `docs/schema/` file** yet: `lead_cycle_stages`, `lead_tag_runs`,
> `typeform_form_insights_snapshots`, `setter_call_reviews`, `setter_call_transcripts`,
> `call_classification_history`, `webhook_deliveries`.
>
> **Fathom for sales closing calls is NOT ingested yet** — wanted, absent. The only
> sales call-recording path today is the Deepgram **setter** pipeline (`setter_call_*`).
> The `calls` table is Fathom *client/CSM* calls, not closer calls.
</content>
