# `engagements`

One row per **engagement** — a rep's cluster of Close calls to a single lead that
collapse into one unit of work (back-to-back redials included) and expect **one
form**. The substrate for the missing-form Slack notifier and, later, call-review
/ coaching surfaces. Migration: `0086_engagements.sql`.

## The model — sticky tags, read the state (mirrors `lead_cycle_stages`)

Three tag columns are nullable timestamps, **set once and never cleared**. The
current state is derived by reading them — there is no `status` column:

- `final_at` set → **FINAL** (a form linked; pinging stopped).
- `overdue_at` set, `final_at` null → **OVERDUE** (45-min silence elapsed with no
  form; currently pinging every 15 min in business hours).
- `final_at` null (regardless of `overdue_at`) → still **owed** a form.

The 45-min freeze is implicit: a new call only joins an engagement whose
`last_call_at` is within 45 minutes, so once that gap passes (and `overdue_at` is
stamped) the call-set is frozen — a later call starts a NEW engagement.

## Columns

| column | type | notes |
|---|---|---|
| `id` | `uuid` | PK. |
| `lead_id` | `text` | Close lead (`close_leads.close_id`). |
| `rep_user_id` | `text` | Close `user_id` of the caller. The join key for rep identity. |
| `rep_name` | `text` | Denormalized caller name (`close_calls.raw_payload.user_name`). |
| `rep_slack_id` | `text` | Resolved via `team_members.close_user_id → slack_user_id`, for the @-mention. |
| `anchor_call_id` | `text` | The **≥90s** call that opened the engagement (`close_calls.close_id`). |
| `call_ids` | `text[]` | Every call that joined the rolling 45-min window (any duration). |
| `anchor_at` | `timestamptz` | Seed-call time — the "call at this time" shown in the ping. |
| `last_call_at` | `timestamptz` | Most recent call in the window; drives the 45-min freeze. |
| `opened_at` | `timestamptz` | **OPEN** tag — set on creation. |
| `overdue_at` | `timestamptz` | **OVERDUE** tag — set once when `last_call_at + 45min` passes with no form. |
| `final_at` | `timestamptz` | **FINAL** tag — set once when a form links. |
| `form_id` | `text` | Linked Airtable form `record_id` (null until final). |
| `form_table` | `text` | Which Airtable form table the form came from. |
| `last_pinged_at` | `timestamptz` | 15-min ping cadence bookkeeping. |
| `ping_count` | `integer` | Pings sent so far (visibility). |
| `created_at` / `updated_at` | `timestamptz` | Bookkeeping (`updated_at` via trigger). |

**Indexes:** `(lead_id, rep_user_id)` (webhook open/grow lookup) · partial
`(overdue_at) where final_at is null` (cron + accountability read) · GIN on
`call_ids` (call→engagement) · `(form_id) where form_id is not null`.

## Lifecycle — who writes what

- **OPEN / GROW — Close call webhook (real-time).** A ≥90s outbound call with no
  open engagement for `(lead, rep)` inserts one; any later call within 45 min of
  `last_call_at` appends to `call_ids` and bumps `last_call_at`. A <90s call only
  joins an already-open engagement.
- **OVERDUE — cron (~5 min).** Stamps `overdue_at` on non-final engagements past
  `last_call_at + 45min`.
- **FINAL — Airtable form webhook (real-time).** A new setter/closer triage form
  resolves filler → `rep_user_id` (via `team_members`), closes the **oldest** open
  engagement for `(lead, rep)` → `final_at` + `form_id`. No match → form is
  unlinked (review pile).
- **PING — cron (~5 min).** Overdue, non-final, business-hours (9am–10pm ET),
  ≥15 min since `last_pinged_at` → Slack ping; never gives up until a form lands.

## What reads it

- **Engagement page** — join `call_ids` back to `close_calls` for every call + the
  one linked form (the 1:1 view; per-rep coaching rollups aggregate over rows).
- **Accountability view** — `overdue_at` set, `final_at` null, grouped by rep.
- **Review pile** — forms with no engagement (`form_id` never linked; off-Close).

## Example queries

```sql
-- Currently owed (overdue, no form), by rep:
select rep_name, count(*) from engagements
where overdue_at is not null and final_at is null group by rep_name order by 2 desc;

-- A lead's engagements with their calls:
select id, anchor_at, array_length(call_ids,1) as calls, overdue_at, final_at, form_id
from engagements where lead_id = 'lead_xxx' order by anchor_at;
```
