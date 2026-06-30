# outbound_campaign_members

Resolved lead-id membership for a **roster (CSV) outbound campaign** — the
`outbound_campaign_roster` (email/phone CSV) matched against `close_leads` +
`ghl_contacts` and materialized to native lead ids. Added in migration `0119`.

Why materialize: the roster→lead match is the expensive part (scanning
`close_leads.contacts` jsonb + `ghl_contacts` by normalized email/phone). Doing it
once at upload (and on Re-tag) into this small table makes every refresh — and the
revival carve-out — a fast id lookup.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `campaign_key` | `text` | PK part. The roster campaign. |
| `native_id` | `text` | PK part. A `close_id` **or** a GHL contact id (matches `outbound_lead_facts.close_id`). |
| `source` | `text` | `'close'` or `'ghl'` (CHECK). Which mirror the id came from. |

Indexed on `native_id` (the revival carve-out joins on it).

## Populated by

`resolve_campaign_roster(p_campaign_key)` (migration 0119) — `DELETE` + `INSERT`:
- **Close:** a `close_lead` whose `contacts` jsonb has an email (lowercased) or
  phone (`outbound_norm_phone`: digits, 10→prepend 1, last 11) in the campaign's
  `outbound_campaign_roster`.
- **GHL:** a `ghl_contact` whose `email`/`phone` is in the roster.

Called by `api/outbound_campaign_refresh.py` with `resolve=true` — on CSV upload
(`createRosterCampaign`) and on the campaign's **Re-tag** button.

> A person present in **both** CRMs resolves to two members (one `close`, one
> `ghl`) and counts twice in that campaign — the same Close/GHL additive behavior
> as the revival catch-all. Cross-CRM dedup is not done (out of scope today).

## Read by

- `refresh_outbound_facts` **roster arm** (`is_roster` campaigns) — `leads` =
  `outbound_campaign_members` joined to `close_leads` (source=close) /
  `ghl_contacts` (source=ghl).
- The **revival carve-out** — the legacy arm deletes any `outbound_lead_facts` row
  whose `close_id` is a member of an active roster campaign, so a CSV lead lands in
  its own campaign **and** is removed from the revival catch-all.

## Example query

```sql
-- A roster campaign's resolved membership by source.
select source, count(*) from outbound_campaign_members
where campaign_key = $1 group by source;
```
