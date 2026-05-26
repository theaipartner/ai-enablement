# Report: Appointment Setting stage of the Funnel page

**Slug:** appointment-setting
**Spec:** (inline prompt — local-only build, no spec file)

## What shipped

A new stage on the Funnel — `/sales-dashboard/funnel/appointment-setting` — that models the post-Calendly, pre-closer-meeting layer. Two parallel triage paths (Closer Triage / Setter Triage) with the same card shape, plus First Message Response, Speed-to-Lead per rep, and per-rep breakdown tables.

Files touched:

**Created**
- `lib/db/funnel-appointment-setting.ts` — full data layer. First Message Response from `close_sms`, Speed-to-Lead from `close_calls` + `close_leads.date_created/date_of_first_booked_call`, triage metrics from `close_calls` joined to `close_lead_status_changes` for outcome attribution.
- `docs/reports/appointment-setting.md` — this report.

**Modified**
- `lib/db/funnel-mocks.ts` — `STAGES` extended to three: `ads → landing-pages → appointment-setting`.
- `app/(authenticated)/sales-dashboard/funnel/page.tsx` — strip wires the new stage's headline (`total triage calls = closer triage calls + setter dials`).
- `app/(authenticated)/sales-dashboard/funnel/appointment-setting/page.tsx` — replaced the old mock-driven detail page with the new live one. Reuses the LP page's date-range picker.
- `scripts/sync_cloud_to_local.mjs` — extended to pull Close tables (`close_leads`, `close_calls`, `close_sms`, `close_lead_status_changes`) over a 45-day window so outcome lookbacks have runway.

## Gap analysis (the part you asked for first)

### Data inventory — cloud, last ~30 days

| Table | Rows | What it gives us |
|---|---|---|
| `close_leads` | 1,235 | Lead identity, tier, owner_id fields, lifecycle flags |
| `close_calls` | 2,273 | Per-call user_id + duration + activity_at (Tier-1 source) |
| `close_sms` | 5,896 | Direction split (Tier-1 source) |
| `close_lead_status_changes` | 2,999 | Outcome attribution (Tier-2 source) |
| `airtable_setter_triage_calls` | **5 total all-time** | Canonical outcome source per spec — adoption is 0% today |
| `airtable_full_closer_report` | **5 total all-time** | Same |

### Status pipeline (discovered, not all in schema docs)

The schema doc listed 11 statuses; the data probe found **three more not documented**:

| Status (label) | 30d events | In schema doc? | Used by this page? |
|---|---|---|---|
| Disqualified Lead | 313 | yes | yes — closer triage DQ + setter DQ buckets |
| In Sales Process | 187 | yes | no (not requested) |
| Lead Engaged | 145 | **no — newer** | no (you confirmed unused) |
| New Opt-in | 137 | yes | implicit (initial state) |
| Confirmed Booking | 77 | yes | yes — Closer "Confirmed booking" + Setter "Booked" |
| Unconfirmed Booking | 58 | yes | no (not requested) |
| Call Reactivation | 42 | **no — newer** | no (you confirmed Long-Term-FU is post-closer-call only) |
| Invalid | 19 | **no — newer** | no |
| Client | 7 | yes | no (closing territory) |
| No Show | 6 | yes | no (own future stage) |
| Unconfirmed Booking - Handed over | **5** | yes | yes — Closer "Hand-down" (provisional, sparse) |
| Deal Lost | 2 | yes | no |
| Downsell | 2 | yes | yes — Setter "Digital College" (provisional, sparse) |

### Metric → source mapping

#### Tier 1 — live, reliable (Close system-recorded)

| Metric | Source + derivation |
|---|---|
| **First Message Response** | `close_sms` — leads with ≥1 inbound after ≥1 outbound, ÷ leads with ≥1 outbound. Verified 51% on the 5/18–5/25 window. |
| **Speed to Lead (per setter)** | First outbound call by lead's `setter_owner_id` minus `close_leads.date_created`. Median + p90 per rep. Top setter (`user_cfGeZrn…`) median ~15m. |
| **Speed to Lead (per closer)** | First outbound call by lead's `closer_owner_id` minus `close_leads.date_of_first_booked_call`. Median + p90 per rep. Top closer (`user_8bvDMahh…`) median ~23h. |
| **Closer triage calls / connects / connect rate** | `close_calls` filtered to outbound + role-attributed. Connects = `duration > 0`. Both reliable. |
| **Setter dials / connects / connect rate** | Same as above on the setter side. |

#### Tier 2 — outcome splits via Close status flips (per your call: skip Airtable)

For each connected outbound call by setter/closer, look at the lead's next status change within **7 days** of the connect and bucket by `new_status_id`:

| Bucket | Status mapped | Confidence |
|---|---|---|
| Closer · Confirmed booking | flip to `Confirmed Booking` (`stat_dppO…`) | LIVE |
| Closer · Hand-down to setter | flip to `Unconfirmed Booking - Handed over` (`stat_GZca…`) | **PROVISIONAL — only 5 events in 30d**, hint shown inline on the card |
| Closer · Triage DQ | flip to `Disqualified Lead` (`stat_Sy5P…`) | LIVE |
| Setter · Booked | flip to `Confirmed Booking` | LIVE |
| Setter · Digital College | flip to `Downsell` (`stat_1uxT…`) | **PROVISIONAL — 2 events in 30d**, new pipeline (your note) |
| Setter · DQ | flip to `Disqualified Lead` | LIVE |
| Setter · Follow-up | **NO STATUS** — renders `—` with hint `"Airtable-only — not captured yet"`. Your call to keep the slot blank until the form adoption picks up. |

### The Airtable-form data-quality finding (the load-bearing one)

The forms are the canonical outcome source per your spec, but adoption is 0%:

| | Setter Triage Calls | Full Closer Report |
|---|---|---|
| Total rows all-time | 5 | 5 |
| Newest | 2026-05-25 00:12 | 2026-05-25 13:18 |
| Oldest | 2026-05-24 17:38 | 2026-04-06 20:54 |
| Form-completion rate among connected calls | **0.0%** (0 of 405 leads with a connected outbound call have a matching form row) | n/a |

The mirror cron is healthy (rows minutes old when fresh) — this isn't an ingestion gap, it's a process-adoption gap. You said you'd talk to Aman about the workflow. Wiring is via Close status flips for now; switching to Airtable forms later is a one-block change in `funnel-appointment-setting.ts`.

### Role-attribution design (the per-rep cut)

`close_leads.closer_owner_id` and `setter_owner_id` aren't reliably populated — only ~30% of leads in 30d have one or both set. Strict per-call attribution (call counts as setter only if `lead.setter_owner_id == call.user_id`) under-counts dramatically (initial render: 130 closer calls, 15 setter calls in 7d).

Switched to **hybrid attribution:**

1. **If the lead has an owner**, prefer that match (call's `user_id` against `closer_owner_id` or `setter_owner_id`).
2. **Else fall back to the user's global role** — the union of all closer_owner_id values vs. setter_owner_id values across all leads. A user that appears as setter-only globally has every unowned call counted as a setter dial.
3. **Users in BOTH global roles** (7 users — almost certainly the dual-hat folks like Aman) fall back to "unclassified" when the lead is unowned, so we don't guess wrong.

After the switch: 130 closer / **480 setter** for the same 7-day window. Matches expected order-of-magnitude (the top setter `user_cfGeZrn…` makes 700 calls / 30d).

Hybrid approach is documented inline in the code; if you want strict-only, it's a 5-line revert.

### What's NOT in this page (intentionally)

- ~~Long-Term Follow-Up bucket~~ — per your update, removed from both closer and setter triage; saved for post-closing-call only
- ~~Lead Engaged status~~ — confirmed unused
- Per-rep scorecards — your note that "full per-person scorecards live on the People page; here it's the stage-level aggregate + this stage's rep breakdown." Done.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run dev` — all routes return 200 across various date ranges (`?start=&end=`).
- Headline FMR: 51% for 5/18–5/25 (255 inbound after outbound, 500 outbound). Sane.
- Closer triage card: 130 calls / 113 connects / 87% rate for the same range.
- Setter triage card: 480 dials / 400 connects / 83% rate for the same range.
- Per-rep tables populate with 4 real user_ids (`user_cfGeZrn…`, `user_8bvDMahh…`, `user_8emMm6DZ…`, `user_GbwlACN…`) with sensible volume distribution.
- Speed-to-Lead per rep shows realistic numbers (setter median ~15m, closer median ~23h — closer clock-start being booking explains the much-longer gap).

Not run: live cloud render. Local dev only.

## Surprises and judgment calls

- **Owner attribution is the biggest design call** in this page. The hybrid approach is defensible but it does mix per-call routing with global role assumptions; please verify against your operational reality. If you want stricter attribution at the cost of smaller numbers, easy revert.
- **Status-flip attribution window: 7 days post-connect.** Picked because it gives flips time to land but doesn't dilute by long-tail events. If a setter's lead gets a Disqualified flip 14 days after the call, it currently doesn't count toward that setter's DQ. Reasonable threshold to discuss.
- **User names not resolved.** No `close_users` mirror table; per-rep tables show truncated `user_xxx…` ids. A small mirror table would fix this; out of scope for this pass.
- **The `Follow-up` cell rendering as `—`** is intentional, not a bug. Drake's directive: "render it but leave it blank" until Airtable form adoption is real.
- **Headline metric is FMR, not triage volume.** I picked First Message Response as the page headline because it's the highest-funnel reliable metric. Triage volume sits in the two parallel cards below. Reasonable but a judgment call — easy to flip if you want triage volume up top.

## Out of scope / deferred

- **Airtable form data path** — wired stub but currently empty. Switch once adoption stabilizes.
- **Close user-name resolution** — would make per-rep tables much nicer to read. Future.
- **Per-rep speed-to-lead histograms** — only median + p90 today. Could add 14-day trend per rep.
- **Hand-down → setter triage edge case** — current model counts a closer's hand-down call AND the subsequent setter's first call as separate entries on each card. Probably fine, but worth eyeballing once data volume grows.
- **`In Sales Process` / `Call Reactivation` / `Invalid` statuses unused** — could become "what happens to leads after triage" follow-on stages.

## Side effects

- **Local DB writes** via `scripts/sync_cloud_to_local.mjs`: synced 1,574 close_leads, 3,222 close_calls, 8,195 close_sms, 3,536 close_lead_status_changes (last 45d window).
- **No cloud writes.** No commits. No external API calls beyond the cloud-Supabase reads.
