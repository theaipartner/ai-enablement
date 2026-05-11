# cs-call-summaries: sentiment-only Slack post
**Slug:** cs-call-summaries-sentiment-only
**Status:** in-flight

## Context

Today's CS call summary Slack post (M6.1, `agents/gregory/cs_call_summary_post.py`) renders a four-section review-shaped message: Sentiment + Pain points + Wins + Conversation pivots, plus a "View in Gregory" deep link. Drake wants the Slack message tightened to **sentiment only + link** for easier reading; CSMs click through to Gregory for the rest.

This is the smallest possible change to `_format_review_message` plus deletion of the now-unused list helper. Everything else — skip behavior, audit ledger, sentinel labels, mrkdwn safety pass, header, link label, `content_source='call_review'` tag — stays exactly as it is today.

**Drake-confirmed design calls:**
- If the sentiment is missing (which in practice means the review didn't parse / wasn't generated), skip the post entirely. Same shape as today's "degenerate review" check.
- Header (`*CSM / Client*`), Sentiment label, and link text (`View in Gregory`) all stay as-is.
- No new `content_source` enum value; `'call_review'` keeps describing the data source.
- No retroactive backfill of historic audit rows.

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. `agents/gregory/cs_call_summary_post.py:_format_review_message` is the *only* code surface that renders the message. Confirm no other caller relies on its return shape carrying the multi-section body. Grep for `_format_review_message` and `cs_call_summary_post` across `agents/`, `api/`, `ingestion/`, `scripts/`.
2. `_format_review_items` is only called from inside `_format_review_message`. Confirm it has no other callers anywhere in the repo before deleting it. Grep `_format_review_items`.
3. The harness file is `scripts/test_cs_call_summary_locally.py`. Tests **1, 7, 8, 11** all assert on the multi-section output and will fail without updates. Read each before editing.
4. The harness's `RUN_TOKEN` / per-run-unique-email pattern and the teardown contract (hard-delete fixture + audit rows + seeded docs) is the working norm — preserve it. Don't rewrite the harness shape; just update the assertions in the four affected tests.
5. State.md's Batch A M6.1 entry references `cs_call_summary_post.py`. No update needed unless the work shifts the message format in a way state.md should record — and it does, so the one-line note in § Mandatory doc updates applies.

## Work

### Step 1 — Edit `_format_review_message`

In `agents/gregory/cs_call_summary_post.py`, replace the body of `_format_review_message` with a sentiment-only render. The new function:

- Builds the sections list with **only** the sentiment branch (the existing `if isinstance(sentiment_arc, str) and sentiment_arc.strip()` block).
- Drops the three section branches: `pain_points`, `wins`, `dodged_questions`.
- Keeps everything else identical: the `if not sections: return None` degenerate check (now triggered solely by missing/empty sentiment), the `deep_link` formatting, the `**{csm_name} / {client_name}**` header, the trailing `<{deep_link}|View in Gregory>` line, and the `"\n\n".join(sections)` body assembly.

The function's docstring should be updated to reflect that only Sentiment renders. Keep the explanation of the `**Header**` Markdown choice — that mechanism still applies to both the top header and the `**Sentiment**` line.

### Step 2 — Delete `_format_review_items`

Once Step 1's edit removes its only caller, `_format_review_items` is dead code. Delete it.

If the grep in acclimatization Step 2 surfaces any other caller (it shouldn't, but check), stop and surface to Drake.

### Step 3 — Update the harness assertions

`scripts/test_cs_call_summary_locally.py` — four tests need their assertions updated. The test *bodies* (fixture seeding, mocking, the call into `maybe_post_cs_call_summary`) stay the same. Only the expected-output assertions change.

**Test 1 (happy path):** keep `1.posted`, `1.slack_ok`, `1.channel`, `1.text.csm_name`, `1.text.client_name`, `1.text.sentiment_header`, `1.text.deep_link`, `1.audit.row`, `1.audit.source`. The seeded review still has `pain_points` populated; the assertion that this content *no longer renders* is implicit (no test currently asserts pain text presence on test 1). No new assertions needed. Test passes as long as the existing checks still hold under the new format.

**Test 7 (review found, populated):** assertions to drop entirely (these are gone in the new format):
- `7.text.pain_header`
- `7.text.wins_header`
- `7.text.pivots_header`
- `7.text.evidence_italic`
- `7.text.who_inline`

Assertions to keep: `7.posted`, `7.content_source`, `7.text.sentiment_header`, `7.text.no_double_star`, `7.text.no_triple_hash`, `7.audit.content_source`.

Add a new assertion in their place to make the format change explicit and prevent regression:
- `7.text.no_pain_section` — assert `"*Pain points*"` is NOT in `text`.
- `7.text.no_wins_section` — assert `"*Wins*"` is NOT in `text`.
- `7.text.no_pivots_section` — assert `"*Conversation pivots*"` is NOT in `text`.

**Test 8 (review found, only sentiment populated):** assertions stay the same. The seeded review already has sentiment-only; the existing checks (`8.has_sentiment` + the three `no_*_header` checks) are already exactly what the new format produces. Tighten: rename `8.no_pain_header` → `8.no_pain_section` etc. only if you want naming consistency with Test 7's new asserts. Optional.

**Test 11 (mrkdwn safety net):** seeded review currently has `pain_points` with rogue `**bold**` in description + evidence. Under the new format, those fields don't render at all — the cleanup-pass test no longer exercises them. Two choices:

- **Choice A (preferred):** rewrite the seeded review so the rogue Markdown lives in `sentiment_arc` only (it already partially does — the test seeds `### Status header` and `**important**` inside sentiment_arc). Drop the pain_points seed entirely. Keep all four existing assertions (`11.no_triple_hash`, `11.no_double_star`, `11.inline_bold_normalized`, `11.sentiment_bold_normalized`). The test still proves the mrkdwn pass cleans rogue Markdown in sentiment.
- **Choice B:** delete test 11 entirely. Reduces coverage; not preferred.

Builder: use Choice A. State.md's eventual report should mention that test 11 was rescoped to sentiment-only mrkdwn cleanup; no coverage loss.

### Step 4 — Run the harness

```bash
.venv/bin/python scripts/test_cs_call_summary_locally.py
```

Expect all results green. The exact passed-check count drops by 5 (the five dropped assertions in test 7) and rises by 3 (the three new no-section assertions). Builder reports the final count in the report — it should match the pre-change count minus 2.

If anything fails red, stop and surface — don't paper over with assertion tweaks.

### Step 5 — Verify against a recent real post

Optional but worth it: query `webhook_deliveries` for the most recent successful CS call summary post and read the payload to confirm what the *current* shape looks like in production. Builder doesn't need to run the new code against production data — just confirm the pre-change shape matches what this spec assumes (four-section review-shaped body). Single SELECT:

```sql
select webhook_id, processed_at, payload
  from webhook_deliveries
 where source = 'cs_call_summary_slack_post'
   and processing_status = 'processed'
 order by processed_at desc
 limit 3;
```

If the payload shape looks wildly different from the spec's assumption, stop and surface — the spec was drafted against a stale read of the module.

## Hard stops

- **`_format_review_items` has a non-test caller other than `_format_review_message`.** Grep first; surface if true.
- **Harness fails red after the assertion updates.** Don't patch over with more assertion tweaks — surface so the underlying behavior change can be reviewed.
- **The recent-post payload query (Step 5) shows a format that contradicts the spec's assumption.** Means production has drifted from the code (unlikely, but possible if a hotfix landed off-radar). Surface.
- **The change accidentally widens behavior** — e.g., somehow a review with missing sentiment but populated other sections starts posting under the new code. The degenerate-return contract (`return None` when `sections` is empty) must still fire when sentiment is missing. This is the core invariant of the change; if test 8's pattern (sentiment-only review) renders fine AND a hypothetical reverse-test (sections-without-sentiment) returns None, the invariant holds.

## What could go wrong

- **Test 1 seeds a review with both `pain_points` and `sentiment_arc` populated.** Under the old format that produces a multi-section post; under the new format that produces sentiment-only. The existing test 1 assertions don't check for absence of pain — they check for presence of sentiment + CSM name + deep link. All those still pass. The implicit format change isn't asserted by test 1, but is asserted by test 7's new no-section checks. Coverage of the change lives in test 7.
- **`markdown_to_mrkdwn` behaves differently with shorter input.** It shouldn't — the converter operates per-line on bold/italic regex; reducing the number of lines reduces work but doesn't change semantics. The four cleanup-pass assertions in test 11 (now scoped to sentiment_arc only) verify the converter still runs.
- **A downstream surface assumes the multi-section format.** No downstream surface reads `cs_call_summary_post`'s Slack post output — Slack messages are write-only to the channel. The function's return dict shape doesn't change. No risk here, but worth saying out loud.

## Mandatory doc updates

- **`docs/state.md`** — append a single line under the existing M6.1 CS visibility entry noting that the CS call summary Slack post format was tightened to sentiment-only on the rollout date. Match the existing single-line operational-note style. No CLAUDE.md change.
- **No runbook change.** There's no runbook for `cs_call_summary_post.py` directly; the M6.1 entry in state.md is the operational reference.

## Commit + report

Per CLAUDE.md § Commits, one logical change per commit. Suggested:

- `agents/gregory: render only sentiment + link in cs call summary Slack post`
- `tests: update cs_call_summary harness assertions for sentiment-only format`
- `docs: note CS call summary format tightening in state.md`
- `docs: add report for cs-call-summaries-sentiment-only`

Builder can bundle the code + test commits if they feel coupled — the principle is one logical change, not a rigid four-commit shape.

Report at `docs/reports/cs-call-summaries-sentiment-only.md`. Include:

- A before/after sample of the rendered message (paste from a captured test 7 `text` variable, both shapes).
- The harness pass count, pre- and post-change.
- Grep results from acclimatization Steps 1 + 2 (proving no orphan callers).
- The most-recent-production-post payload sample from Step 5 (confirms pre-change shape matched the spec assumption).
- Any surprises surfaced during execution.
