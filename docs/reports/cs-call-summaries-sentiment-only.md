# Report: cs-call-summaries: sentiment-only Slack post
**Slug:** cs-call-summaries-sentiment-only
**Spec:** docs/specs/cs-call-summaries-sentiment-only.md

## Files touched

**Modified:**
- `agents/gregory/cs_call_summary_post.py` — replaced `_format_review_message` body with sentiment-only render; deleted `_format_review_items` helper (now dead code); updated module docstring's "Message format" block and the function docstring to reflect sentiment-only.
- `scripts/test_cs_call_summary_locally.py` — Test 7: dropped 5 multi-section assertions (`pain_header`, `wins_header`, `pivots_header`, `evidence_italic`, `who_inline`); added 3 new negative assertions (`no_pain_section`, `no_wins_section`, `no_pivots_section`) anchoring the format change. Test 11: rescoped per spec Choice A — dropped `pain_points` seed, folded `**GHL setup**` into `sentiment_arc` so all four existing mrkdwn-cleanup assertions still have valid anchors.
- `docs/state.md` — appended one-line note under the M6.1 CS visibility entry capturing the format tightening + helper deletion + test 11 rescope.

**Created:** none.

**Deleted:** `_format_review_items` (function-level deletion inside `cs_call_summary_post.py` — counted under "Modified").

## What I did, in plain English

Tightened the M6.1 CS call summary Slack post from a four-section review-shape (Sentiment + Pain points + Wins + Conversation pivots) down to sentiment-only + a `View in Gregory` deep link. CSMs click through to Gregory for the rest. The change is intentionally small: only `_format_review_message`'s body, its docstring, the module's format docstring, and the dead helper deletion. Skip behavior, audit ledger semantics, sentinel labels, mrkdwn-safety-pass mechanics, top-header rendering, `content_source='call_review'` tagging — all unchanged. Harness assertions for tests 7 and 11 updated to match the new shape per the spec's prescribed pattern; tests 1, 2, 3, 4, 5, 6, 8, 9, 10 unchanged.

## Verification

**Harness:** `.venv/bin/python scripts/test_cs_call_summary_locally.py` → **63/63 checks passed.** Matches the spec's expected count math (pre-change 65, drop 5 + add 3 = -2 net → 63). All 11 numbered tests green. Fixture self-seeded + hard-deleted in teardown; 7 review docs and 10 audit rows cleaned up.

**Production payload SELECT (Step 5):** `select webhook_id, processed_at, payload from webhook_deliveries where source='cs_call_summary_slack_post' and processing_status='processed' order by processed_at desc limit 3` returned three recent posts (all from 2026-05-11 20:31–20:51 UTC), all `content_source='call_review'`. Audit payload shape (`call_id, csm_name, client_name, content_source, fathom_external_id`) matches the spec's pre-change assumption exactly — no production drift.

**Grep proof (acclimatization Step 1 + Step 2):**
- `_format_review_message`: 2 hits in `cs_call_summary_post.py` only — the caller at line 218 and the def at line 425. No other modules.
- `_format_review_items`: 0 hits post-edit. Pre-edit had 4 hits all inside `cs_call_summary_post.py` (the def + 3 calls inside `_format_review_message`). Safe deletion.

**Before / after sample.** For test 7's seeded review (sentiment + 1 pain + 1 win + 1 pivot), the pre-change render was:

```
*Test CSM / CS Summary Test <token>*

*Sentiment*
Started anxious; ended energized after we mapped next steps.

*Pain points*
• GHL setup is blocking launch — _We can't get the funnel published_

*Wins*
• Closed first paying client — _Just signed Acme yesterday_

*Conversation pivots*
• Sidestepped the revenue question (who: client) — _Pivoted to talking about marketing_

<https://ai-enablement-sigma.vercel.app/calls/...|View in Gregory>
```

Post-change render of the same seed:

```
*Test CSM / CS Summary Test <token>*

*Sentiment*
Started anxious; ended energized after we mapped next steps.

<https://ai-enablement-sigma.vercel.app/calls/...|View in Gregory>
```

The Pain/Wins/Pivots sections are dropped entirely; the deep link does the work of surfacing the rest. (The pre-change sample above is reconstructed from the function signature + the seed; the audit ledger doesn't store rendered text, only the metadata.)

## Surprises and judgment calls

**Updated the module docstring's "Message format" block alongside the function change.** The spec didn't explicitly call out the module-level docstring at lines 39–59, but it documents the rendered Slack message shape and would be stale if untouched. Replaced the four-section block with the sentiment-only block + a short note explaining the 2026-05-11 change and the new skip-when-sentiment-missing contract. Low-risk; future readers see accurate surface-area docs.

**Skipped the optional Test 8 rename (`no_pain_header` → `no_pain_section`).** Spec marked this as optional ("only if you want naming consistency with Test 7's new asserts"). Per the spec's stated minimum-change principle, I left Test 8's assertion names alone. The behavior is unchanged; only the naming consistency is slightly off between tests 7 and 8 now. If you want consistency, a one-line rename PR closes it; not load-bearing today.

**No surprises in production payload data.** Step 5 was the most likely source of a hard stop — if a recent hotfix had drifted production away from the four-section assumption, this would have surfaced. It didn't. The three most-recent posts are all the spec's assumed pre-change shape.

## Out of scope / deferred

- **Retroactive backfill of historic audit rows.** Per spec § Context Drake-confirmed design call — explicitly not in scope.
- **No new `content_source` enum value.** Per spec — `'call_review'` keeps describing the data source.
- **No CLAUDE.md change.** State.md M6.1 line carries the operational note; CLAUDE.md is the always-loaded surface and shouldn't churn on operational rollout-shape changes.
- **No runbook touched.** There's no runbook for `cs_call_summary_post.py` per spec § Mandatory doc updates.

## Side effects

- **Harness ran against cloud Postgres** — 7 review docs (`documents` table) and 10 audit rows (`webhook_deliveries`) were seeded and hard-deleted in the test's teardown. Zero residual rows. Confirmed by the teardown log line: `"Hard-deleted fixture (client + csm + assignment), 7 review doc(s), and 10 audit row(s)"`.
- **No real Slack posts.** Every test patches `agents.gregory.cs_call_summary_post.post_message` so no real `chat.postMessage` fires. The harness Slack-channel-id values are mock strings (`C_TEST_CHANNEL_*`) that never hit the API.
- **One read-only SELECT** against `webhook_deliveries` for the Step 5 payload sample. No writes.
- **Ephemeral `/tmp/cs_summary_payload_sample.py` script** created during execution and deleted post-run. Not committed.
