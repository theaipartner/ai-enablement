# Ella Unanswered Flagger — Client-Only Filter + Terse Post Format

**Slug:** ella-unanswered-flagger-client-only-and-terse-post
**Status:** in-flight

## Context

Two operational adjustments to `api/ella_unanswered_flagger_cron.py` (shipped 2026-05-14 via `docs/specs/ella-unanswered-message-flagger.md`). Both are Drake-driven from observed production behavior:

**(1) Flagger is surfacing team_member-authored messages.** The cron's intent is "client needs a human" — but `pending_digest_items` carries digest items regardless of who authored the triggering message. When a team_member posts a question in a client channel that no other team_member follows up on within 2h, the cron flags it to `#unanswered-channels`, mentioning the primary advisor + Scott. Wrong audience for that signal — Scott doesn't need a feed of "team_members asked something that didn't get a team_member follow-up."

**(2) The post format is too long.** Current shape is six lines (alert header / mention line / message quote / Ella's read + reasoning / posted-by / permalink). At any meaningful traffic volume the `#unanswered-channels` feed becomes scroll-heavy. Drake's read: "check out [client] channel" plus a permalink is enough — Scott and the advisor click through to see the actual context in the source channel. The current format duplicates information they're about to see anyway.

**Both changes scope to the unanswered flagger only.** Daily digest stays unchanged: team_member messages still surface there because the digest is a wider-net awareness surface ("here's everything Ella flagged across all channels in the last 24h"). The unanswered flagger has a narrower intent ("this specific client message needs eyes right now"), so the filter is appropriate there but not in the digest. The two surfaces are co-located in `pending_digest_items` but logically distinct in audience.

**Doesn't change schema, doesn't change crons, doesn't change kill switches.** Single-file change to the cron logic + format. No migration. Runs forward from deploy.

## Acclimatization checklist

Builder reads these first and confirms understanding in 3-4 bullets:

- `CLAUDE.md` § Working Norms — particularly the "minimal surface" pattern.
- `docs/state.md` — the 2026-05-14 entry for `ella-unanswered-message-flagger` and today's three Ella ships (routing gate, idempotency, dedup-message-changed).
- `api/ella_unanswered_flagger_cron.py` — full file. Pay particular attention to: `_fetch_candidates` (the SQL query that gets digest items), `_has_human_intervention` (the existing 2h-team_member-intervention check, which already queries `slack_messages.author_type='team_member'`), and `_format_channel_post` (the format being shortened).
- `supabase/migrations/0040_pending_digest_items.sql` + `0041_pending_digest_items_unanswered_flag.sql` — confirms `pending_digest_items` doesn't carry author_type (it lives in `slack_messages.author_type`).
- `agents/ella/passive_dispatch.py` — particularly `insert_digest_item` and the various `_insert_pending_digest_item` helpers — confirms team_member-authored messages currently DO write digest items (the daily digest's wide-net intent is preserved here; only the unanswered flagger filters).
- `docs/runbooks/ella_unanswered_flagger.md` (if it exists — Builder verifies) for runbook precedent on documenting the post format.

## Architecture — what changes

### (1) Filter to client-authored messages only

`_fetch_candidates` currently returns every `pending_digest_items` row aged into the [2h, 7d] window with `unanswered_posted_at IS NULL`. After this spec, it also needs to know the author type of each candidate's triggering message so non-client rows can be filtered out.

**Approach: two queries, JS-side join + filter.**

The data lives in two tables:
- `pending_digest_items.triggering_message_slack_user_id` + `slack_channel_id` + `triggering_message_ts` — identifies the source message.
- `slack_messages.author_type` (filtered to `'client'`) — the author classification.

The join key is `(slack_channel_id, slack_ts)` which is the unique index on `slack_messages`. PostgREST embedded-resource expansion across this join is awkward because `pending_digest_items` doesn't have a foreign key to `slack_messages` (the FK shape is `slack_channel_id text` + `triggering_message_ts text`, not a single referenced id). Cleaner pattern: fetch candidates as today, then bulk-fetch matching `slack_messages` rows by IN-clause, build a lookup dict in Python, filter candidates whose source author is `client`.

**Concrete shape:**

```python
def _fetch_candidates(db, now_utc: datetime) -> list[dict[str, Any]]:
    """Unposted rows aged into the [2h, 7d] window, oldest first,
    capped at _MAX_PER_TICK. Filters to client-authored triggering
    messages only (team_member / ella / bot / workflow / unknown
    excluded — the unanswered flagger surfaces 'client needs a human',
    not advisor questions to the team).
    """
    stale_before = (now_utc - _STALE_AFTER).isoformat()
    backstop_after = (now_utc - _BACKSTOP).isoformat()
    resp = (
        db.table("pending_digest_items")
        .select("*")
        .is_("unanswered_posted_at", "null")
        .lte("created_at", stale_before)
        .gte("created_at", backstop_after)
        .order("created_at", desc=False)
        .limit(_MAX_PER_TICK)
        .execute()
    )
    candidates = list(resp.data or [])
    if not candidates:
        return []
    return _filter_to_client_authored(db, candidates)


def _filter_to_client_authored(
    db, candidates: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Filter candidates whose triggering message has
    `author_type='client'` in slack_messages. Two-query pattern (one
    for candidates, one for the slack_messages author lookup) to keep
    the candidate fetch simple and the join JS-side.

    Defensive on missing rows: a candidate whose source slack_messages
    row doesn't exist (rare — would mean the message got ingested into
    pending_digest_items but never into slack_messages; possible during
    a partial-failure window in the realtime pipeline) is treated as
    NOT client-authored and filtered out. The cron is a safety net,
    not a backstop for ingestion gaps.
    """
    # Build the (channel, ts) tuples we need to look up. Same
    # composite key the migrations use for the unique index.
    keys = [
        (c.get("slack_channel_id"), c.get("triggering_message_ts"))
        for c in candidates
    ]
    keys = [(ch, ts) for ch, ts in keys if ch and ts]
    if not keys:
        return []

    # PostgREST can't filter on a composite IN clause directly, but
    # since slack_channel_id is usually shared across many candidates
    # in a single tick, group by channel and query per-channel with
    # an IN on slack_ts. Caps the round-trips at the channel count.
    by_channel: dict[str, list[str]] = {}
    for ch, ts in keys:
        by_channel.setdefault(ch, []).append(ts)

    author_types: dict[tuple[str, str], str] = {}
    for channel_id, ts_list in by_channel.items():
        try:
            resp = (
                db.table("slack_messages")
                .select("slack_channel_id,slack_ts,author_type")
                .eq("slack_channel_id", channel_id)
                .in_("slack_ts", ts_list)
                .execute()
            )
            for row in resp.data or []:
                key = (row["slack_channel_id"], row["slack_ts"])
                author_types[key] = row.get("author_type") or "unknown"
        except Exception as exc:
            logger.warning(
                "ella_unanswered_flagger_cron: author lookup failed "
                "channel=%s: %s",
                channel_id,
                exc,
            )
            # On lookup failure, skip ALL candidates in this channel
            # for this tick — they get retried next tick. Better to
            # under-flag than over-flag during a transient blip.
            continue

    filtered = [
        c for c in candidates
        if author_types.get(
            (c.get("slack_channel_id"), c.get("triggering_message_ts"))
        ) == "client"
    ]
    return filtered
```

**Side benefit:** the `author_type='bot'` known issue (Ella's posts misclassifying as bot, logged in known-issues today) is also handled implicitly by this filter — bot-classified messages won't pass the `author_type='client'` check either. Doesn't fix the underlying parser bug, but means the unanswered flagger won't accidentally surface Ella's own posts as "unanswered" while that bug is still open.

### (2) Terse post format

Replace `_format_channel_post` with Option B from the chat:

```python
def _format_channel_post(
    row: dict[str, Any],
    client_name: str | None,
    mention_ids: list[str],
) -> str:
    """Build the channel post for an unanswered flagged message.

    Format (terse — 2026-05-21 simplification):
        <@U001> <@U002> unanswered in {client_name}'s channel ({time_ago}): {permalink}

    The mention is the primary action signal; client_name disambiguates;
    time_ago lets the CSM see at a glance whether it just hit 2h or has
    been sitting all day; the permalink is the action. The full message
    text, Ella's category read, and Haiku's reasoning are NOT included —
    CSMs see them in the source channel after clicking through.

    Backstop on missing data: no mentions falls back to a bare line
    without the leading mention; missing client_name renders
    "(unknown client)"; missing permalink renders empty.
    """
    name = client_name or "(unknown client)"
    mentions = " ".join(f"<@{m}>" for m in mention_ids)
    time_ago = _format_time_ago(row.get("created_at"))
    permalink = _build_message_permalink(
        row.get("slack_channel_id") or "",
        row.get("triggering_message_ts") or "",
    )
    prefix = f"{mentions} " if mentions else ""
    return (
        f"{prefix}unanswered in {name}'s channel ({time_ago}): {permalink}"
    )
```

Drops `_truncate`, `_SNIPPET_MAX`, `_REASONING_MAX` references from this function (the constants might still be used elsewhere — Builder verifies before removing). Drops the `Ella's read: ...` line, the `Posted: ...` line, the message quote block, the `:bell:` alert prefix, and the "this message has been sitting" sentence. Six lines collapse to one.

**Considered but rejected: keeping the message snippet.** Argument for keeping: CSMs can triage from the feed without clicking. Argument against (and what wins): the snippet is read at the source channel anyway when the CSM clicks the permalink, and the snippet's existence is what makes the feed scroll-heavy. The whole point of the change is to make the feed scannable.

### Tests

**`tests/api/test_ella_unanswered_flagger_cron.py` (EXTEND):**

- New test: `_fetch_candidates` returns only client-authored rows when the slack_messages backing table contains mixed author types. Mock the DB to return candidates with mixed `triggering_message_slack_user_id`s, mock `slack_messages` lookup to return author_types `client` / `team_member` / `bot` / `ella` / `unknown` — assert only the client one passes through.
- New test: missing `slack_messages` backing row → candidate filtered out (defensive behavior).
- New test: author lookup raises → all candidates in that channel skipped this tick, others in other channels still process.
- New test: `_format_channel_post` produces the new terse one-line shape with mentions, client name, time_ago, and permalink. Plus variants for missing mentions (no leading space), missing client_name (renders "(unknown client)"), missing permalink (renders empty trailing).
- Update existing tests: any tests asserting the old multi-line format need rewriting to the new shape. Builder reads the existing test file and lists which tests touch the format string.

**Test count target:** +5 new tests at minimum, possibly -2 to -4 if existing tests assert the old format and need consolidation. Net likely +3 to +5. Total suite ≥697 (post-2026-05-21 baseline).

### Documentation updates

- **`docs/state.md`** — new entry today covering the spec. Migration count unchanged. Python serverless function count unchanged. Test count updated.
- **`docs/runbooks/ella_unanswered_flagger.md`** — update the "post format" section if it documents the format, add a "client-only filter" note in the candidate-fetch section.
- **`docs/specs/ella-unanswered-message-flagger.md`** — original spec stays as historical record. NO retroactive editing. The new spec is the corrective.

## Hard stops

1. **Pre-edit verification of `_format_channel_post` callers.** Builder finds every call site of the old format and confirms the new shape lands correctly. Also verifies `_truncate` and the `_SNIPPET_MAX` / `_REASONING_MAX` constants — if they become unused after this edit, remove them; if they're used elsewhere (e.g., in audit-row payload construction), leave them.

2. **Verify the existing 2h-intervention check still works.** `_has_human_intervention` already queries `slack_messages.author_type='team_member'` to detect human follow-up. That check stays untouched — different concern (intervention detection ≠ author filter). Builder reads it to confirm the two filters don't conflict and writes a one-line comment in the new helper noting the distinction.

3. **The daily digest must NOT be affected.** `api/ella_daily_digest_cron.py` reads `pending_digest_items` separately and surfaces ALL author types (intended wider-net). Builder confirms by reading the daily digest cron that this spec's changes don't touch its query path. If they do somehow, STOP.

4. **No migration.** This spec is code-only. If Builder finds itself drafting a migration, STOP.

5. **Test suite regression.** `pytest tests/` must pass at ≥697 (the post-2026-05-21-spec baseline). If lower, STOP.

6. **`tsc --noEmit` + `next lint` regression.** Must stay clean. No TS touched.

7. **No production traffic generation.** No Slack posts, no cron triggers, no curl-replays.

## Smoke test gate (post-deploy)

Drake's gate (c). Two test cases, both organic (no special setup needed):

1. **Client message goes 2h+ without team_member response → flagged.** This is the normal happy path. Pick (or wait for) a real client message that goes unanswered past 2h. Verify in `#unanswered-channels` that the post appears with the new terse format: `<@scott> <@advisor> unanswered in {client}'s channel ({time_ago}): {permalink}`. Verify the format renders cleanly (mentions resolve, time_ago is human-readable, permalink is clickable).

2. **Team_member message goes 2h+ without follow-up → NOT flagged.** Wait for or post a team_member message in a client channel that doesn't get follow-up within 2h. Verify in `#unanswered-channels` that NO post appears for it. Verify in SQL that the digest item still exists in `pending_digest_items` (the daily digest still picks it up) but `unanswered_posted_at` stays NULL:

   ```sql
   SELECT id, slack_channel_id, triggering_message_ts,
          triggering_message_slack_user_id, created_at, unanswered_posted_at
   FROM pending_digest_items
   WHERE created_at > now() - interval '3 hours'
     AND triggering_message_slack_user_id IN (
       SELECT slack_user_id FROM team_members
       WHERE archived_at IS NULL AND slack_user_id IS NOT NULL
     )
   ORDER BY created_at DESC;
   ```

   Expected: rows present, `unanswered_posted_at` NULL on all of them.

Both must pass before flipping spec to `shipped`. If case 1 fails, Builder writes PARTIAL report. If case 2 fails (team_member message DID get flagged), STOP — that's the primary fix, smoke didn't validate it.

**Important on timing:** smoke takes ≥2h to observe organically because of the staleness window. Don't expect same-session validation. Drake watches the channel over the next few hours after deploy and confirms in chat when both cases have been observed.

## What could go wrong

1. **The author-type lookup adds round-trip latency per tick.** Today's cron runs a single query for candidates. After this spec, it runs N+1 queries (one for candidates + one per distinct channel). At typical traffic (~10 candidates / tick across ~5 channels), that's 6 queries / tick at 4 ticks/hour = 24 queries/hour. Negligible against Supabase's free-tier limits. Builder verifies query count via the existing logger.info lines.

2. **A candidate whose slack_messages row doesn't exist gets filtered out.** Defensive choice — better than flagging a message we can't verify the author of. Edge case: a digest item that landed via the dispatch layer but whose `_upsert_message` failed silently. In practice this should never happen (the dispatch layer fires after upsert in the realtime ingest path). Builder reads `_maybe_dispatch_passive_monitor` to confirm the ordering and notes the assumption in the new helper's docstring.

3. **The terse format loses information CSMs were using.** If Scott or Lou were reading the message snippet or Ella's reasoning in the channel post and triaging without clicking through, the new format breaks that workflow. Worth a quick conversation with them post-deploy to confirm they're okay with click-through-required triage. If not, future spec adds back the snippet or the category.

4. **The team_member messages that don't fire the flagger still consume `pending_digest_items` storage.** That table grows linearly with all flagged messages forever (no archive policy today). The team_member filter doesn't add to that growth; it's a read-side filter. But worth noting as a follow-up — eventually `pending_digest_items` needs an archive/cleanup policy. Out of scope for this spec.

5. **What if `author_type` is missing or null in `slack_messages`?** Per the parser's `_resolve_author`, every row gets an `author_type` value (defaults to `unknown` for unresolvable). The filter `== "client"` cleanly excludes `unknown` along with `team_member` / `bot` / `ella` / `workflow`. Acceptable.

## Mandatory doc updates

- `docs/state.md` (today's entry)
- `docs/runbooks/ella_unanswered_flagger.md` (post format + client-only filter sections)

## Done means

- All file edits pushed to `main` per the one-logical-change-per-commit rule (suggested split: commit 1 = new `_filter_to_client_authored` helper + `_fetch_candidates` rewire; commit 2 = `_format_channel_post` rewrite; commit 3 = tests; commit 4 = docs). Builder's call.
- `pytest tests/` passes at ≥697 tests. No regression.
- `tsc --noEmit` + `next lint` clean.
- Two smoke test cases observed in production over the next few hours post-deploy per the gate (c) section. Drake confirms both in chat.
- Spec status flipped to `shipped` after smoke confirmation.
- Report at `docs/reports/ella-unanswered-flagger-client-only-and-terse-post.md` follows 6-section structure.

Drake's gates:
- (a) None — no migrations, no irreversible actions.
- (b) Any genuinely context-confusing decision Builder hits — surface immediately. Specifically: if the existing `_format_channel_post` callers or related constants aren't cleanly removable, surface before guessing.
- (c) Two smoke test cases — Drake observes organically over the next 2-4 hours post-deploy and confirms both passed. Spec stays `in-flight` until Drake signals both.
- (d) None — no env var changes, no credential touches.
