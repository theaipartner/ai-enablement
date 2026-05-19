# Table: `pending_digest_items`

## Purpose

Queue of Ella-flagged messages awaiting the daily digest DM. A row is
inserted whenever the decision Haiku sets `digest_flag=true` on a
message — on either the passive path (`agents/ella/passive_dispatch.py`)
or the reactive @-mention path (`agents/ella/agent.py`). The daily cron
(`api/ella_daily_digest_cron.py`) drains all unsent rows in a trailing
24h window, formats a digest, DMs it to Scott + an optional CC (Drake),
and stamps `sent_in_digest_at` so a row never re-sends.

This is a curated daily skim of "things worth Scott's eyes" — not an
escalation queue. The flagging criteria are deliberately permissive;
false positives are explicitly acceptable. Added by migration
`0040_pending_digest_items.sql` (spec:
`docs/specs/ella-architecture-refactor-and-daily-digest.md`).

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()` default |
| `agent_run_id` | `uuid` FK → `agent_runs(id)` ON DELETE CASCADE | Source run; deleting the run (rare — test cleanup) deletes the digest item |
| `slack_channel_id` | `text` NOT NULL | Triggering channel |
| `triggering_message_ts` | `text` NOT NULL | Triggering message Slack ts; half of the dedup key |
| `triggering_message_slack_user_id` | `text` | Author of the triggering message |
| `client_id` | `uuid` FK → `clients(id)` ON DELETE SET NULL | Digest survives a client deletion (audit-shaped) |
| `message_text` | `text` | Snapshot of the triggering message text |
| `haiku_decision` | `text` NOT NULL | The decision Haiku's decision. Free-text; current vocabulary `respond` / `acknowledge_and_escalate` / `skip` (the 2026-05-18-AM `respond_haiku_self` / `respond_via_sonnet` / `digest_only` values were superseded by the PM unified-path refactor; historical rows may carry the old values) |
| `haiku_reasoning` | `text` | Haiku's 1-2 sentence reasoning |
| `digest_category` | `text` | `question_program` / `emotional_human_needed` / `confusion` / `money_commitment` / `complaint` / `other`. Free-text (no enum CHECK) so categories can be added without a migration |
| `ella_responded` | `boolean` NOT NULL DEFAULT false | True when Ella is answering this message (Haiku self-answer or queued Sonnet) — the digest reads it as "Ella is handling this" |
| `sent_in_digest_at` | `timestamptz` | NULL until the cron sends it; set in one batch UPDATE post-send |
| `created_at` | `timestamptz` NOT NULL DEFAULT `now()` | Insert time; the digest window + display ordering key |
| `unanswered_posted_at` | `timestamptz` | Added by `0041`. Dedup key for the unanswered-message flagger. NULL = still eligible for the 2h check. Set when the flagger cron either posts the item OR marks it resolved-before-post. Independent of `sent_in_digest_at` |
| `unanswered_post_slack_channel_id` | `text` | Added by `0041`. Channel the unanswered post landed in. NULL together with a non-NULL `unanswered_posted_at` means "resolved before post" (a human responded inside the 2h window) |
| `unanswered_post_slack_ts` | `text` | Added by `0041`. Slack `ts` of the unanswered post (audit trail / future post-edit feature). NULL on resolved-before-post |

## Indexes

- `pending_digest_items_dedup_idx` — UNIQUE `(slack_channel_id, triggering_message_ts)`. The dedup key (same shape as `pending_ella_responses`): a re-processed message (Slack event redelivery, `message_changed`) doesn't double-flag. The insert helper swallows the unique-violation and continues.
- `pending_digest_items_unsent_idx` — partial index on `(created_at) WHERE sent_in_digest_at IS NULL`. The cron's drain query hits this; the partial predicate keeps it small as historical rows accumulate.
- `pending_digest_items_unanswered_scan_idx` — partial index on `(created_at) WHERE unanswered_posted_at IS NULL` (added by `0041`). The unanswered-flagger cron's 15-minute scan query hits this; the partial predicate keeps it small as posted/resolved rows accumulate.

## Relationships

- `agent_run_id` → `agent_runs.id` (CASCADE)
- `client_id` → `clients.id` (SET NULL)

## What populates it

- `agents/ella/passive_dispatch.py:insert_digest_item` (passive path; `_insert_pending_digest_item` adapter)
- `agents/ella/agent.py:_run` (reactive @-mention path, via the same `insert_digest_item`)

## What reads from it

- `api/ella_daily_digest_cron.py` — drains unsent rows, formats + sends the digest, marks them sent.
- `api/ella_unanswered_flagger_cron.py` — every 15 min, scans for rows aged past 2h with `unanswered_posted_at IS NULL` and no `team_member` message in the source channel since `created_at`; posts them to `#unanswered-channels` and stamps the `unanswered_*` columns. Independent of the daily digest's `sent_in_digest_at` state — the two surfaces don't conflict.

## Example queries

Unsent items in the last 24h, newest first:

```sql
SELECT created_at, slack_channel_id, digest_category, haiku_reasoning
FROM pending_digest_items
WHERE sent_in_digest_at IS NULL
  AND created_at >= now() - interval '24 hours'
ORDER BY created_at DESC;
```

Flag volume by category over the last 7 days:

```sql
SELECT digest_category, count(*)
FROM pending_digest_items
WHERE created_at >= now() - interval '7 days'
GROUP BY digest_category
ORDER BY 2 DESC;
```

Items that were flagged but Ella also answered:

```sql
SELECT created_at, slack_channel_id, haiku_decision
FROM pending_digest_items
WHERE ella_responded = true
ORDER BY created_at DESC
LIMIT 50;
```
