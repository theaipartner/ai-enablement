# Spec — Ella V2 Batch 1: Cloud Slack ingestion for all client channels

## Goal

Land every message from every client Slack channel into the cloud `slack_messages` table in real time, plus a one-shot backfill of historical messages, so future batches (passive monitoring, delayed response, team-response cancellation) have a complete and current message store to query. Bot exclusion preserved at the author-type level. Ella's own posts ingested with a distinct `author_type='ella'` so future logic can both retrieve her past messages for context AND skip them as response triggers.

This batch ships standalone value even before Batch 2/3 land: every message ingested means Ella's existing @mention retrieval flow gets richer context (today she only sees the local-backfilled messages from May 2026). Dashboards gain a real-time activity feed.

## Scope

**In scope:**
- Realtime ingestion via Slack Events API for all client channels
- One-shot backfill of historical messages for every client channel
- Author-type resolution including the new `'ella'` value
- Idempotent inserts on `(slack_channel_id, slack_ts)`
- Operational scripts to invite Ella + the bot to client channels
- Tests covering all ingestion paths
- Audit ledger entries via `webhook_deliveries`

**Out of scope (Batch 2+):**
- Any change to Ella's response trigger logic — `app_mention` behavior is preserved EXACTLY
- Passive-monitor decision pipeline
- Pending-response scheduling / cron / team-response cancellation
- KB-relevance gating
- Changes to `_post_to_slack` or the two-token strategy
- Slack message → `document_chunks` pipeline (out of scope for V1; Drake wants `slack_messages` queryable directly first)

## Architecture overview

```
Slack Events API
  └─ POST /api/slack_events  (existing endpoint, expanded)
       │
       ├─ event.type == "url_verification"     → existing handler (unchanged)
       ├─ event.type == "event_callback"
       │    └─ event.event.type:
       │         ├─ "app_mention"              → existing Ella handler (PRESERVED VERBATIM)
       │         └─ "message"                  → NEW ingestion path:
       │              ├─ resolve channel via slack_channels lookup
       │              ├─ skip if not a client channel (slack_channels.client_id IS NULL)
       │              ├─ skip ignorable subtypes (channel_join, channel_topic, etc.)
       │              ├─ parse via shared SlackMessageRecord parser
       │              ├─ resolve author_type (client / team_member / ella / bot / workflow / unknown)
       │              ├─ upsert into slack_messages (idempotent on channel_id + slack_ts)
       │              └─ audit row in webhook_deliveries (source='slack_message_ingest')
       │
       └─ all other event types                → log + 200 OK (no-op, future-proof)

scripts/backfill_slack_client_channels.py
  └─ enumerate slack_channels WHERE client_id IS NOT NULL AND is_archived = false
       └─ for each channel: reuse ingestion/slack/pipeline.py to backfill via REST API
             ├─ idempotent on (channel_id, slack_ts) — re-runs are safe
             ├─ rate-limited (Slack tier 3 for conversations.history)
             └─ resumable per-channel via existing high-water-mark logic

scripts/invite_ella_and_bot_to_client_channels.py
  └─ enumerate slack_channels WHERE client_id IS NOT NULL AND is_archived = false
       └─ for each channel: conversations.invite both Ella's user_id AND the bot user_id
             ├─ skip if already a member
             └─ report list of channels invited / already-in / failed
```

## Files touched

**New files:**
- `scripts/backfill_slack_client_channels.py` — one-shot backfill orchestrator (reuses existing `ingestion/slack/pipeline.py`)
- `scripts/invite_ella_and_bot_to_client_channels.py` — operational helper to add Ella's user account + the bot to every client channel
- `shared/slack_identity.py` — small module that resolves+caches the user_id behind a Slack token via `auth.test`. Used by the realtime handler, the parser-config-builder, and the invite script
- `tests/api/test_slack_events_message_ingest.py` — unit tests for the new message-event ingestion path
- `tests/shared/test_slack_identity.py` — unit tests for the new identity resolver (cache hit, cache miss, auth.test failure)
- `docs/runbooks/slack_message_ingest.md` — operational guide

**Modified files:**
- `api/slack_events.py` — add `message`-event handler branch alongside the existing `app_mention` branch. Existing app_mention path unchanged.
- `ingestion/slack/parser.py` — extend `_resolve_author` to recognize Ella's user_id and return `'ella'` when matched. Add an `ella_user_id` parameter to `parse_message`.
- `ingestion/slack/pipeline.py` — pass Ella's user_id through to the parser
- `docs/schema/slack_messages.md` — add `'ella'` to the `author_type` enum row, note the env-var dependency
- `CLAUDE.md` § Live System State — add a paragraph about the cloud Slack ingestion pipeline going live (Ella V2 § Batch 1)
- `CLAUDE.md` § Stack — confirm OPENAI_API_KEY is still primary embedding (no change here, but Slack ingestion docs may suggest otherwise — re-read and surgical-edit only if needed)

**No files deleted.**

## Schema verification (read-only check Builder must do FIRST)

Before any code, Builder MUST run two verification queries against cloud DB and report results in the acclimatization confirmation:

1. **Verify `slack_messages.author_type` has no CHECK constraint** (so adding `'ella'` as a new value is a vocabulary change, not a migration):
```sql
select pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'slack_messages'::regclass
  and contype = 'c';
```
Expected: empty result OR no constraint mentioning author_type. If a CHECK exists, surface immediately — migration needed before code work.

2. **Verify the count of client channels we'll be enabling** (sanity-check the rollout size):
```sql
select count(*) from slack_channels
where client_id is not null and is_archived = false;
```
Expected: a number Builder reports as "N client channels in scope." If N exceeds 250, hard-stop and surface — that's far more than we expect (CLAUDE.md says ~188 active clients) and means our channel-mapping is broader than intended; Drake should review before backfill.

3. **Verify Ella's team_members.slack_user_id exists** (so `_resolve_author` doesn't accidentally double-tag):
```sql
select id, full_name, slack_user_id
from team_members
where slack_user_id is not null
  and full_name ilike '%ella%';
```
Expected: zero or one row. If multiple, Drake needs to disambiguate.

## Component design

### 1. Realtime ingestion handler (api/slack_events.py)

Extend the existing event-callback dispatcher in `api/slack_events.py` (around line 126) to add a `message` event branch. The branch lives BELOW the existing `app_mention` branch — order doesn't matter functionally because event types are mutually exclusive, but reading order is "existing behavior first, new behavior second" for maintainability.

```python
# Existing (preserved verbatim):
if event.get("type") == "app_mention":
    _process_mention(event, ...)
    return

# NEW:
if event.get("type") == "message":
    _ingest_message_event(event, raw_payload=full_event_envelope)
    return
```

`_ingest_message_event` responsibilities:
- **Channel-allowlist gate.** Look up `slack_channels` by `slack_channel_id`. If the row doesn't exist OR `client_id IS NULL` OR `is_archived = true` → log + 200 OK + audit row tagged `skipped_non_client_channel`, do not insert.
- **Subtype gate.** If `event.subtype` is in the ignorable set (`channel_join`, `channel_leave`, `channel_topic`, `channel_purpose`, `channel_name`, `channel_archive`, `channel_unarchive`, `pinned_item`, `unpinned_item`, `reminder_add`, `bot_add`, `bot_remove` — same set used in `ingestion/slack/parser.py`) → log + 200 OK + audit row tagged `skipped_ignorable_subtype`, do not insert.
- **Parse.** Call the shared `parse_message` parser from `ingestion/slack/parser.py`. Pass the existing `client_user_ids` and `team_user_ids` sets (resolved at handler startup or per-request — see "Author resolution caching" below) PLUS the new `ella_user_id` parameter resolved via `shared.slack_identity.get_user_id_for_token(os.environ['SLACK_USER_TOKEN'])`.
- **Upsert.** Insert into `slack_messages`. Idempotency via `ON CONFLICT (slack_channel_id, slack_ts) DO UPDATE SET text = EXCLUDED.text, raw_payload = EXCLUDED.raw_payload, ingested_at = now()` — refreshes text on edits without duplicating.
- **Audit.** Insert into `webhook_deliveries` with `source='slack_message_ingest'`, `processing_status='processed'` (or `'failed'` on exception). Payload includes `{slack_channel_id, slack_ts, author_type, message_type}`.
- **Fail-soft contract.** Same shape as `cs_call_summary_post.maybe_post_cs_call_summary`: catch all exceptions, log, return without raising. The Slack event's 200 OK is already sent; ingestion failure must NEVER cause Slack to retry-storm.

**Author resolution caching:**

Today the local backfill resolves authors by passing pre-fetched sets. The realtime handler can either:
- (a) Re-fetch sets per-request — simple but ~50ms overhead per event
- (b) Cache sets in module scope with TTL (e.g., 5 min)
- (c) Resolve per-message via individual queries — N+1 problem on backfill but fine for realtime

**Builder decision:** use (a) — fetch fresh per-request. Premature optimization risk on (b); per-message overhead is acceptable at realtime volume (a few events/second peak in our workspace). Re-evaluate if Vercel function duration starts hitting the 60s ceiling.

### 2. Backfill (scripts/backfill_slack_client_channels.py)

Thin orchestrator over the existing `ingestion/slack/pipeline.py` — does NOT reimplement the per-channel logic.

- Connects to cloud DB via `shared/db.py:get_client()`
- Queries `select id, slack_channel_id, name, client_id from slack_channels where client_id is not null and is_archived = false`
- Calls existing `pipeline.run_backfill_for_channels(channel_ids, days=N, dry_run=False)` (or whatever the existing entry point is — Builder verifies)
- CLI flags:
  - `--smoke` — pick the FIRST client channel, run with `days=7`, dry_run, report counts WITHOUT inserting (per CLAUDE.md "real-API smoke test before --apply on backfills" rule)
  - `--apply` — actually insert
  - `--days N` — backfill window (default: 90)
  - `--limit N` — limit channel count (testing escape hatch)
  - `--channel-id C...` — single-channel run (debugging escape hatch)
- Reports per-channel: messages found, threads followed, inserted vs refreshed counts, errors
- Hard-stops if any channel returns `not_in_channel` (the bot isn't a member) — surfaces the operational gap (need to invite the bot first)

**Builder MUST run with `--smoke` before `--apply`** per the established backfill discipline. Smoke output is part of Builder's verification report.

### 3. Operational helper (scripts/invite_ella_and_bot_to_client_channels.py)

For each client channel, ensure both Ella's user account and the bot are members. Slack API: `conversations.invite` with the user ids.

- CLI flags:
  - `--dry-run` (default) — list channels and current membership without inviting
  - `--apply` — actually invite
  - `--users <U1>,<U2>` — comma-separated user ids to invite (defaults to Ella's user id + bot user id from env)
- Required env vars:
  - `SLACK_USER_TOKEN` (xoxp-) for the invite — bot tokens cannot invite to private channels in many configurations; user token is more permissive
  - `SLACK_BOT_TOKEN` (xoxb-) — to derive the bot's own user id via `auth.test`
- Both target user ids (Ella's user account + the bot) are resolved at script startup via `shared/slack_identity.get_user_id_for_token()` rather than read from env
- Output: per-channel report (already-member / invited / failed). Failures don't abort the run; they're reported at the end.

### 4. Author resolution: introducing `'ella'`

Modify `ingestion/slack/parser.py:_resolve_author`:

```python
def _resolve_author(
    event: dict[str, Any],
    *,
    client_user_ids: set[str],
    team_user_ids: set[str],
    ella_user_id: str | None = None,  # NEW
) -> tuple[str, str]:
    user_id = event.get("user")
    bot_id = event.get("bot_id")
    # ... existing resolution ...

    if user_id:
        # NEW: check Ella FIRST so she gets her own author_type even
        # though she'd also resolve to team_member by membership.
        if ella_user_id and user_id == ella_user_id:
            return user_id, "ella"
        if user_id in client_user_ids:
            return user_id, "client"
        if user_id in team_user_ids:
            return user_id, "team_member"
        # ... existing fallthrough ...
```

Update `parse_message` signature to accept and forward `ella_user_id`. Default `None` for backwards compatibility with any existing callers.

`pipeline.py` (the local backfill) and the realtime handler both resolve `ella_user_id` via `shared.slack_identity.get_user_id_for_token(os.environ['SLACK_USER_TOKEN'])` and forward it through.

### 5. Audit ledger via webhook_deliveries

Every realtime event creates an audit row. Fields:
- `webhook_id`: `f"slack_msg_ingest_{uuid4()}"`
- `source`: `'slack_message_ingest'`
- `processing_status`: `'processed'` / `'skipped_non_client_channel'` / `'skipped_ignorable_subtype'` / `'failed'`
- `processing_error`: nullable; populated on exception
- `payload`: `{slack_channel_id, slack_ts, author_type, message_type, subtype}` (NOT the full message text — payload should stay small)
- `processed_at`: `now()`

**Volume sanity check.** Roughly 1000-5000 messages/day across all client channels (estimate). One audit row per event = same volume in `webhook_deliveries`. After 90 days that's ~450K rows. Manageable, but worth flagging in the runbook for future TTL consideration. NOT addressing in this batch.

## Configuration changes

### Slack app dashboard updates (Drake's gate (d) — credentials/env vars)

These changes are NOT code; they require Drake to apply via the Slack app dashboard:

1. **Event subscriptions:** add `message.channels` and `message.groups` to the bot event list.
2. **Bot scopes:** add `channels:history` and `groups:history` if not already present (these may already be granted from prior work — Builder verifies in the Slack app config and reports).
3. **Reinstall the app to the workspace** if scopes changed (Slack requires reinstall on scope changes).

Builder writes the runbook with the exact scope-list to add; Drake performs the dashboard updates before the realtime path goes live.

### Vercel env vars

**No new env vars needed.** The existing `SLACK_USER_TOKEN` (xoxp-) and `SLACK_BOT_TOKEN` (xoxb-) are already in production env. Both user ids (Ella's user account + the bot's user account) are derived at runtime by calling Slack's `auth.test` API once per token — same pattern the existing local backfill uses (`ingestion/slack/pipeline.py` already pulls the bot's own user id via `auth.test`). Cache the `auth.test` results in module scope (long-lived; user ids don't change unless the workspace is reinstalled).

Helper function the realtime handler + invite script + parser-config-builder share:

```python
# shared/slack_identity.py (NEW small module)
_USER_ID_CACHE: dict[str, str] = {}

def get_user_id_for_token(token: str) -> str:
    """Resolve and cache the user_id behind a Slack token via auth.test."""
    if token in _USER_ID_CACHE:
        return _USER_ID_CACHE[token]
    # ... call auth.test, parse user_id, cache, return
```

Add `shared/slack_identity.py` to the new-files list above.

## Test scenarios

`tests/api/test_slack_events_message_ingest.py` — unit tests using the existing mocker pattern (per `tests/conftest.py` which already mocks `shared.slack_post.post_message`):

1. **Happy path — client channel, regular message.** Synthetic event, slack_channels lookup returns a row with `client_id` populated. Asserts: `slack_messages` insert called with correct fields, audit row inserted with `processing_status='processed'`.
2. **Skip — non-client channel.** Event arrives for a channel where `client_id IS NULL`. Asserts: no slack_messages insert, audit row tagged `skipped_non_client_channel`.
3. **Skip — channel-state subtype.** Event with `subtype='channel_join'`. Asserts: no slack_messages insert, audit row tagged `skipped_ignorable_subtype`.
4. **Ella self-recognition.** Event with `user=SLACK_ELLA_USER_ID`. Asserts: `slack_messages` row written with `author_type='ella'`.
5. **Bot message.** Event with `subtype='bot_message'` and a `bot_id`. Asserts: row written with `author_type='bot'`.
6. **Workflow message.** Event with workflow indicators. Asserts: row written with `author_type='workflow'`.
7. **Idempotency.** Same event delivered twice. Asserts: one row in slack_messages (the second insert is a no-op via ON CONFLICT), two audit rows (each delivery audited).
8. **Fail-soft on DB error.** DB raises during insert. Asserts: handler returns without raising, audit row tagged `failed` with error message.
9. **Edit event.** Slack `subtype='message_changed'`. Asserts: row updated (text refreshed) not re-inserted; idempotency still holds.
10. **Existing app_mention path unchanged.** Sanity test that the existing app_mention handler still fires and is unaffected by the new message branch.

For the backfill script, extend `scripts/test_cs_call_summary_locally.py`-style harness pattern (per CLAUDE.md operational discipline). Smoke covers:
- Picking 1 client channel
- Running with `--smoke` (dry_run)
- Asserting messages_in_window > 0 and no inserts happened
- Then running `--apply --limit 1` and asserting inserts landed

## Operational rollout (sequence)

After Builder ships the code, Drake follows these steps in order:

1. **Code reviewed + committed + pushed.** Director's gate.
2. **Drake updates Slack app config:** add `message.channels` and `message.groups` event subscriptions; verify scopes (`channels:history`, `groups:history`); reinstall app. Drake's gate (d).
3. **Drake or Director runs `scripts/invite_ella_and_bot_to_client_channels.py --dry-run`** — reports current membership. Director can run this; output informs the next step.
4. **Drake reviews the invite report; runs with `--apply`** if the invite list looks correct. Drake's gate (a) — modifying real Slack channel membership.
5. **Director runs `scripts/backfill_slack_client_channels.py --smoke`** — reports per-channel counts WITHOUT inserting.
6. **Drake reviews the smoke output; if good, Director runs `--apply`.** Drake's gate (a) for the bulk insert. Backfill takes ~15-30 min depending on history depth.
7. **Realtime monitoring:** Director queries `webhook_deliveries WHERE source='slack_message_ingest' AND processed_at > now() - interval '5 minutes'` to confirm events flowing. Drake's gate (c) — eyeballing real surfaces (cloud DB row appearance after sending a test message in a client channel).
8. **Sanity check:** Drake sends a test message in a pilot channel; Director verifies it lands in cloud `slack_messages` within seconds.

If any gate fails: Director surfaces, Drake decides revert / iterate.

## Doc updates (mandatory; explicit "no change needed" if Builder decides one isn't applicable)

- `docs/runbooks/slack_message_ingest.md` (NEW) — operational guide covering: what the pipeline does, when it runs, failure modes, how to debug missing messages, the `webhook_deliveries` audit pattern for this source, the env vars + Slack scopes required
- `docs/schema/slack_messages.md` — add `'ella'` to the `author_type` row's enum list; note the env-var dependency
- `docs/agents/ella/ella.md` — add a "V2 ingestion" subsection noting that all client-channel messages now flow into cloud `slack_messages`; passive monitoring is Batch 2
- `CLAUDE.md` § Live System State — add a paragraph: "Ella V2 Batch 1 — cloud Slack ingestion (shipped YYYY-MM-DD)"; reference the runbook
- `CLAUDE.md` § Stack — no change expected, but Builder verifies and explicitly says "no change needed" if confirmed
- `docs/agents/ella/ella-v1-scope.md` — no change (V1 scope is a frozen historical doc)
- `ingestion/slack/parser.py` module docstring — small refresh to mention the new `'ella'` author type

## Out of scope (explicit non-list to prevent scope creep)

- Any change to `_post_to_slack` or the two-token strategy
- Any change to `_process_mention` (the existing app_mention path stays IDENTICAL)
- The passive-monitor / KB-relevance / pending-response logic (Batch 2)
- Per-channel `ella_enabled` flag changes (we already have it; Batch 3 flips it for the pilot)
- A migration to add a CHECK constraint on `author_type` (deferred — informal vocabulary stays fine for now)
- A `slack_messages → document_chunks` retrieval pipeline (V2 future)
- Cleanup of the existing local backfill code (it's still useful for local dev; coexists)
- Slack reactions ingestion (separate event type, future work)
- Edit / delete event handling beyond the basic `message_changed` subtype shown in test 9

## Hard stops for Builder

- **Stop and surface if the schema verification queries (above) reveal a CHECK constraint on `author_type`.** Migration needed first; Drake decides scope.
- **Stop and surface if the client-channel count exceeds 250.** That's outside expected bounds; Drake should review the rollout scope.
- **Stop and surface if the smoke run fails.** Per CLAUDE.md "real-API smoke test before --apply on backfills" rule. Don't proceed to `--apply` autonomously.
- **Do not modify `vercel.json`** — adding a new function would, but we're extending an existing function (`api/slack_events.py`), so no `vercel.json` change should be needed. If Builder concludes one IS needed, hard-stop.
- **Do not invite anyone to Slack channels.** That's Drake's gate (a) — operational change with side effects on real shared channels.
- **Do not run the backfill `--apply`.** Director runs it after Drake confirms the smoke output.

## Side-effects expectations

Per CLAUDE.md § Builder behavior § End-of-turn report § Side effects: Builder must inventory real-world actions taken during this run.

Expected during Builder's work:
- Schema verification queries (read-only) — fine
- Pytest runs (autouse fixture in tests/conftest.py blocks Slack posts) — fine
- The `--smoke` run of the backfill script (READ from Slack API, NO inserts) — fine, but surface explicitly because it does hit the live Slack API

NOT expected:
- Any `slack_messages` row written from Builder's runs (smoke is dry-run)
- Any `webhook_deliveries` row written
- Any Slack message posted to any channel
- Any `conversations.invite` call (operational gate is Drake's)

If anything outside the expected list happens, surface in the side-effects section.

## Verification expectations

- All existing tests pass: `pytest tests/` should hold at the current baseline (~419 + the new 10 ingest tests added — report the new total)
- The local cs_call_summary harness still passes: `.venv/bin/python scripts/test_cs_call_summary_locally.py` should hold at 59/59 (no functional dependency, but the conftest behavior should be unaffected)
- The new ingest tests (10 scenarios) all green
- The smoke run output (per-channel counts, NO inserts) included in the report

## Open questions resolved by Drake

- **Backfill window:** 90 days (was 365 in initial draft).
- **Backfill checkpoint table:** skipped — idempotency is enough.
- **User-id env vars:** not needed — both Ella's user_id and the bot's user_id are derived at runtime from existing tokens via `auth.test`, cached in `shared/slack_identity.py`.

Remaining open question (Director's call unless Drake objects):

- **Audit volume:** every event creates a `webhook_deliveries` row in V1. Lean: every event for first 30 days post-deploy to validate behavior, then revisit if the table grows unwieldy. Builder ships with every-event auditing.
