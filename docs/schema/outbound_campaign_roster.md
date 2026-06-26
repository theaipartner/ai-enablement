# outbound_campaign_roster

The membership list for **roster-based** outbound campaigns — the CSV of people a campaign targets, by
email and/or phone. Lets the tagger match a Close lead to a campaign (and set that campaign's Close custom
field) even when the lead is created later. Added in migration `0099_jacob_outbound_campaign.sql` for the
ECJ/Jacob reactivation; reusable for future roster campaigns.

> Not every campaign is roster-based. `revival` has **no** roster rows — its `DC Revival Lead` CF is set by
> the external Close SMS workflow. Only roster campaigns (e.g. `jacob`) have rows here.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `bigserial` | PK. |
| `campaign_key` | `text` | Which campaign this roster row belongs to (e.g. `'jacob'`). Matches `outbound_campaigns.key`. |
| `email` | `text` | Lowercased. Match key. |
| `phone` | `text` | Normalized — digits only, 11-char US (`1XXXXXXXXXX`). Match key. |
| `first_name` / `last_name` | `text` | From the CSV. **Not** used for matching (free-text, first-name-heavy, low quality — email/phone only). |
| `created_at` | `timestamptz` | Default `now()`. |

Indexes: `(campaign_key, email)` and `(campaign_key, phone)` for the tagger's lookups.

## What populates it

- A one-time CSV load per campaign (the ECJ roster for `jacob`). ~11k rows for Jacob.

## What reads it

- `shared/outbound_campaign_tag.py` (`tag_lead_outbound_campaigns`), hooked into `api/close_events.py`:
  on a new/updated Close lead, if its email **or** phone matches a campaign's roster and it isn't already
  tagged, it sets that campaign's `close_cf_id` in Close. Idempotent and fail-soft. Matching is **email
  then phone** — never name.

The roster is only for **tagging**. Once a lead is tagged, the funnel and per-rep aggregations key off the
Close CF (via `outbound_lead_facts`), not this table.
