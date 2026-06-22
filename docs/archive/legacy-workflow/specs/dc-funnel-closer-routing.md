# Spec: DC funnel + closer-identity routing + downsell tracking

**Slug:** dc-funnel-closer-routing
**Status:** shipped 2026-06-05 — data layer (migration 0076 + tagger + retag) and
the funnel-page DC section + downsell line are live and verified (HT funnel
unchanged: connected 137 / confirmed 27 / showed 11 / closed 2; DC: 16 booked /
9 showed / 4 closed). **Deferred:** the Talent-page HT-closer "downsell closes"
stat (§6) — 0 downsells in the current unique-leads window, so nothing to render
or verify yet; build it when the first real downsell lands.

## Goal

Make Digital College (DC) a first-class, tag-driven funnel — symmetric with the
HT funnel — driven by **closer identity**, with explicit tracking of where each
DC sale came from (the DC closer vs an HT-closer downsell). Everything reads from
`lead_cycles` / `lead_cycle_stages`, unique leads only.

Three pieces:
1. A `digital_college_at` marker (when a lead went DC) + DC funnel stages on the cycle.
2. The funnel page renders a **main DC funnel** (DC closer) + a **downsell line** below it.
3. HT-closer downsell closes are credited to the **HT closer's stats** (his work), while never becoming an HT *close*.

---

## 1. Closer roles (the unifying rule)

A form's funnel is decided by **who the closer is**:
- **DC closers:** Robby (+ Adam, details TBD). A one-line constant: `DC_CLOSER_NAMES = ("robby",)` (lowercase substrings; add `"adam"` later).
- **HT closer:** anyone who is NOT a DC closer (Aman + future). HT is the default; DC is the named exception.

`is_dc_closer(closer_names)` = any name contains a `DC_CLOSER_NAMES` token.

This generalizes the Robby-exclusion already shipped: **DC-closer forms feed the DC funnel; HT-closer forms feed the HT funnel.** Robby can never touch HT; Aman can dip into DC (downsells, §4).

---

## 2. The HT funnel — UNCHANGED

No behavior change. It already does what we want after the Robby fix:
- **HT showed** = an HT-closer (Aman) EOC meeting that happened (outcome not cancel/ghost/reschedule) — *includes downsells* (the meeting genuinely happened).
- **HT closed** = an HT-closer EOC with `High Ticket Closed` (NOT a downsell — that's a DC product).
- A Robby-routed lead (no HT meeting) never gets an HT show — the routing handles the cutoff.

`digital_college_at` (below) is the explicit marker of when the lead pivoted to DC; HT stages naturally stop there because the DC-side forms are routed away from HT.

---

## 3. Data model — migration on `lead_cycles`

`dc_closed_at` already exists. Add:

| Column | Type | Meaning |
|---|---|---|
| `digital_college_at` | `timestamptz` | Earliest DC signal in the cycle — "when they went DC". |
| `dc_booked_at` | `timestamptz` | **DC-closer funnel:** a DC call was booked (or back-filled from a DC-closer show/close). |
| `dc_showed_at` | `timestamptz` | **DC-closer funnel:** a DC-closer (Robby) form showed (or back-filled from a DC-closer close). |
| `dc_close_origin` | `text` | For a DC close: `dc_closer` \| `downsell_ht_meeting` \| `downsell_confirmation`. Null if no DC close. |

`dc_booked_at` / `dc_showed_at` are populated **only on the `dc_closer` path** (Robby's funnel). Downsells get `dc_closed_at` + a downsell `dc_close_origin`, with `dc_booked_at`/`dc_showed_at` left null (they never went through Robby's booked→showed funnel — their "show" was the HT meeting, counted on the HT side).

> **Migration is a gate (a):** I'll show you the exact `ALTER TABLE` SQL before applying (psycopg2 + manual ledger + dual-verify per the runbook).

---

## 4. Tagger determination (`shared/lead_tagging.py`)

All signals scoped **in-cycle** (`opt_in_at <= t < cyc_end`), per the existing pattern. Times use event-or-filed where a form has both.

**Source signals collected per cycle:**
- **DC booking (dc_closer path):** a **Setter** Triage `Digital College booking` status (the setter booked a DC call → Robby). *(28 in the data.)*
- **DC-closer forms:** any closer EOC form where `is_dc_closer(closer_names)` (Robby). *(Shows = non-cancel/ghost/reschedule; closes = `dc_plans` present / `Digital College Closed`.)*
- **DC sale form:** `airtable_digital_college_sales` (Robby's dedicated form) — a filed form = showed, `Closed=Yes` = a close.
- **HT-meeting downsell:** an **HT-closer** (non-DC) EOC with a DC outcome (`Digital College Closed` or `dc_plans` present). *(2 in data; 1 real.)*
- **Confirmation downsell:** a **Closer Triage Form** (confirmation) with `call_status = 'Downsold'` (Aman downsold at confirmation). *("Downsold" is a live option on the form today; 0 real calls have landed on it yet, so 0 in the data so far.)*

**`digital_college_at`** = earliest (in-cycle) of: DC booking · any DC-closer form · DC sale form · HT-meeting downsell · confirmation downsell.

**DC-closer funnel (main):** — **NB (Drake): don't trust Robby's outcome field, he marks "Digital College Closed" on everything. Showed = the form is present; Closed = the plans are actually there.**
- `dc_showed_at` = earliest DC-closer form **present** in-cycle (a filed Robby EOC or DC-sale form = the meeting happened). NOT outcome-based.
- `dc_closed_at` (origin `dc_closer`) = earliest DC-closer form with **`dc_plans` actually populated** (the "What plan did we get them on?" field) — a real plan, not the "Digital College Closed" output.
- `dc_booked_at` = earliest DC booking signal (Setter `Digital College booking` or a DC-closer form present), **back-filled** by `dc_showed_at`/`dc_closed_at`.
- Monotonic, same back-fill style as HT: `closed → showed → booked`.

**Downsell closes (HT closer):** set `dc_closed_at` + `dc_close_origin`:
- `downsell_ht_meeting` — an HT-closer EOC with **`dc_plans` populated**. `dc_closed_at` = that form's time.
- `downsell_confirmation` — a Closer Triage `Downsold`. `dc_closed_at` = that form's time.
- Downsells do **not** set `dc_booked_at`/`dc_showed_at` (not in the main DC funnel).

**Origin precedence** (if a lead somehow has more than one DC-close signal — rare): a downsell signal (HT-meeting, then confirmation) wins over `dc_closer`, because the sale *originated* from the HT closer's downsell even if Robby physically processed it. **⚠️ ASSUMPTION TO VERIFY:** that a confirmation `Downsold` represents the DC *close* (origin), not just a routing to a later Robby close. Confirm once real "Downsold" data exists.

**HT cutoff:** because DC-side forms are routed away from HT (closer identity), HT stages already stop at `digital_college_at` with no extra code. The marker is for visibility + DC scoping. (If we ever see a stray post-DC HT signal leaking in, we add an explicit `t < digital_college_at` guard to the HT stage build — not expected to be needed now.)

---

## 5. Funnel page — DC section

**Main DC funnel** (DC closer = Robby/Adam), three stages from the tags, unique leads only:
- **DC Booked** = `count(dc_booked_at)` · **DC Showed** = `count(dc_showed_at)` · **DC Closed** = `count(dc_closed_at where origin='dc_closer')`, with the Base44/Wix Mo/Yr plan breakdown (from `dc_plans`, the "What plan did we get them on?" field).

**Downsell line — directly below:** "Extra DC closes — HT closer", split into:
- **Confirmation downsell** = `count(origin='downsell_confirmation')`
- **HT-meeting downsell** = `count(origin='downsell_ht_meeting')`
- with the same plan breakdown.

Total DC sales = main DC closed + downsell closes, shown separately, never double-counted.

The existing all-time `funnel-dc-sales.ts` tally is superseded by this tag-driven, unique-leads version (or rescoped to read the new fields). **To confirm with Drake:** drop the old EOC-sourced tally entirely, or keep it as a separate "all-time incl. pre-horizon" view?

---

## 6. HT-closer downsell stats

On the Talent/closer surface, the HT closer (Aman) is **credited** for his downsell closes (`origin IN (downsell_ht_meeting, downsell_confirmation)`) as a distinct "Downsell closes" stat — his work, surfaced on the HT side — while it stays a **DC product** and never counts as an HT *close* in the funnel.

---

## 7. Files touched (planned)
- **Migration:** `supabase/migrations/00NN_lead_cycles_dc_funnel.sql` (ALTER `lead_cycles`). Gate (a).
- **`shared/lead_tagging.py`:** `DC_CLOSER_NAMES` + `is_dc_closer`; DC signal collection; `digital_college_at`, `dc_booked_at`, `dc_showed_at`, `dc_close_origin`; write them in `cycle_rows`. Full `--apply` retag after.
- **`lib/db/lead-tags.ts`:** expose the new fields on `LeadCycleRow` / `LeadCycle`.
- **`lib/db/leads-funnel.ts`** (or a new `funnel-dc.ts`): the main DC funnel + downsell line aggregation from the tags.
- **`components/sales/funnel-stack.tsx`** (or sibling): render the DC funnel + downsell line.
- **`lib/db/funnel-dc-sales.ts`:** rescope/retire per §5 decision.
- **Talent:** HT-closer "Downsell closes" stat.
- **Docs:** update `docs/schema/` for the new `lead_cycles` columns + the architecture doc.

## 8. Verification
- Migration dual-verified (schema + ledger) against cloud.
- Post-retag: DC main funnel reads the 6 Robby closes / 28 bookings; downsell line reads the 1 real HT-meeting downsell (`lead_2g0F…`); test lead excluded.
- HT funnel numbers unchanged (130/27/11/2).
- Monotonicity: dc_closed ⊆ dc_showed ⊆ dc_booked (main funnel).

## 9. Open items for Drake to verify
1. **Confirmation downsell = the DC close** (origin), per §4 precedence — the "Downsold" status exists on the form today but has no real calls yet; confirm the interpretation holds once the first ones land.
2. **Old DC tally (`funnel-dc-sales.ts`):** retire, or keep as an all-time/pre-horizon view alongside the new one (§5)?
3. **Adam:** DC-closer identifiers to add to `DC_CLOSER_NAMES` (you'll provide later).
4. **Downsell breakdown scope:** confirmed as **closes** only (not booked/showed) — restate if you also want a downsell "showed".
