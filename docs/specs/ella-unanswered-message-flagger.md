# Ella Unanswered-Message Flagger

**Slug:** ella-unanswered-message-flagger
**Status:** in-flight

## Context

Yesterday's spec (`ella-unified-path-intelligence-refactor`) brought Ella to a clean state: one path, three decisions, the daily 16:30 EDT digest as Scott's "see what's happened today" surface. This spec adds the next layer: a real-time safety net for messages that warranted attention and didn't get any.

The problem: the daily digest is great for Scott's daily skim, but a Monday-morning digest can't catch a Saturday booking-link question that needed a Saturday response. The original motivating case (weekend booking link, 48 hours unanswered, Monday recovery) needs a faster path. Not faster than the digest because the digest covers a different need — Scott reviewing the day's signal in one pass — but a parallel safety net that fires when a flagged message is going stale.

The shape: every time the decision Haiku sets `digest_flag=true` on a message, start a 2-hour countdown. If no human (CSM/advisor) posts in the same channel during those 2 hours, post the flagged message to `#unanswered-channels` with an @-mention of the primary advisor + Scott. The digest still fires at 16:30 EDT independently — this is a *layered* safety net, not a replacement.

Key design decisions Drake confirmed:
- Human intervention = any `team_member` message in the channel after the flagged message landed. Doesn't matter if it's about the flagged topic or not — if an advisor is active in the channel, the situation is being handled.
- Ella's own answers do NOT count as intervention. Even if Ella answered + flagged, the timer keeps running waiting for a human.
- `acknowledge_and_escalate` messages are also subject to the 2-hour timer. DMs get missed; the channel post is the second wave.
- Runs through weekends + after-hours with no pause. Saturday 11am flag posts to `#unanswered-channels` Saturday 1pm if no advisor response. Weekend coverage is the explicit point.
- One flag per message — `unanswered_posted_at` prevents re-posting every 2 hours.
- Lives on top of all existing systems. No changes to the decision Haiku, the digest cron, the dispatch layer, or the daily digest. Pure additive.

The change is small. One column-add migration. One new cron file. A few documentation updates. No prompt changes. No behavioral changes to anything that's already shipped — the safety net layer reads from `pending_digest_items` (which the unified-path spec already populates correctly) and acts independently.

## Acclimatization checklist

Builder reads these first and confirms understanding in 3-4 bullets in the report's "What I did" section. Call out any contradictions with what's actually shipped.

- `CLAUDE.md` § Working Norms, § Critical Rules
- `docs/state.md` — current state including the unified-path refactor that just shipped
- `supabase/migrations/0040_pending_digest_items.sql` — existing schema, the table getting two new columns
- `agents/ella/passive_dispatch.py` — to confirm `pending_digest_items` insert sites (don't modify; just understand)
- `api/ella_daily_digest_cron.py` — pattern to mirror for the new cron (auth, recipient resolution, audit row pattern, Slack post via `shared.slack_post.post_message`)
- `api/accountability_notification_cron.py` — second reference pattern, since it posts to a Slack *channel* (not a DM) which is what we need here
- `shared/slack_post.py` — the `post_message` helper used everywhere
- `vercel.json` — cron schedule + function entry pattern
- `docs/runbooks/cron_schedule.md` — ADR 0003 EST/UTC mapping convention

## Architecture — overview

### How it fits

Pure additive layer. The decision Haiku continues to set `digest_flag=true|false` on every message per the unified-path spec. The dispatch layer continues to write `pending_digest_items` rows for any flagged message. The daily digest cron continues to drain unsent items at 16:30 EDT into Scott + Drake's DMs.

What's new: a separate cron, firing every 15 minutes, scans `pending_digest_items` for rows that have aged past 2 hours without any `team_member` message in the source channel. For each such row, post the flagged message to `#unanswered-channels` with @-mentions of the primary advisor + Scott. Mark the row so it doesn't post again.

The "marked" state is independent of the daily digest's "sent" state. A flagged message can be:
- Unanswered-flagged AND in tomorrow's digest (the 2h timer fired; the digest will also show it tomorrow because it's a flagged item from this 24h window).
- Unanswered-flagged AND already sent in today's digest (rare timing — message lands at 14:00, digest fires at 16:30 with it included, then 16:00+2h=18:00 the unanswered cron sees no human response and posts to channel).
- Sent in digest but never unanswered-flagged (human responded within 2h — happy path).
- Unanswered-flagged but human responded between the 2h check and the cron firing (small race, acceptable).

These are all fine. The two layers are independent surfaces with no conflict.

### Channel post format

Plain Slack message in `#unanswered-channels`:

```
🔔 Unanswered for 2h — {Client Name}
<@U_SCOTT_ID> <@U_ADVISOR_ID> — this message has been sitting without an advisor response.

> {one-line snippet of triggering message, max 200 chars}

Ella's read: {digest_category} — {haiku_reasoning truncated to 200 chars}
Posted: {time_ago} by {client name}
{slack_permalink}
```

The @-mentions are real Slack user mentions (the `<@U…>` syntax). This pings Scott + the primary advisor as a notification. If the message is from a client who doesn't have a primary advisor assigned (edge case), only Scott gets @-mentioned.

If the primary advisor IS Scott (some clients have Scott as their primary), de-duplicate the @-mentions so Scott isn't pinged twice.

### Kill switch

New env var `ELLA_UNANSWERED_FLAGGER_ENABLED` (defaults to `'true'`). When `!= 'true'`, the cron exits early with an audit row noting it was disabled. Lets Drake turn off the safety net if it gets noisy or for maintenance without code changes.

## What changes — by file

### New: `supabase/migrations/0041_pending_digest_items_unanswered_flag.sql`

Migration number assumed `0041` since `0040` is the unified-path one. Builder verifies against `supabase/migrations/` before writing.

```sql
ALTER TABLE pending_digest_items
  ADD COLUMN unanswered_posted_at timestamptz,
  ADD COLUMN unanswered_post_slack_channel_id text,
  ADD COLUMN unanswered_post_slack_ts text;

-- Partial index for the cron's scan query: unposted items aged past 2h.
CREATE INDEX pending_digest_items_unanswered_scan_idx
  ON pending_digest_items (created_at)
  WHERE unanswered_posted_at IS NULL;
```

Notes:
- `unanswered_posted_at` is the dedup key. Set when the cron posts. NULL means "still eligible for the 2h check."
- `unanswered_post_slack_channel_id` + `unanswered_post_slack_ts` record where the post landed so we have an audit trail (and so we could later edit/resolve the post if we ever build that v2 feature).
- Partial index keyed on `created_at` filtered to `unanswered_posted_at IS NULL` keeps the scan fast as historical posted rows accumulate.
- No CHECK constraints, no enums — keep it simple, free-text channel/ts strings.

**Hard stop:** Builder writes the SQL, runs a dry-read (no apply), surfaces the diff to Drake in the report. Drake reviews + confirms before apply. Gate (a) — SQL review.

**Dual-verification post-apply:** Schema reality (`SELECT column_name FROM information_schema.columns WHERE table_name = 'pending_digest_items'` shows the 3 new columns; `pg_indexes` shows the new index) AND ledger registration (`SELECT version FROM supabase_migrations.schema_migrations WHERE version = '0041'`).

Schema doc `docs/schema/pending_digest_items.md` updated to describe the new columns + their relationship to the unanswered flagger.

### New: `api/ella_unanswered_flagger_cron.py`

Mirror the shape of `api/ella_daily_digest_cron.py` for the auth + slack post + audit row patterns, and `api/accountability_notification_cron.py` for the channel-post pattern.

**Schedule:** `*/15 * * * *` (every 15 minutes, all hours, all days). Vercel cron syntax. No timezone considerations because it runs 24/7.

**Auth:** `CRON_SECRET` validation, same pattern as other crons.

**Logic flow:**

1. Check `ELLA_UNANSWERED_FLAGGER_ENABLED`. If `!= 'true'`, write a `webhook_deliveries` audit row with `source='ella_unanswered_flagger'`, `payload={'disabled': true}`, and return 200 OK.

2. Resolve the `#unanswered-channels` Slack channel ID. Two approaches:
   - **A.** Env var `ELLA_UNANSWERED_CHANNEL_SLACK_ID` set in Vercel — Drake provides the ID. Simple, explicit.
   - **B.** Look up by name from `slack_channels` table where the channel-name matches.

   **Lean: A.** Cleaner, doesn't depend on slack_channels having the channel rowed. Drake sets gate (d).

3. Query `pending_digest_items` for rows where:
   - `unanswered_posted_at IS NULL`
   - `created_at <= now() - interval '2 hours'`
   - `created_at >= now() - interval '7 days'` (don't post about messages that are a week old — backstop against any cron-paused-for-days scenario)

   Limit to 50 rows per cron tick to keep the cron fast. If there's a backlog, subsequent ticks drain it. JOIN to `clients` for name + primary CSM via `client_team_assignments`.

4. For each candidate row, check whether any `team_member` message has been posted in the source channel AFTER `pending_digest_items.created_at`:

   ```sql
   SELECT 1 FROM slack_messages
   WHERE slack_channel_id = $1
     AND author_type = 'team_member'
     AND sent_at > $2
   LIMIT 1
   ```

   Where `$1 = pending_digest_items.slack_channel_id` and `$2 = pending_digest_items.created_at`. If a row comes back, this candidate has been answered — mark `unanswered_posted_at = now()` with `unanswered_post_slack_channel_id = NULL` and `unanswered_post_slack_ts = NULL` (to indicate "resolved before post" rather than "posted"). Skip to next candidate.

   If no row comes back, this is genuinely unanswered. Proceed to step 5.

5. Resolve recipients:
   - Scott's slack_user_id: query `team_members` where `access_tier='head_csm'` AND `archived_at IS NULL`. Use the first row's `slack_user_id`. If zero rows, post anyway without Scott @-mention but log warning.
   - Primary advisor's slack_user_id: from the JOIN result, query `team_members.slack_user_id` for the client's primary CSM (looked up via `client_team_assignments` WHERE role='primary_csm' AND unassigned_at IS NULL).
   - Deduplicate if Scott is also the primary advisor.

6. Build the channel-post body (template from the architecture overview above). Resolve the Slack permalink — same pattern as the daily digest (`https://<workspace>.slack.com/archives/<channel_id>/p<ts_no_dot>`).

7. Post to `#unanswered-channels` via `shared.slack_post.post_message`. Capture the returned `ts`.

8. Update `pending_digest_items` row:
   ```sql
   UPDATE pending_digest_items
   SET unanswered_posted_at = now(),
       unanswered_post_slack_channel_id = $1,
       unanswered_post_slack_ts = $2
   WHERE id = $3
   ```

9. Write a `webhook_deliveries` audit row per posted item with `source='ella_unanswered_flagger'`, `payload={'pending_digest_item_id': ..., 'client_id': ..., 'recipient_slack_user_ids': [...], 'channel_post_ts': ..., 'message_text_snippet': ...}`.

10. Return 200 OK with a summary of how many items were checked, how many marked resolved-before-post, how many actually posted.

**Failure isolation:** If posting to `#unanswered-channels` fails for one item, log + audit + continue. Don't let one Slack API failure break the entire drain.

**Idempotency:** Running the cron twice in quick succession should produce no duplicate posts. The `unanswered_posted_at IS NULL` filter in step 3 plus the UPDATE in step 8 ensures this. Within a single cron tick, the SELECT-then-UPDATE pattern has a small race window if two crons fire simultaneously (unlikely with 15-min schedule, but possible). Acceptable residual risk.

**Cost.** Cron fires 96 times per day. Each fire does 1 SELECT against `pending_digest_items` (indexed scan, fast), 0-50 SELECTs against `slack_messages` (one per candidate, indexed), 0-50 Slack API posts. At current message volume this is trivial — well under 100 posts/day even on the worst day. Slack API rate limits aren't a concern.

### Modify: `vercel.json`

Add function entry for `api/ella_unanswered_flagger_cron.py` with `maxDuration: 60`. Add cron schedule `*/15 * * * *` pointing at `/api/ella_unanswered_flagger_cron`.

### Modify: `.env.example`

Add:
```
# Ella unanswered-message flagger
ELLA_UNANSWERED_FLAGGER_ENABLED=true
ELLA_UNANSWERED_CHANNEL_SLACK_ID=  # Slack channel ID for #unanswered-channels — required in production
```

### Documentation updates

- **`docs/state.md`** — new entry for today covering the unanswered flagger shipped state. Migration count 40 → 41. Python serverless function count 12 → 13.
- **`docs/agents/ella/ella.md`** — add a new section "Unanswered Message Flagger" describing the safety-net behavior, the 2-hour window, the channel destination, and how it relates to the daily digest.
- **`docs/runbooks/cron_schedule.md`** — add `*/15 * * * *` for the unanswered flagger.
- **`docs/runbooks/ella_unanswered_flagger.md`** (NEW) — full runbook covering schedule, query logic, recipient resolution, kill switch, failure modes, manual curl format. Mirror the FAQ digest runbook structure.
- **`docs/schema/pending_digest_items.md`** — update for the 3 new columns.

### Tests

**`tests/api/test_ella_unanswered_flagger_cron.py`** (new):
- Happy path: 1 item past 2h with no team_member response → posts to #unanswered-channels, marks row, writes audit.
- Item past 2h with team_member response after `created_at` → marks row resolved, no post.
- Item past 2h with team_member response BEFORE `created_at` → still posts (intervention must be after the flagged message).
- Item < 2h old → ignored.
- Item already posted (`unanswered_posted_at IS NOT NULL`) → ignored.
- Item older than 7 days → ignored (backstop).
- Kill switch off → no work done, audit row says disabled.
- Multiple items in one tick → each handled independently; one failure doesn't break others.
- Scott + advisor same person → @-mention deduplicated.
- No primary advisor for client → only Scott @-mentioned.
- No Scott found in team_members → log warning, post without Scott @-mention.
- `ELLA_UNANSWERED_CHANNEL_SLACK_ID` unset → 500 error + audit row noting config gap.
- Auth: missing/wrong CRON_SECRET → 401.

**`tests/agents/ella/test_passive_dispatch.py`** — verify the new columns don't break existing insert paths (the spec doesn't change the insert; should be a no-op test addition).

**Existing tests:** All should stay green. Hard stop: `pytest tests/` must not regress below 610 (last shipped count).

## Hard stops

1. **Pre-apply migration SQL review.** Builder writes `supabase/migrations/0041_pending_digest_items_unanswered_flag.sql`, runs a dry-read, surfaces SQL diff to Drake in the report. Wait for explicit "approved" before applying. Gate (a).

2. **Migration apply discrepancy.** If dual-verify post-apply shows schema reality and ledger don't match, STOP.

3. **Test suite regression.** `pytest tests/` must pass at ≥610 tests. If lower, STOP.

4. **`tsc --noEmit` or `npm run lint` regression.** Must stay clean. Any new warnings → STOP.

5. **`ELLA_UNANSWERED_CHANNEL_SLACK_ID` not set in Vercel pre-deploy.** Builder will not push the deploy until Drake confirms the env var is set in Vercel Production. Gate (d).

## Smoke test gate (post-deploy)

Drake's gate (c). The smoke test for this is *temporal* — by nature the cron's behavior takes 2 hours to observe end-to-end. Two-phase smoke:

**Phase 1: Immediate (post-deploy, manual curl).**

1. Verify Vercel build succeeded.
2. Manually curl the cron with the production CRON_SECRET to confirm it runs cleanly: `curl -s -X POST -H "Authorization: Bearer <PROD_CRON_SECRET>" "https://ai-enablement-sigma.vercel.app/api/ella_unanswered_flagger_cron"`. Expected: 200 OK, response body summarizes "checked N candidates, posted 0" (no items are 2h old yet that haven't been answered).
3. Check `webhook_deliveries` for the audit row.
4. Verify the cron entry shows up in Vercel's cron dashboard.

**Phase 2: Live behavioral check (over the next few hours).**

5. Drake or any test user posts an emotional/money/confusion-style message in `#ella-test-drakeonly` that Haiku will flag (e.g., "I'm really frustrated"). Confirm a `pending_digest_items` row is written.
6. Do NOT respond as a team_member in the channel for 2 hours.
7. ~2:15 hours later, the next cron tick should fire the unanswered post to `#unanswered-channels` with @-mentions of Scott + the primary advisor (which in test channel might be Drake or whoever is mapped).
8. Verify the row's `unanswered_posted_at` is set.

**Phase 3: Resolution path.**

9. Post a separate test message and within 2 hours have someone (you posting as team_member via test_mode) post any message in the channel.
10. ~2 hours after the test message, the cron tick should mark the row resolved (no post to #unanswered-channels) and `unanswered_posted_at` is set but `unanswered_post_slack_channel_id` is NULL.

Phase 2 and 3 take ~2 hours each to fully observe but Phase 1 is the immediate gate. Builder writes the report after Phase 1 passes. Phases 2 and 3 are Drake's own verification; if they fail Drake hands back.

## What could go wrong

1. **Two crons fire simultaneously and post duplicate.** The 15-minute schedule plus Vercel's cron infrastructure should make this very unlikely, but the SELECT-then-UPDATE pattern has a race window. Mitigation: acceptable residual risk at our volume. If it happens, the duplicate is a one-time UX issue, not data corruption.

2. **`#unanswered-channels` doesn't exist or Scott didn't invite the Ella bot.** Slack API returns an error. Mitigation: the cron logs the error in the audit row but keeps processing other items. Drake checks audit rows post-deploy to confirm posts are landing.

3. **`team_members` query returns wrong Scott (zero or multiple head_csm rows).** Same pattern as daily digest. Zero rows → no Scott @-mention, still post. Multiple rows → @-mention all of them (correct behavior).

4. **Cron over-fires on backlog.** If the cron has been off for a day, when it turns back on it might try to post 100+ unanswered items at once. Mitigation: 50-row limit per tick + 7-day backstop in the query. Worst case: 50 items posted in one tick, 50 more in the next 15 minutes. Acceptable.

5. **The 2-hour window catches active conversations that just paused.** Client posts an emotional message at 11am, advisor replies at 11:05am, client follow-up question at 11:10am goes unanswered, 1:10pm the unanswered cron posts about the 11:10am message. Acceptable: the 11:10am message DID go unanswered, even if the 11:00 one didn't. Scott seeing it in `#unanswered-channels` is the right behavior; it tells him "this thread has stalled."

6. **Slack permalink format edge cases.** Same as daily digest. Builder copies the working pattern from the daily digest's permalink builder.

7. **Posts to `#unanswered-channels` accumulate over time and channel becomes noisy.** Acceptable for v1. If this becomes a problem, future spec can add resolution-edit behavior or auto-archive after N hours.

## Mandatory doc updates

- `docs/state.md` (today's entry)
- `docs/agents/ella/ella.md` (new "Unanswered Message Flagger" section)
- `docs/runbooks/cron_schedule.md` (new cron entry)
- `docs/runbooks/ella_unanswered_flagger.md` (NEW)
- `docs/schema/pending_digest_items.md` (column additions)
- `.env.example` (two new vars)

## Done means

- Migration 0041 applied, dual-verified, ledger registered.
- All file changes pushed to `main`, Vercel deploy successful.
- `pytest tests/` passes at ≥610 tests, no regression.
- `tsc --noEmit` + `npm run lint` clean.
- Phase 1 smoke (manual curl) passes — cron runs cleanly, audit row written.
- Spec status flipped to `shipped` in same Builder commit-sequence as the report.
- Report at `docs/reports/ella-unanswered-message-flagger.md` follows 6-section structure.

Drake's gates:
- (a) SQL review for migration 0041 — pre-apply.
- (b) Any genuinely context-confusing decision Builder hits — surface immediately.
- (c) Phase 1 smoke (immediate) — post-deploy. Phase 2 + 3 (behavioral, ~2-4 hours) are Drake's own follow-up verification, NOT a Builder gate.
- (d) `ELLA_UNANSWERED_CHANNEL_SLACK_ID` set in Vercel Production env vars — pre-deploy. `ELLA_UNANSWERED_FLAGGER_ENABLED=true` set in Vercel Production env vars — pre-deploy.
