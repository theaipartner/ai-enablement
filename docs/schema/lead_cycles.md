# lead_cycles

The tagging system's per-cycle identity table. **One row per opt-in cycle** for
every lead in the **unique leads list** (a lead can have >1 row = a re-opt-in).
Written by `shared/lead_tagging.py`; read via `lib/db/lead-tags.ts`. The HT
funnel, roster, per-lead journeys, and the DC funnel all read from here.

## Universe — `lead_cycles` IS the unique leads list

A lead gets cycles iff **all** hold (`shared/lead_tagging.py`):
- `date_first_opted_in >= EFFECTIVE_DATE` (`2026-05-24`) — **originally** opted
  in on/after the horizon (returning leads who first opted in earlier are out).
- A **Typeform SFedWelr** match by email/phone (no match → no cycle; the old
  `close_fallback` path was removed).
- Not revival-tagged (`REVIVAL_CF`), not soft-hidden (`excluded_at`).

So `lead_cycles` == the unique leads list. Surfaces scope by querying it directly.

## Columns

| Column | Type | How it's determined |
|--------|------|---------------------|
| `close_id` | `text` | The lead (Close PK). PK with `opt_in_at`. |
| `opt_in_at` | `timestamptz` | The cycle anchor — a Typeform SFedWelr submission time (deduped to the minute). |
| `opt_in_seq` | `integer` | 1, 2, 3… order of the lead's cycles. `seq > 1` = a re-opt-in. |
| `source` | `text` | Always `typeform` now (close_fallback retired). |
| `became_direct_at` | `timestamptz` | Earliest "Ai Partner Strategy Call" Calendly self-book, only if at/before `reactive_at`. |
| `reactive_at` | `timestamptz` | Lost-the-spot moment: earliest of cold (>3-day contact gap, no active future booking) or partnership re-book. Blocked if a dq/close happened at/before it. |
| `reactive_source` | `text` | `cold` \| `partnership_rebook`. |
| `dq_at` | `timestamptz` | Earliest DQ: triage / confirmation / closer-EOC / DC `Follow Up? = No`. |
| `dq_source` | `text` | `triage` \| `confirmation` \| `closer_eoc` \| `dc_followup_no`. |
| `dc_closed_at` | `timestamptz` | A Digital College sale closed (any origin). See § DC. |
| `digital_college_at` | `timestamptz` | **(0076)** Earliest DC signal in the cycle — "when they went DC". HT stages naturally stop here. |
| `dc_booked_at` | `timestamptz` | **(0076)** DC-closer funnel: a DC call was booked (or back-filled from a DC-closer show/close). |
| `dc_showed_at` | `timestamptz` | **(0076)** DC-closer funnel: a DC-closer form is **present** (showed). NOT outcome-based. |
| `dc_close_origin` | `text` | **(0076)** Where the DC close came from: `dc_closer` \| `downsell_ht_meeting` \| `downsell_confirmation`. |
| `created_at` / `updated_at` | `timestamptz` | Bookkeeping. |

Per-phase **stages** (connected/booked/confirmed/showed/closed, HT) live in the
sibling `lead_cycle_stages` (one row per `phase` = `primary` | `reactive`).

## Digital College — closer-identity routing (Drake 2026-06-05)

A form's funnel is decided by **who the closer is**: DC closers (`DC_CLOSER_NAMES`
= `robby`, +Adam later) → DC funnel; everyone else (Aman) → HT funnel. An HT
closer can dip into DC via a downsell; a DC closer never touches HT. Sourced from
the **main closer EOC form** (`airtable_full_closer_report`), not the DC-sale form.

- **`dc_showed_at`** — a DC-closer form is *present* (Robby files "Digital College
  Closed" on everything, so the outcome is ignored; presence = showed).
- **`dc_closed_at` (origin `dc_closer`)** — a DC-closer form with a **real plan**
  (`dc_plans`, the "What plan did we get them on?" field), not the close *output*.
- **Downsells** (HT closer): `dc_close_origin` = `downsell_ht_meeting` (HT-closer
  EOC with a DC plan) or `downsell_confirmation` (Closer Triage `Downsold`). A
  downsell wins over `dc_closer` for the origin; it sets `dc_closed_at` but **not**
  `dc_booked_at`/`dc_showed_at` (not in the main DC funnel — shown on the downsell
  line, credited to the HT closer).

## Source / migrations

`shared/lead_tagging.py` (the only writer). Migrations: 0063 (`reactivated_at` on
close_leads), 0064/0065 (`tag_reactivated_leads`), the original `lead_cycles` /
`lead_cycle_stages` creation, and **0076** (DC funnel columns above).

## What reads from it

`lib/db/lead-tags.ts` (`getLeadCycleRows`, `getLeadCycles`) → the HT funnel
(`leads-funnel.ts`), roster, per-lead journey; `lib/db/funnel-dc.ts` (`getDcFunnel`)
→ the funnel-page DC section. Spec: `docs/specs/dc-funnel-closer-routing.md`.
