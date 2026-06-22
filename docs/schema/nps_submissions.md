# nps_submissions

NPS scores and free-text feedback from clients.

## Purpose

Capture promoter/detractor signal as structured data so CSM Co-Pilot can factor NPS into health scoring and route detractors into alerts immediately.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | PK |
| `client_id` | `uuid` | FK → `clients.id`, not null |
| `score` | `integer` | Not null. 0-10, enforced by check constraint |
| `feedback` | `text` | Optional free-text comment |
| `survey_source` | `text` | `slack_workflow`, `typeform`, ... |
| `submitted_at` | `timestamptz` | Not null. When the client submitted |
| `ingested_at` | `timestamptz` | When we captured it |
| `recorded_by` | `uuid` | Optional. The `team_members` row (or the Gregory Bot sentinel) that recorded the submission — set by the manual `NpsEntryForm` and by the Path 1 NPS RPC |

## Relationships

- FK to `clients`

## Populated By

- Slack ingestion: when an NPS submission comes through the Slack Workflow form, ingestion lands both a `slack_messages` row (with `message_subtype = 'nps_submission'`) and an `nps_submissions` row
- Future survey-tool ingestions

## Read By

- Dashboards: the manual `NpsEntryForm` writes to this table; the detail page surfaces individual submissions
- (Historical) Gregory brain V1.1 `latest_nps` signal read `score` from this table — **retired 2026-05-08**. The signal now reads from `clients.nps_standing` (Airtable mirror via Path 1 + the 0027 NPS-is-gospel auto-derive); see `agents/gregory/signals.py:compute_latest_nps`. This table stayed empty in production through M5 (Airtable Path 1 mirrors segment to `clients.nps_standing`, not numeric score to this table) — the V1 source-of-truth assumption was retired in favor of the column actually populated by production data.

## Future score-piping (V1.5)

Path 1's NPS-is-gospel RPC currently writes only the segment classification (`promoter` / `neutral` / `at_risk`) to `clients.nps_standing`, not the numeric 0-10 score. NPS score piping V1.5 would extend Path 1 to also write `nps_submissions` rows. Followup: see `docs/archive/historical/future-ideas.md` § Batch B.

## Example Queries

Most recent NPS per client:

```sql
select distinct on (client_id) client_id, score, feedback, submitted_at
from nps_submissions
order by client_id, submitted_at desc;
```

Detractors in the last 30 days:

```sql
select c.full_name, n.score, n.feedback, n.submitted_at
from nps_submissions n
join clients c on c.id = n.client_id
where n.score <= 6
  and n.submitted_at > now() - interval '30 days'
order by n.submitted_at desc;
```
