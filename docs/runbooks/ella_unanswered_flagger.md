# Runbook: Ella unanswered-message flagger cron

Operational guide for the real-time safety-net cron at
`api/ella_unanswered_flagger_cron.py`. Covers what it does, the query
logic, recipient resolution, the kill switch, failure modes, and the
manual curl. Spec: `docs/specs/ella-unanswered-message-flagger.md`.

## What it is

The daily digest (`api/ella_daily_digest_cron.py`) is Scott's once-a-
day skim of everything Ella flagged. It can't catch a Saturday booking-
link question that needed a Saturday answer — a Monday-morning digest
is too late. This cron is the parallel safety net: every flagged
`pending_digest_items` row that ages past **2 hours** with **no
`team_member` message in the source channel** gets posted to
`#unanswered-channels` with @-mentions of Scott + the client's primary
advisor.

It is **layered on top of** the daily digest, not a replacement. The
digest still fires at 16:30 EDT independently. The two surfaces have
independent state (`sent_in_digest_at` vs `unanswered_posted_at`) and
never conflict — a message can legitimately appear in both.

Key behavioral rules (Drake-confirmed):

- **Human intervention = ANY `team_member` message in the channel
  after the flagged message landed.** Topic-agnostic — if an advisor
  is active in the channel, the situation is being handled, even if the
  message is about something else.
- **Ella's own posts do NOT count.** They're `author_type='ella'`, not
  `'team_member'`. Even if Ella answered + flagged, the 2h timer keeps
  running waiting for a human.
- **`acknowledge_and_escalate` rows are subject to the 2h timer too.**
  Escalation DMs get missed; the channel post is the second wave.
- **Runs 24/7, no weekend / after-hours pause.** Weekend coverage is
  the explicit point. Saturday 11:00 flag → Saturday ~13:00 post if no
  advisor responded.
- **One post per message.** `unanswered_posted_at` is the dedup key —
  it never re-posts every tick.

## Pipeline (one audit row per posted item; one for disabled / config gap)

1. **Auth.** Vercel Cron POSTs with `Authorization: Bearer <CRON_SECRET>`.
2. **Kill switch.** `ELLA_UNANSWERED_FLAGGER_ENABLED` (defaults
   `'true'`). Any value other than `'true'` (case-insensitive) →
   `webhook_deliveries` row with `source='ella_unanswered_flagger'`,
   `payload={'disabled': true}`, return 200, no work.
3. **Destination channel.** `ELLA_UNANSWERED_CHANNEL_SLACK_ID`. Unset →
   500 + a `processing_status='failed'` audit row noting the config
   gap. Gate (d) — Drake sets this in Vercel Production env vars.
4. **Candidate query.** `pending_digest_items` where
   `unanswered_posted_at IS NULL` AND `created_at <= now() - 2h` AND
   `created_at >= now() - 7d`, oldest first, capped at 50/tick. The 7d
   backstop bounds a cron-paused-for-days scenario so it doesn't
   re-surface ancient flags. Backlog drains over subsequent ticks.
5. **Per candidate, human-intervention check:**

   ```sql
   SELECT 1 FROM slack_messages
   WHERE slack_channel_id = $1
     AND author_type = 'team_member'
     AND sent_at > $2          -- pending_digest_items.created_at
   LIMIT 1
   ```

   - Row returned → answered. Mark `unanswered_posted_at = now()` with
     `unanswered_post_slack_channel_id = NULL`,
     `unanswered_post_slack_ts = NULL` ("resolved before post"). No
     Slack post.
   - No row → genuinely unanswered. Build the body, resolve recipients,
     post, stamp the row with the channel + `ts`, write an audit row.
6. **Failure isolation.** A Slack post failure for one item logs +
   audits + continues. One bad post never breaks the drain.
7. **Return 200** with `checked` / `resolved_before_post` / `posted` /
   `post_failures` counts.

## Recipients

**Scott(s) — head CSM.** Every `team_members` row with
`access_tier='head_csm'` AND `archived_at IS NULL`. Exactly one today
(Scott). Zero rows → post anyway **without** a Scott @-mention + log a
warning. Multiple rows → @-mention all (correct behavior — a second
head CSM correctly joins).

**Primary advisor.** The client's active `primary_csm` from
`client_team_assignments` (`role='primary_csm'` AND
`unassigned_at IS NULL`) → that `team_members.slack_user_id`. No
primary advisor assigned (edge case) → only Scott is @-mentioned.

**Dedup.** If the client's primary advisor IS Scott, the @-mentions
are de-duplicated so Scott isn't pinged twice.

## Candidate filter — client-only (post-2026-05-21)

`_fetch_candidates` returns `pending_digest_items` rows aged into the
[2h, 7d] window, then runs `_filter_to_client_authored` which joins
JS-side against `slack_messages` to keep only `author_type='client'`
rows. Team_member / bot / ella / workflow / unknown candidates are
filtered out — the flagger's intent is *"client needs a human,"* not
*"team_member's question didn't get a team_member follow-up."*

Two-query pattern: one SELECT for candidates, then one SELECT per
distinct channel against `slack_messages` (eq `slack_channel_id` +
in_ `slack_ts`). Per-channel failure is isolated — a transient DB
blip on one channel's lookup skips that channel's candidates this
tick (retry next), but other channels in the same tick still process.

The daily digest (`api/ella_daily_digest_cron.py`) is NOT affected
by this filter — it deliberately surfaces ALL author types because
it's a wider-net awareness surface ("here's everything Ella flagged
in the last 24h").

**Side benefit:** the open `author_type='bot'` known issue (Ella's
posts misclassifying as `bot` — see `docs/archive/historical/known-issues.md`) is
handled implicitly by this filter. Bot-tagged rows fail the
`== 'client'` check, so Ella's own posts can't accidentally surface
here as "unanswered" while the parser bug stays open.

## Channel post format

Terse one-line shape (2026-05-21 simplification):

```
<@U_SCOTT_ID> <@U_ADVISOR_ID> unanswered in {Client Name}'s channel ({time_ago}): {slack_permalink}
```

The mention is the primary action signal; `client_name` disambiguates
which channel; `time_ago` lets the CSM see at a glance whether it
just hit 2h or has been sitting all day; the permalink is the action.
The CSM clicks through to read the full message, Ella's category, and
Haiku's reasoning at the source channel — that context is on screen
the moment they land, so duplicating it in the alert post created
scroll-heavy noise without adding triage value.

Backstops: no mentions → bare line without leading prefix; missing
`client_name` → `(unknown client)`; missing permalink inputs →
degenerate permalink trailing.

The `<@U…>` tokens are real Slack mentions and ping the recipients.
The permalink builder mirrors `ella_daily_digest_cron`'s
(`SLACK_WORKSPACE` optional subdomain) so the link renders
identically to the digest's.

## Schedule

```
*/15 * * * *
```

Every 15 minutes, all hours, all days — no timezone considerations, it
runs 24/7 by design. Cron fires 96×/day; each fire is one indexed scan
+ 0–50 indexed `slack_messages` lookups + 0–50 Slack posts. Trivial at
current volume.

## How to verify a fire

### Quick audit

```sql
select webhook_id, processing_status, processed_at, processing_error,
       payload->>'pending_digest_item_id' as item_id,
       payload->>'client_id' as client_id,
       payload->'recipient_slack_user_ids' as recipients,
       payload->>'channel_post_ts' as post_ts
  from webhook_deliveries
 where source = 'ella_unanswered_flagger'
 order by processed_at desc nulls last
 limit 20;
```

### Rows the flagger has acted on

```sql
select id, slack_channel_id, digest_category, created_at,
       unanswered_posted_at,
       unanswered_post_slack_channel_id,  -- NULL = resolved before post
       unanswered_post_slack_ts
  from pending_digest_items
 where unanswered_posted_at is not null
 order by unanswered_posted_at desc
 limit 50;
```

A row with `unanswered_posted_at` set but
`unanswered_post_slack_channel_id IS NULL` was resolved by a human
inside the 2h window (no post). A non-NULL channel id means it was
posted to `#unanswered-channels`.

### Phase 1 smoke (immediate, post-deploy)

```
curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \
     https://ai-enablement-sigma.vercel.app/api/ella_unanswered_flagger_cron
```

Expected: 200 OK, body summarizing `checked: N, posted: 0` (no items
are 2h old yet that haven't been answered, on a fresh deploy). Confirm
a `webhook_deliveries` row and the cron entry in Vercel's Crons tab.

## Failure modes

### CRON_SECRET misconfigured

Symptom: 401; no `webhook_deliveries` row for the fire. Recovery:
check Vercel env vars for `CRON_SECRET` (shared single-var pattern,
M6.2).

### ELLA_UNANSWERED_CHANNEL_SLACK_ID not set

Symptom: 500; `processing_status='failed'` audit row with
`payload.config_gap='ELLA_UNANSWERED_CHANNEL_SLACK_ID'`. Recovery:
gate (d) — Drake sets the channel id in Vercel Production env vars and
redeploys.

### `#unanswered-channels` doesn't exist / bot not invited

Symptom: per-item `processing_status='failed'` audit rows with
`processing_error='slack_post_failed: channel_not_found'` (or
`not_in_channel`). The cron keeps processing other items. Recovery:
confirm the channel exists and the Ella bot is invited.

### Zero / multiple head_csm rows

Zero → posts without a Scott @-mention + logs a warning (not a
failure). Multiple → @-mentions all. Same pattern as the daily digest.

### Cron over-fires on a backlog

If the cron was off for a day, the first tick back posts at most 50
items; subsequent ticks drain the rest 50 at a time. The 7-day
backstop prevents anything older than a week from posting at all.

### Duplicate post (rare)

The SELECT-then-UPDATE pattern has a small race window if two ticks
fire simultaneously (unlikely on a 15-min schedule). Accepted residual
risk — a duplicate is a one-time UX blip, not data corruption.

## How to disable

**Preferred — kill switch (no redeploy):** set
`ELLA_UNANSWERED_FLAGGER_ENABLED` to anything other than `true` in
Vercel env vars. The next tick writes a disabled audit row and does no
work. Set back to `true` to resume.

**Hard — remove the cron entry** from `vercel.json`:

```diff
- { "path": "/api/ella_unanswered_flagger_cron", "schedule": "*/15 * * * *" }
```

Redeploy. The `functions:` entry can stay — only the `crons:` entry
triggers the fire.

## Tuning surfaces

Knobs in `api/ella_unanswered_flagger_cron.py`:

- `_STALE_AFTER` (default `timedelta(hours=2)`). The grace window
  before a flagged message is considered going stale.
- `_BACKSTOP` (default `timedelta(days=7)`). The oldest a row can be
  and still post — the cron-paused-for-days guard.
- `_MAX_PER_TICK` (default `50`). Rows handled per 15-min tick.

Upstream: the flagging decision itself (`digest_flag=true`) is the
decision Haiku's call — see `docs/agents/ella.md`. This cron only
acts on rows the decision layer already flagged.
