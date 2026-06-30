# Runbook: Ella daily digest cron

## What it is

`api/ella_daily_digest_cron.py` — a daily Vercel Cron that posts to the
`#daily-digest` Slack channel a curated skim of every message Ella's
decision Haiku flagged in the trailing 24h. It is a *visibility* surface,
not an escalation queue: false positives are explicitly fine; the team
scans it for things worth a second look.

Every flagged message is a `pending_digest_items` row
(`docs/schema/pending_digest_items.md`), written when the decision
Haiku set `digest_flag=true` on either the passive path
(`agents/ella/passive_dispatch.py`) or the reactive @-mention path
(`agents/ella/agent.py`). The cron drains all unsent rows in the
window, formats a body, posts one message to `#daily-digest` (+ one
`webhook_deliveries` audit row), then marks every drained row
`sent_in_digest_at = now()` in a single UPDATE.

## Schedule

`30 20 * * *` UTC = **16:30 EDT / 15:30 EST** (fixed-UTC, seasonal
drift — same convention as every other fixed cron, see ADR 0003 and
`docs/runbooks/cron_schedule.md`). The instant is fixed; the wall-clock
ET hour shifts one hour across the DST boundary.

## Destination

Posts to the `#daily-digest` channel, resolved from
`ELLA_DAILY_DIGEST_CHANNEL_SLACK_ID` (required — if unset the cron writes a
config-gap audit row and returns without posting). The bot must be a member
of the channel.

*Historical: before the 2026-05-28 channels-only redesign this cron DMed the
head CSM + an optional CC (`ELLA_DAILY_DIGEST_CC_SLACK_USER_ID`). All Ella DMs
were retired; that CC var is now dead.*

## Body shape

```
:mag: *Ella's daily flags — May 18, 2026*

3 flagged messages across 2 clients.

*Acme Co*
• 14:02 ET — I'm pretty frustrated, thinking about cancelling
    Ella's read: money_commitment — client raised cancellation, no KB anchor
    <https://slack.com/archives/C1/p1745...>

*Beta Inc*
• 09:15 ET — where do I find the sales-call lesson?
    Ella's read: question_program — clean program question
    <https://slack.com/archives/C2/p1745...> [→ Ella responded]
```

Empty day: `:mag: *Ella's daily flags — <date>*` then `No flags
today.` It still fires — silent failure (cron didn't run) is worse
than empty success. Bodies over 35k chars truncate with a generic
`(… more flagged messages truncated)` footer (Slack's hard limit is
40k). The truncation footer previously pointed at the `/ella/runs`
audit page; that pointer was dropped 2026-05-24 when the audit page
was removed.

## Manual fire / backfill

```
curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://ai-enablement-sigma.vercel.app/api/ella_daily_digest_cron"
```

`?since=<iso_timestamp>` overrides the default 24h window (use for
backfill — e.g. `?since=2026-05-17T00:00:00Z`). Unparseable `since`
falls back to 24h with a logged warning. First production fire is via
manual curl.

## How to verify a fire

```sql
-- Per-recipient delivery audit for today's run.
SELECT processing_status, processing_error,
       payload->>'recipient_label'  AS recipient,
       payload->>'message_count'    AS msg_count
FROM webhook_deliveries
WHERE source = 'ella_daily_digest'
  AND created_at >= now() - interval '1 day'
ORDER BY created_at DESC;

-- Rows the run marked sent.
SELECT count(*) FROM pending_digest_items
WHERE sent_in_digest_at >= now() - interval '1 day';
```

## Failure modes

- **CRON_SECRET misconfigured** → 401, nothing sends. Same shared
  `CRON_SECRET` as every cron.
- **Zero head CSM resolved** → CC-only send + error audit row
  (`processing_status='failed'`, `processing_error` carries the
  warning). If CC is also unset, nothing sends (no recipients) but the
  cron still returns 200 and rows stay unsent for the next tick.
- **One recipient send fails** → the other still gets the DM (FAQ
  pattern). Rows are still marked sent as long as *at least one* send
  succeeded.
- **All sends fail** → `status='slack_post_failed'`, rows left unsent
  so the next tick retries them.
- **Mark-sent UPDATE fails** → logged; rows stay unsent and will be
  re-sent next tick (duplicate digest is the failure mode here — better
  than silently dropping).
- **Re-fire dedup** → `pending_digest_items` unique index on
  `(slack_channel_id, triggering_message_ts)` prevents a second insert;
  the entry stays as-is rather than mutating on message edits.

## How to disable temporarily

Remove the `/api/ella_daily_digest_cron` entry from `vercel.json`
`crons` and redeploy, OR (faster, no deploy) accept that with no head
CSM and no CC env var the cron is a no-op. The upstream
`pending_digest_items` writes are governed by
`ELLA_PASSIVE_MONITORING_ENABLED` (passive) — flipping that off stops
new passive flags but reactive @-mention flags still accrue.

## Tuning surfaces

- Decision-Haiku flagging prompt (`agents/ella/passive_monitor.py:_HAIKU_SYSTEM_PROMPT`, THE DIGEST FLAG section) — iterate from real-fire data.
- Window (`_WINDOW_HOURS`), truncation cap (`_BODY_TRUNCATE_AT`), snippet/reasoning caps in `api/ella_daily_digest_cron.py`.
