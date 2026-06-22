# Report: Ella Unanswered Flagger — Client-Only Filter + Terse Post Format
**Slug:** ella-unanswered-flagger-client-only-and-terse-post
**Spec:** docs/specs/ella-unanswered-flagger-client-only-and-terse-post.md

## Files touched

**Modified:**
- `api/ella_unanswered_flagger_cron.py` — added new helper `_filter_to_client_authored` that runs after the existing `_fetch_candidates` SELECT, groups candidates by channel, queries `slack_messages` once per distinct channel (eq `slack_channel_id` + in_ `slack_ts`), and JS-side filters to `author_type='client'` only. Removed `_REASONING_MAX` (dead after format rewrite). Rewrote `_format_channel_post` from a six-line block to a one-line `<@scott> <@advisor> unanswered in {client}'s channel ({time_ago}): {permalink}` shape.
- `tests/api/test_ella_unanswered_flagger_cron.py` — extended the `_Chain.execute` dispatch for `slack_messages` to handle the new query shape (no `eq` on `author_type`, `in_` on `slack_ts`); added a `_backing_message(item, author_type)` helper for seeding the new client-only filter's lookup; updated 7 existing tests to seed a client-authored backing row so candidates survive the new filter; added 9 new tests covering the filter behavior (4 tests) and the terse format (5 tests).
- `docs/state.md` — 2026-05-21 entry covering both changes (client-only filter + one-line post format).
- `docs/runbooks/ella_unanswered_flagger.md` — added a "Candidate filter — client-only" section before the channel-post-format section; rewrote the channel-post-format section to show the new one-line shape.

No new files created. No migrations. No env-var changes. No TS files touched. No production data touched.

## What I did, in plain English

Walked the spec's acclimatization checklist (CLAUDE.md operational patterns, the 2026-05-14 + four 2026-05-21 state.md entries, the cron file, its tests, the runbook) and confirmed in 4 bullets:

- **`_fetch_candidates`** ran a single SELECT against `pending_digest_items` filtered by `unanswered_posted_at IS NULL` + `created_at` window. The new filter slots in after this returns — same pattern the spec calls out (Approach: two queries, JS-side join + filter).
- **`_format_channel_post`** built a six-line block using `_truncate` + `_SNIPPET_MAX` + `_REASONING_MAX`. After the rewrite: `_REASONING_MAX` becomes dead (only used here); `_SNIPPET_MAX` and `_truncate` stay because they're still used in audit-row payload construction at lines 251 + 275 (`message_text_snippet` field). Per hard stop #1, verified before removing.
- **`_has_human_intervention`** queries `slack_messages.author_type='team_member'` for a different reason (intervention detection on follow-up messages, NOT author classification of the flagged message). Two coexisting filters with distinct semantics — documented this in the new helper's docstring per hard stop #2.
- **Daily digest cron** is a separate file (`api/ella_daily_digest_cron.py`) and reads `pending_digest_items` independently. Confirmed not affected per hard stop #3.

Four-commit execution per the spec's suggested split:

**Commit 1** added `_filter_to_client_authored` and rewired `_fetch_candidates`. The new helper groups candidates by channel and runs one `slack_messages` SELECT per distinct channel (using `eq slack_channel_id` + `in_ slack_ts`). On lookup failure for a channel, all candidates in that channel get skipped for this tick (retry next tick) — better to under-flag than over-flag during transient blips. Missing backing rows → filtered out (defensive, per spec). Because the new filter's query shape is different (no `eq` on `author_type`, has `in_` on `slack_ts`), the existing fake DB in the test file needed extending; otherwise the 7 happy-path tests would drop candidates as `author_type=None != 'client'`. Bundled the test-harness update + the `_backing_message(item)` seeding helper + the 7 affected test updates into this commit so the suite stayed green at commit boundary. 15/15 existing tests passed after the bundle.

**Commit 2** rewrote `_format_channel_post` to the terse one-line shape, removed `_REASONING_MAX` (dead after the rewrite). Existing 15 tests still passed because their format assertions checked for `<@U_SCOTT>` / `<@U_ADVISOR>` / client name substring presence — all still present in the new format.

**Commit 3** added 9 new tests:
- 4 filter-behavior tests: drops team_member-authored candidates (the primary bug fix), drops bot-authored candidates (pins the side benefit), drops candidates with missing backing rows (defensive), per-channel lookup failure isolated (one bad channel doesn't kill the tick).
- 5 format tests: happy-path one-line shape with mentions + client + time_ago + permalink, removal of legacy fields (alert bell, "Ella's read", snippet, posted-by line), no-mentions / missing-client-name / degenerate-permalink edge cases.

The degenerate-permalink test's initial assertion was slightly off (expected double-space after colon); fixed during commit-3 development. Final 24/24 flagger tests green.

**Commit 4** updated state.md with a 2026-05-21 entry and rewrote/added two runbook sections (new "Candidate filter — client-only" before the post-format section; rewritten post-format section showing the one-line shape + backstop behavior).

Hard stops verified:
- **#1 (pre-edit verification of format callers):** confirmed via grep that `_format_channel_post` is called from one site in `run_ella_unanswered_flagger_cron`. `_REASONING_MAX` is only used inside `_format_channel_post` (removed). `_SNIPPET_MAX` and `_truncate` are used in two other audit-payload sites — kept.
- **#2 (intervention check still works):** confirmed by re-running `test_human_response_after_marks_resolved_no_post` (passes after the spec change). Distinction documented in the new helper's docstring.
- **#3 (daily digest unaffected):** confirmed by reading the daily-digest cron file's table query. The two crons read `pending_digest_items` independently with no shared query path.
- **#4 (no migration):** held — schema unchanged.
- **#5 (pytest ≥697):** 706 passed (+9 net).
- **#6 (tsc + next lint clean):** both green.
- **#7 (no production traffic):** confirmed — no Slack posts, no cron triggers, no curl-replays.

## Verification

**pytest:** 706 passed, 2 warnings (pre-existing supabase library deprecation, unrelated). Baseline 697; net +9 from this spec.

**tsc --noEmit:** clean.

**next lint:** `✔ No ESLint warnings or errors`.

**Targeted re-runs:**
- After commit 1 (filter helper + existing test updates): 15/15 flagger tests + 697 full suite.
- After commit 2 (format rewrite): 15/15 flagger tests + 697 full suite.
- After commit 3 (new dedup-specific tests): 24/24 flagger tests + 706 full suite.

**Critical tests that pin the production fix:**
- `test_filter_drops_team_member_authored_candidates` — would have caught the original misfire if it had existed: a team_member's question + a client message both in the candidate set; only the client's surfaces.
- `test_format_terse_one_line_happy_path` — pins the new shape.
- `test_format_terse_drops_legacy_fields` — pins the removal of snippet / category / reasoning / alert-bell / posted-by lines.

## Surprises and judgment calls

**The existing fake DB's `slack_messages` query handling assumed `eq author_type`.** Pre-spec, the only query against `slack_messages` was the intervention check (`eq slack_channel_id + eq author_type='team_member' + gt sent_at`). The new filter has a different shape (`eq slack_channel_id + in_ slack_ts`, no author_type filter). I extended the fake DB to handle both shapes by branching on whether `slack_ts` appears in the `_eq` dict as an `("in", set(...))` tuple. The alternative — separate fake-DB classes per test concern — would have been a larger refactor. Branching on query shape is uglier but localized.

**Defensive choice on missing backing rows.** The spec said "treated as NOT client-authored and filtered out." I went with that; the alternative ("treat unknown author as client and flag anyway") would risk false-positive flags. The cron is a safety net, not a backstop for ingestion gaps — if a digest item exists without a `slack_messages` row, something else is broken upstream, and the flagger shouldn't paper over it. Documented in the helper's docstring.

**Per-channel failure isolation, not per-candidate.** When the per-channel `slack_messages` lookup raises, ALL candidates in that channel get dropped this tick. The alternative — finer-grained per-candidate retry — would require a different query shape (one lookup per candidate) and triple the round-trip count for marginal benefit. The current design retries-next-tick at the channel granularity; channels that lookup-fail stay safe (no false flags) and recover when the transient blip clears. Documented per hard stop #5 in the spec ("surface ambiguity") — this is the chosen design, not a hidden trade-off.

**Did not rewrite the existing format-assertion tests separately.** The existing 15 tests included some that read the body string (`test_happy_path_posts_and_marks`, `test_scott_is_primary_advisor_dedup`, etc.) but their assertions were already loose enough (`"<@U_SCOTT>" in body`, `body.count("<@U_SCOTT>") == 1`) to survive the format change. No update needed. The spec hinted "Update existing tests: any tests asserting the old multi-line format need rewriting" — turned out none of them did. Net test count: +9 instead of +5 to +3 the spec floated.

**The fake DB's table() factory is now monkeypatched in one test for per-channel failure simulation.** `test_filter_skips_channel_on_author_lookup_failure` needed a way to make ONLY the bad channel's `slack_messages` lookup raise while leaving the good channel intact. I monkeypatched `fake_db.table` to wrap each `_Chain` instance and raise selectively on the bad-channel's `slack_messages` execute. Ugly but localized to that one test. The alternative (extending the `_Chain` class with a per-channel failure mode) would have polluted the fake DB for unrelated tests. Trade made consciously.

## Out of scope / deferred

- **Smoke gate (Drake's gate (c))**: two cases need organic observation over the next 2-4 hours — (1) real client message goes 2h+ → flagged with new terse format, (2) real team_member message goes 2h+ → NOT flagged, SQL verifies digest row exists with `unanswered_posted_at` NULL. Per the spec, this is "Drake watches the channel over the next few hours after deploy and confirms in chat when both cases have been observed." Spec stays `in-flight` until then. Same Option A pattern as prior in-flight specs today.
- **`author_type='bot'` fix for Ella's posts** — logged as a known-issues entry on 2026-05-21 from the duplicate-webhook diagnostic, NOT touched in this spec. The new client-only filter handles bot-tagged rows defensively (filters them out) but doesn't fix the root cause.
- **`pending_digest_items` archive/cleanup policy** — table grows linearly with all flagged messages forever. Per spec § What could go wrong #4, worth noting but out of scope.
- **CSM workflow validation** — the terse format assumes click-through-required triage. If Scott or Lou were triaging directly from the channel post snippet, the new format breaks that. Per spec § What could go wrong #3, worth a quick conversation post-deploy.

## Side effects

None beyond the committed diff. No Slack posts, no DB writes outside local commits, no production data touched. The kill switch and `passive_monitoring_enabled` state are untouched. Five commits this run: 4 logical + 1 report.

## What's needed to unblock

**Drake's gate (c) — two organic smoke cases over the next few hours:**

1. Real client message goes 2h+ without team_member response → flagged in `#unanswered-channels` with the new terse one-line format (mentions resolve, time_ago is readable, permalink is clickable).

2. Real team_member message in a client channel goes 2h+ without follow-up → NOT flagged. Verifiable via SQL on `pending_digest_items` showing the digest row present but `unanswered_posted_at` NULL (the digest still picks it up; only the flagger filters).

If case 1 fails, write a partial report. If case 2 fails (team_member message DID get flagged), stop — that's the primary fix and the smoke didn't validate it. If both pass, flip the spec to `shipped`.

This is the fourth Ella ship in two days closing out operational gaps surfaced by the 2026-05-19 EOD misfire and its diagnostic aftershocks. The system's now in a tighter operational shape: routing gate + idempotency gate (post-parse) + client-only flagger filter + terse one-line `#unanswered-channels` posts.
