# typeform_responses

Per-submission mirror of Typeform form responses. One row per opt-in / lead form submission. Idempotent on `response_id`.

## Purpose

The lead stream. Top-of-funnel opt-ins flow in via webhook (real-time, primary) + cron backstop (last-N-hours safety sweep) + full-history backfill. The future sales dashboard reads from this table to show closers fresh leads + slice the funnel by question / time / attribution.

This is **NOT client data**. No `clients` resolution, no identity-matching, no auto-creation of client rows from a Typeform response. Lead → client mapping (if it ever happens) is a separate future arc.

Volume today: ~10k responses on the active Setter Funnel (`PWSNd0h2`), ~430 on the active Closer Funnel (`SFedWelr`), 2,528 on the dormant `w0atrvMi`, several hundred on inactive variants. ~14k responses total backfillable; ~5-10 net new per day at current funnel volume.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `response_id` | `text` | PK. Typeform's stable response identifier. Equal to Typeform's `token` field — we mirror as one column with the semantic name. |
| `form_id` | `text` | LOOSE FK to `typeform_forms.form_id`. Aggregation left-joins; FK is a soft pointer, not enforced. |
| `landed_at` | `timestamptz` | When the respondent arrived at the form. |
| `submitted_at` | `timestamptz` | When the respondent hit submit. Primary time-axis for funnel queries. |
| `metadata` | `jsonb` | Browser / UA / referer fingerprint. Keys: `browser, network_id, platform, referer, user_agent`. Useful for de-bot / channel inference. |
| `hidden` | `jsonb` | Marketing-attribution payload — string→string map of (utm_*, ad_id, ad_name, adset_id, campaign_id, fbp, fbc, ip, event_id, funnel). Keys are a subset of the parent form's `typeform_forms.hidden_fields`. |
| `calculated` | `jsonb` | Typeform's calculated payload, e.g. `{"score": 0}`. Mirrored for forward-compat with forms that use Typeform scoring logic. |
| `answers` | `jsonb` | Raw `answers[]` array. Each entry is type-tagged: `{ field: { ref, id, type }, type: "<answer-type>", "<answer-type>": <value> }`. Answer-type ∈ `{ choice, choices, email, text, long_text, phone_number, number, boolean, date, url, ... }`. **Contains raw PII.** |
| `ingested_at` | `timestamptz` | When this row first landed (default `now()`). |
| `created_at` / `updated_at` | `timestamptz` | Standard. `updated_at` trigger via `set_updated_at()`. |

## PII posture (§ PII)

Mirror raw. Emails + phones + free-text names live in `answers` as their original values. Respondent IPs live in `hidden.ip`. Rationale: the data already exists in Typeform's DB so the mirror creates no new exposure; Supabase is service-role-only.

**Test fixtures and the discovery report mask all PII to `<redacted-*>` placeholders. Only the mirror DB stores raw.**

## Indexes

- PK on `response_id`.
- `typeform_responses_form_submitted_idx (form_id, submitted_at DESC)` — per-form recency queries (e.g. "latest opt-ins on Setter Funnel").
- `typeform_responses_submitted_idx (submitted_at DESC)` — cross-form recency (e.g. "all opt-ins in the last N days").

## Idempotency

`UPSERT ON CONFLICT (response_id)`. Webhook → cron-backstop → backfill all converge on the same upsert. Double-write is a no-op; field-by-field overwrite is acceptable (Typeform-side responses are immutable once submitted).

## What populates it

- **Webhook (primary):** `api/typeform_events.py` on every `form_response` delivery. Verifies HMAC-SHA256/base64 signature, calls `upsert_response_from_webhook`.
- **Cron backstop:** `api/typeform_sync_cron.py` every 15 min, re-walking the last 6 hours of submissions via `since=` filter. Catches anything the webhook missed.
- **Backfill:** `scripts/backfill_typeform.py --apply` walks every form's full history via cursor pagination.

## What reads from it

Future sales dashboard / aggregation layer. Lead stream surfaces here.

## Cursor pagination quirk (load-bearing)

The Typeform Responses API rejects `before`/`after` cursor params when combined with `sort` — returns HTTP 400 `BAD_REQUEST: "can't use before/after param together with sort"`. Default sort is `submitted_at desc`, which is what cursor backfill wants. `ingestion/typeform/client.py:list_responses` MUST never include a `sort` param when cursor-paginating. Documented inline (in the client + the spec + this doc) because someone "tidying up" the client by adding `sort=submitted_at,desc` will break the backfill.

## Example queries

Last 24 hours of opt-ins, newest first:
```sql
SELECT response_id, form_id, submitted_at, hidden ->> 'utm_source' AS source
FROM typeform_responses
WHERE submitted_at > now() - interval '1 day'
ORDER BY submitted_at DESC;
```

Per-funnel daily volume:
```sql
SELECT form_id, date_trunc('day', submitted_at) AS day, count(*)
FROM typeform_responses
WHERE submitted_at > now() - interval '30 days'
GROUP BY 1, 2
ORDER BY 2 DESC, 1;
```

Extract one specific answer (the "monthly income" question, by its stable field ref):
```sql
SELECT
  response_id,
  submitted_at,
  ans -> 'choice' ->> 'label' AS income_bracket
FROM typeform_responses,
     jsonb_array_elements(answers) AS ans
WHERE ans -> 'field' ->> 'ref' = 'bd4e0524-e136-4590'   -- "What's your monthly income?"
ORDER BY submitted_at DESC
LIMIT 50;
```

Attribution breakdown by utm_source over the last 7 days:
```sql
SELECT
  hidden ->> 'utm_source' AS source,
  count(*)                AS n
FROM typeform_responses
WHERE submitted_at > now() - interval '7 days'
  AND form_id = 'PWSNd0h2'
GROUP BY 1
ORDER BY n DESC;
```
