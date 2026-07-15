# airtable_digital_college_sales

Mirror of the Airtable **Digital College** sale form (`tbljmzRoMoE5B26lt`)
in the sales base `appCWa6TV6p7EBarC`. This is the **low-ticket** offer
("Digital College" = Base44 + Wix). Populated by the Airtable ingestion
pipeline (webhook receiver + 15-min cron backstop) — the SAME pipeline as
the other two Airtable mirrors. The Airtable record id is the primary key;
`fields_raw` holds the complete field set.

The dedicated low-ticket closer **Robby Bryant** fills this form end-to-end
(he is booked by setters and also self-sets). Aman's **downsell** Digital
College closes — sold on the high-ticket call — continue to live on
`airtable_full_closer_report` (`call_outcome = 'Digital College Closed'`),
NOT here. So a lead's DC close can originate from either table.

## Close model

- **`closed` = `Yes`** is the explicit close flag.
- **`plans`** gives the per-product breakdown: `Base Monthly` / `Base Yearly`
  / `Wix Monthly` / `Wix Yearly`. "Base" = **Base44**. A close can include
  Base, Wix, or both; each is monthly *or* yearly.
- **There is no no-show field on the form.** Show/no-show is derived
  downstream: a filed DC form = the prospect **showed**; a Robby Calendly
  meeting that has passed with **no** DC form = a **no-show** (until a form
  lands). A close ⇒ also counts as connected + booked + showed.

## Columns

| Column | Type | Source field | Notes |
|---|---|---|---|
| `record_id` | text PK | record id | Airtable `rec…` id. |
| `airtable_created_at` | timestamptz | `createdTime` | Record-level metadata (no in-form created field). |
| `lead_id` | text | `Lead ID` | Close `lead_*`. Join key to `close_leads`. URL-paste tolerant. |
| `prospect_name` | text | `Prospect Name` | |
| `date_time_of_call` | timestamptz | `Date & Time of Call` | The DC call time. |
| `closer_record_ids` | text[] | `Closer Name` | Airtable `rec…` ids (link). |
| `closer_names` | text[] | `Name (from Closer Name)` | Resolved inline — e.g. `["Robby Bryant"]`. No id→name resolver needed. |
| `setter_record_ids` | text[] | `Setter` | Airtable `rec…` ids (link). |
| `setter_names` | text[] | `Name (from Setter)` | Resolved inline — e.g. `["Connor"]`, `["Aman Ali"]`. |
| `closed` | text | `Closed?` | `Yes` / `No`. The explicit DC close flag. |
| `plans` | text[] | `What plan did we get them on?` | Base/Wix × Monthly/Yearly multi-select. |
| `follow_up` | text | `Follow Up?` | `Yes` / `No`. |
| `follow_up_date` | date | `Follow Up Date` | |
| `call_notes` | text | `Call Notes` | |
| `fields_raw` | jsonb | (all fields) | Complete field set — source of truth. |
| `excluded_at` | timestamptz | — | Soft-hide (creator-only). NULL = visible. Never written by ingestion. |
| `excluded_by` | text | — | Who hid the row. |
| `created_at` | timestamptz | — | Row insert time (mirror). |
| `updated_at` | timestamptz | — | Row update time (mirror). |

## What populates it

`ingestion/airtable/parser.py` → `parse_digital_college` (projection), wired
into `TARGET_TABLES` (`ingestion/airtable/__init__.py`) + `_parse_for_table`
(`ingestion/airtable/pipeline.py`). The webhook watches the whole base and
filters to `TARGET_TABLES` in the receiver, so this table needed **no**
webhook re-registration. Initial population + post-migration re-sync:
`python -m ingestion.airtable.backfill`.

## What reads it

The sales dashboard low-ticket surfaces: Robby's per-rep drilldown on
`/sales-dashboard/people` (Talent), the Leads roster + per-lead Journey /
Lifecycle / close-details (close-type = Digital College), and the Funnel
page closes split (ht/dc). Joined to `close_leads` by `lead_id`.

Since 0127 also the **DC Ads funnel**: `refresh_dc_ads_facts()` derives
`dc_ads_lead_facts.showed/closed/plan_*` from this table (unioned with the
closer report — since the program suspension this form is where DC-ads
pitches are actually filed), and `dc_ads_funnel_by_rep()` credits closes/cash
via `closer_record_ids` → `team_members.airtable_user_id`. A closer missing
from `team_members` shows as an unmerged nickname row on the page's by-rep
table.
