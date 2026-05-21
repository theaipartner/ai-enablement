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

## Dedup gate (step 0, restructured 2026-05-21)

Every realtime delivery passes through a dedup gate before any
downstream side effect (slack_messages upsert, passive-monitor fork,
escalation fan-out) fires. The gate uses `webhook_deliveries.webhook_id`
(PK) as the dedup primitive via UPSERT-with-`ignore_duplicates=True`
— same pattern proven in production by the Fathom webhook handler.

**Position in the pipeline (post-2026-05-21):** Step 0 runs AFTER
channel-allowlist + subtype gate + `parse_message`, and BEFORE
`_upsert_message` / `_maybe_dispatch_passive_monitor`. The key
construction uses `record.slack_channel_id` + `record.slack_ts` —
both stable across `message_changed` redeliveries because `record`
is the parsed inner-event shape. The prior position (step 0 BEFORE
parsing, keyed on `event.get("ts")`) failed to dedup edits — see
`docs/reports/ella-duplicate-webhook-delivery-diagnostic.md` for
the diagnostic that surfaced the bug.

**Deterministic webhook_id format (happy path through step 0):**

```
slack_msg_ingest_{record.slack_channel_id}_{record.slack_ts}
```

Example: `slack_msg_ingest_C0AFEC456JG_1745500000.000100`. For a
regular (non-edit) message, `record.slack_ts == event.ts`. For a
`message_changed` event, `record.slack_ts` is the INNER message ts
(unchanged across edits), so two deliveries of the same logical
message (original + edit) collide on the PK and the second is
short-circuited.

**Three webhook_id prefixes for distinct intents:**

| Prefix | Source | When written |
|--------|--------|--------------|
| `slack_msg_ingest_{channel}_{ts}` | Step 0 UPSERT + lifecycle UPDATE | Happy path through step 0; one row per logical message, lifecycle `received → processed/failed/malformed` |
| `slack_msg_ingest_dup_{uuid}` | `_write_duplicate_audit_row` INSERT | Forensic row written when step 0's UPSERT returns empty data; `processing_status='duplicate'` |
| `slack_msg_ingest_pre_dedup_{uuid}` | `_insert_audit_terminal` INSERT | Early-exit branches BEFORE step 0 (non-client channel, ignorable subtype, parser-returned-None); single-state row with terminal status |

**Behavior on duplicate.** When Slack re-delivers the same logical
message (retry semantics, `message_changed` redelivery, manual replay)
the second UPSERT returns empty data and `ingest_message_event`
short-circuits with `skipped_reason='duplicate'` before any downstream
side effect — no second `slack_messages` upsert, no second
passive-monitor dispatch, no second ack post, no DM fan-out. A
forensic audit row is written with a UUID-suffixed `webhook_id`,
`processing_status='duplicate'`, and `payload.original_delivery_id`
linking back to the first delivery for trace-ability.

**Fail-open on DB outage.** If the step-0 UPSERT raises an unexpected
exception (non-PK-collision: DB unavailable, network timeout), the
gate treats the delivery as not-duplicate and lets the rest of the
pipeline run. Better to risk processing one possible-duplicate during
a DB blip than to drop a legitimate client message. The downstream
code's exception handler captures any further issues.

**Audit observability — three useful queries:**

```sql
-- Forensic duplicates caught by the gate (the dedup gate firing
-- successfully). Should be non-zero on healthy traffic.
select count(*) from webhook_deliveries
 where source = 'slack_message_ingest'
   and webhook_id like 'slack_msg_ingest_dup_%'
   and received_at >= now() - interval '7 days';

-- Pre-dedup early-exit rows (audit-only, not part of dedup).
-- Spikes indicate noisy non-client traffic or subtype churn.
select count(*) from webhook_deliveries
 where source = 'slack_message_ingest'
   and webhook_id like 'slack_msg_ingest_pre_dedup_%'
   and received_at >= now() - interval '7 days';

-- Happy-path rows by terminal status — the lifecycle that step 0
-- writes (received → processed/failed/malformed).
select processing_status, count(*) from webhook_deliveries
 where source = 'slack_message_ingest'
   and webhook_id ~ '^slack_msg_ingest_C[A-Z0-9]+_[0-9]+\.[0-9]+$'
   and received_at >= now() - interval '7 days'
 group by processing_status;
```

A zero count on the first query over a week of meaningful traffic =
probably broken (Slack does retry occasionally; with the post-parse
key, edits also count as dupes and should show up here).

**Closes** the 2026-05-19 EOD `docs/known-issues.md` entry
"Passive dispatch has no idempotency check against duplicate Slack
message delivery" — the misfire that produced two ack posts + four DMs
from a single Slack delivery would no longer fire. The prior 2026-05-20
ship had the correct architecture but the wrong dedup key (outer ts);
the 2026-05-21 fix moves the key to the inner ts via post-parse
construction.

## Audit ledger contract

Every realtime delivery writes one row to `webhook_deliveries` with
`source='slack_message_ingest'`. The contract uses a dual-discriminator
pattern because migration 0011's CHECK on `processing_status` only
allows `{'received','processed','failed','duplicate','malformed'}` — a
literal `processing_status='skipped_*'` value would violate the
constraint. Same precedent as `agents/gregory/cs_call_summary_post.py`.

**Lifecycle (post-2026-05-20):** one row per delivery, status
transitions `received → processed/failed/malformed`. The row is
INSERTed at step 0 via the dedup UPSERT, then UPDATEd by `_insert_audit`
to its terminal state. A duplicate delivery writes a SECOND row (with
UUID-suffixed `webhook_id` and `processing_status='duplicate'`) for
forensic observability — that row is the only one tied to the
duplicate event; the original delivery's row remains unchanged.

| Outcome | `processing_status` | `processing_error` | `payload.skip_reason` | `payload.content_source` |
|---------|---------------------|---------------------|------------------------|---------------------------|
| Ingested | `processed` | absent | absent | `ingested` |
| Skipped — non-client channel | `processed` | `skipped_non_client_channel` | `non_client_channel` | absent |
| Skipped — ignorable subtype | `processed` | `skipped_ignorable_subtype` | `ignorable_subtype` (+ `payload.subtype`) | absent |
| Exception during processing | `failed` | `<str(exc)[:2000]>` | absent | absent |
| Duplicate delivery (forensic row) | `duplicate` | absent | `duplicate_delivery` (+ `payload.original_delivery_id`) | absent |

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

0. **First check (private channels).** If you're testing in a private channel (🔒) and no row appears in `webhook_deliveries`: verify both `message.channels` AND `message.groups` event subscriptions exist on the Slack app, and that `channels:history` AND `groups:history` scopes are granted on the bot token. Missing `message.groups` is a silent failure mode — Slack accepts the subscription save without complaint, the URL stays verified, but no events fire for private channels. This was the 2026-05-10 root cause for "live ingestion not operational" — see `docs/known-issues.md` § ~~Ella V2 Batch 1 — realtime live ingestion not operational~~ for the full diagnostic signature.
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

Both `message.channels` AND `message.groups` event subscriptions are required. Client channels are typically private (🔒), and `message.channels` only fires for public (`#`) channels; `message.groups` is what fires for private channels. Until both are subscribed, realtime ingestion appears completely broken for private channels — events simply never reach the handler. Bot scopes `channels:history` AND `groups:history` are both required to back these subscriptions. Caught the hard way 2026-05-10: backfill landed 3,641 rows cleanly while the realtime path was 0-rows for two days because only `message.channels` was subscribed; `message.groups` was added, app reinstalled, and the path lit up immediately.

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
