# Runbook — Slack message ingestion (Ella V2 Batch 1)

## What this is

Every `message`-type event from a Slack client channel lands in
`slack_messages` in real time. Plus a one-shot backfill catches up
historical messages on install. Out: KB-relevance gating, passive
monitoring, response triggers — those are Batch 2/3 concerns. In: a
queryable, current store of every Slack message in every active client
channel.

Two surfaces touch this pipeline:

- **Realtime handler** — `api/slack_events.py` extends its
  `event_callback` dispatcher with a `message` branch that calls
  `ingestion.slack.realtime_ingest.ingest_message_event`. Synchronous,
  fail-soft (any exception is logged + audited, never propagates).
- **Historical backfill** — `scripts/backfill_slack_client_channels.py`
  pulls every client-mapped channel's last N days via
  `conversations.history`, follows thread parents into
  `conversations.replies`, and upserts via the existing
  `ingestion/slack/pipeline.py`.

Both paths use the same parser (`ingestion/slack/parser.py`) and write
to the same `slack_messages` table with idempotency on
`(slack_channel_id, slack_ts)`.

## When it runs

- **Realtime.** Slack delivers `message.channels` and `message.groups`
  events to `/api/slack_events` whenever someone posts in a channel
  the bot is a member of. The handler returns 200 fast (Slack's 3s
  ack window); ingestion happens synchronously inside the request.
- **Backfill.** Manual one-shot, run by an operator at install time
  or after adding new client channels. No cron schedule.

## Operational rollout (one-time, on enable)

Sequence at first deploy:

1. **Drake updates Slack app config** — adds `message.channels` and
   `message.groups` event subscriptions; verifies scopes
   (`channels:history`, `groups:history`); reinstalls the app to the
   workspace if scopes changed. (Drake's gate — credentials.)
2. **Director runs the invite helper in dry-run** —
   `.venv/bin/python scripts/invite_ella_and_bot_to_client_channels.py`
   reports current membership without inviting. Used to inform Drake's
   review of the invite list.
3. **Drake reviews + runs `--apply`** — actually invites Ella's user
   account + the Slack bot to every client channel. Drake's gate
   (modifies real shared Slack state).
4. **Director runs the backfill in `--smoke`** —
   `.venv/bin/python scripts/backfill_slack_client_channels.py --smoke`.
   Pulls history for ONE channel as a real-API smoke. Reports per-channel
   counts WITHOUT inserting.
5. **Drake reviews + Director runs `--apply`** — actually upserts
   to `slack_messages`. Drake's gate (bulk insert into shared DB).
6. **Verify realtime is flowing** — query
   `webhook_deliveries WHERE source='slack_message_ingest' AND processed_at > now() - interval '5 minutes'`
   after sending a test message in a pilot channel. Drake's gate
   (post-deploy testing on real surface).

## Audit ledger contract

Every realtime delivery writes one row to `webhook_deliveries` with
`source='slack_message_ingest'`. The contract uses a dual-discriminator
pattern because migration 0011's CHECK on `processing_status` only
allows `{'received','processed','failed','duplicate','malformed'}` — a
literal `processing_status='skipped_*'` value would violate the
constraint. Same precedent as `agents/gregory/cs_call_summary_post.py`.

| Outcome | `processing_status` | `processing_error` | `payload.skip_reason` | `payload.content_source` |
|---------|---------------------|---------------------|------------------------|---------------------------|
| Ingested | `processed` | absent | absent | `ingested` |
| Skipped — non-client channel | `processed` | `skipped_non_client_channel` | `non_client_channel` | absent |
| Skipped — ignorable subtype | `processed` | `skipped_ignorable_subtype` | `ignorable_subtype` (+ `payload.subtype`) | absent |
| Exception during processing | `failed` | `<str(exc)[:2000]>` | absent | absent |

To tell apart "ingested" from "skipped, non-client channel" — both have
`processing_status='processed'` — query
`payload->>'skip_reason'`:

```sql
-- All ingested messages in the last hour
select count(*)
from webhook_deliveries
where source = 'slack_message_ingest'
  and processing_status = 'processed'
  and (payload->>'skip_reason') is null
  and processed_at > now() - interval '1 hour';

-- All skips by reason in the last hour
select payload->>'skip_reason' as reason, count(*)
from webhook_deliveries
where source = 'slack_message_ingest'
  and (payload->>'skip_reason') is not null
  and processed_at > now() - interval '1 hour'
group by reason;
```

Audit payload also includes `slack_channel_id`, `slack_ts`,
`slack_user_id`, `author_type`, `message_type`, `subtype` — useful for
debugging "did we ingest user X's message?" without joining tables.

## Failure modes + debugging

### Symptom: a message I sent isn't in `slack_messages`

1. Check `webhook_deliveries WHERE source='slack_message_ingest'
   AND payload->>'slack_channel_id'='<channel_id>' AND processed_at >
   now() - interval '5 minutes'`. If no row exists, the event never
   reached our handler — Slack didn't deliver. Most likely cause: the
   bot isn't a member of the channel, or the `message.channels` /
   `message.groups` subscription isn't active. Re-run the invite helper.
2. If a row exists with `processing_status='processed'` and
   `payload->>'skip_reason'='non_client_channel'`: the channel isn't
   mapped to a client in `slack_channels`. Run the master-sheet
   reconciliation flow or manually update `slack_channels.client_id`.
3. If a row exists with `processing_status='processed'` and
   `payload->>'skip_reason'='ignorable_subtype'`: the message was a
   system event (channel_join, message_deleted, etc.) — by design, we
   don't ingest those. Check `payload.subtype` to confirm.
4. If a row exists with `processing_status='failed'`: see
   `processing_error` for the exception string. Check Vercel logs for
   the full stack trace (logger emits `logger.exception` on failure).

### Symptom: backfill says `bot_not_in_channel` for a channel

The bot's user_id isn't in the channel's member list. Run
`scripts/invite_ella_and_bot_to_client_channels.py --apply` to invite
the bot (and Ella) to every client-mapped channel. Backfill logs each
`bot_not_in_channel` channel as `[SKIPPED]`, continues to the next
channel, and prints a per-error-type count in the end-of-run summary
(e.g. `Errors: 129 (bot_not_in_channel: 129)`). The run exits 0 if
the only errors are `bot_not_in_channel` — they're a known operational
state, not a failure. Other per-channel errors (network, auth,
rate-limit) still exit 1.

### Symptom: a client has multiple Slack channels and only one backfills

`scripts/backfill_slack_client_channels.py --channel-id <X>` filters
the `slack_channels` lookup by channel id, but the underlying
`run_ingest` pipeline takes `client_full_names` and resolves them via
`_resolve_client_target`, which picks the FIRST channel returned by
`select * from slack_channels where client_id = <id>`. So if client X
has two channels mapped, passing `--channel-id` for either of them
ingests whichever channel `_resolve_client_target` happens to pick —
not the one you asked for. Workaround: call `run_ingest` directly with
`extra_channel_names=[<slack-channel-name-without-#>]`, which goes
through `_resolve_channel_name_target` (Slack API lookup) and ingests
the specific channel. See `docs/reports/ella-v2-batch-1-finish-rollout.md`
for a working example.

### Symptom: edits aren't refreshing the row

Slack edits arrive as `subtype='message_changed'` with the new content
under `event.message` (the inner sub-dict carries the original
message's `ts`). The realtime handler unwraps this and upserts using
the inner ts so `ON CONFLICT (channel, ts)` updates in place. If edits
aren't refreshing: confirm the event has the inner `message` shape;
also confirm the original message had landed first (an edit to a
never-ingested message will create a fresh row keyed on the inner ts,
which is fine but visually surprising).

### Symptom: Ella's posts ingest as `author_type='team_member'`, not `'ella'`

The realtime handler resolves Ella's user_id via
`shared.slack_identity.get_user_id_for_token(SLACK_USER_TOKEN)`. If the
env var is unset (or the token is invalid), the function returns None
and the parser falls back to other resolution branches. Verify
`SLACK_USER_TOKEN` is set in Vercel project env. Cache lives in module
scope and is per-process — Vercel cold starts re-resolve via auth.test
(~100-200ms one-time cost per cold start).

## Env vars

| Name | Used by | Why |
|------|---------|-----|
| `SLACK_BOT_TOKEN` | both paths | reads via conversations.history; required |
| `SLACK_USER_TOKEN` | both paths | resolves Ella's user_id for `author_type='ella'`; optional, falls back gracefully if unset |
| `SLACK_SIGNING_SECRET` | realtime only | HMAC verification of inbound webhooks |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | both paths | DB writes |

## Slack app scopes

Bot scopes the realtime path requires:

- `channels:history` — public channels
- `groups:history` — private channels
- `chat:write` — post replies (existing, used by the Ella `app_mention`
  path)
- `users:read` — author resolution (existing)

User token scopes the invite helper requires (when using
`SLACK_USER_TOKEN`):

- `channels:write.invites`, `groups:write.invites` — `conversations.invite`

Event subscriptions to enable:

- `app_mention` (existing)
- `message.channels`, `message.groups` (NEW for V2 Batch 1)

## Future considerations (NOT in this batch)

- **Audit volume.** ~1000-5000 messages/day across all client channels
  → same volume of `webhook_deliveries` rows. ~450K rows after 90 days,
  ~1.8M after a year. Manageable, but worth considering a TTL cleanup
  pass once the volume is observed (e.g., archive `processing_status =
  'processed'` rows older than 90 days). Defer until a real query-perf
  signal surfaces.
- **`slack_messages` → `document_chunks`.** Slack messages aren't yet
  retrievable via Ella's KB query path. V2 future work.
- **Reactions ingestion.** `reaction_added` / `reaction_removed` events
  are a separate event type. Future work.
- **Author-resolution caching.** The realtime handler re-fetches
  `client_user_ids` and `team_user_ids` per request (per spec decision
  (a)). Two small queries per event is fine at our volume; revisit if
  Vercel function duration starts hitting the 60s ceiling.
