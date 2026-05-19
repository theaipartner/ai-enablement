# Report (PARTIAL): Ella @-Mention Structural Override
**Slug:** ella-at-mention-structural-override
**Spec:** docs/specs/ella-at-mention-structural-override.md
**Status:** halted — code shipped + pushed + deploy auto-triggered; awaiting Drake's gate (c) 6-case smoke in `#ella-test-drakeonly` (cases 1-3 are the critical regression validation). No gate (a)/(d). `ella-passive-monitoring-default-on` remains correctly blocked until this smoke passes; acknowledged + untouched as instructed.

> Read order: **§ What's needed to unblock** → **§ Verification** → **§ Surprises**.

## Acclimatization (3-4 bullets, per spec)

- v1's + v2's + the smoke diagnostic confirmed: with `skip` available in the decision Haiku's output schema, no amount of prompt copy ("lean toward respond" → "skip is FORBIDDEN" → "NEVER skip + worked example") reliably stopped the model from rationalizing into it. The 22:20 UTC smoke still produced `skip` on a bare `<@Ella>` from Drake citing "advisor + ACTIVE conversation + already escalated."
- `passive_monitor._evaluate` already runs gates + KB + recent_context + primary_csm + speaker resolve once for both paths; adding a branch right before the LLM call is the natural minimum-churn place to fork.
- `digest_response.generate_response` returns substantive Haiku-written answers; the new `warm_opener` shape needs a tighter prompt template (no KB block, ≤120 tokens, "1-sentence invite" instruction) so the model can't drift into a substantive answer.
- **Reality-check:** the spec's pseudocode shows the branch at dispatch level taking `(payload, kb_chunks, recent_context)`; the current architecture has `evaluate_passive_trigger` produce a `PassiveEvaluation` that `persist_passive_evaluation` consumes. Cleanest place for the branch is therefore split: LLM-call branch inside `_evaluate` (puts `MentionClassification` on a new field of `PassiveEvaluation`), then dispatch branches on `mention_classification is not None`. Behavior-equivalent to the spec's intent; flagged as the small architecture decision (Surprise 1).

## 1. Files touched

**Created (2):**
- `agents/ella/mention_classifier.py` — `MentionClassification` dataclass + `classify_mention_response()` + verbatim classifier system prompt + user template + parser with `warm_opener` safer-fallback. ~280 lines.
- `tests/agents/ella/test_mention_classifier.py` — 14 tests covering happy paths, the structural "skip is not in the enum" guarantee, attempted-skip → fallback, malformed JSON → fallback, exception → fallback, digest-flag independence, cost accounting.

**Modified — source (3):**
- `agents/ella/passive_monitor.py` — `_HAIKU_SYSTEM_PROMPT` pruned of every @-mention overlay (the `# THE @-MENTION OVERRIDE` section, the `# WORKED EXAMPLE`, the conditional qualifiers in `# THE THREE DECISIONS` `skip` bullet + `# DEFAULT STANCES`, item 4 of `# READING THE CONTEXT`, the @-mention parenthetical in `# READING TIME-STAMPED CONTEXT`); new preamble explicitly scopes the prompt to PASSIVE OBSERVATION; coherence re-read passed (hard stop #5). `_evaluate` branches on `payload.is_ella_mentioned` → `classify_mention_response`. New `mention_classification: Any = None` field on `PassiveEvaluation` (typed `Any` to avoid an import cycle; documented).
- `agents/ella/passive_dispatch.py` — `persist_passive_evaluation` branches on `evaluation.mention_classification is not None` → `_dispatch_mention`. New `_dispatch_mention` routes the 4 shapes; new `_insert_pending_for_mention_sonnet` + `_insert_mention_digest_item` helpers; mention-path `trigger_metadata` carries `mention_classifier_shape` + `mention_classifier_reasoning` for `/ella/runs` attribution.
- `agents/ella/digest_response.py` — `generate_response` gained `mode: str = 'substantive'` parameter; new `_WARM_OPENER_USER_PROMPT_TEMPLATE` (no KB block, "1-sentence invitation" instruction); max_tokens clamps to 120 in warm_opener mode; exception-path canned line is mode-appropriate.

**Modified — tests (3):**
- `tests/agents/ella/test_passive_monitor.py` — 9 obsolete @-mention-overlay tests removed (per spec § Tests: "Remove tests for @-mention behavior in the decision Haiku — those move to test_mention_classifier"); 1 test updated to drop a removed prompt assertion (the @-mention-specific sentence in TIME-STAMPED CONTEXT); 1 test repointed to `mentioned=False` (non-mention path is what `decide_passive_response` exercises now); 1 consolidated `test_prompt_has_no_at_mention_overlay` asserting absence + new preamble. Net: 33 → 25 monitor tests.
- `tests/agents/ella/test_passive_dispatch.py` — extended with 7 mention-path tests: branching guarantee (no `decide_passive_response` call), 4 shapes route correctly, combined-cost write, digest-flag→item with classifier shape on the row, full ack-and-escalate fan-out.
- `tests/agents/ella/test_digest_response.py` — extended with 3 mode tests: warm_opener uses dedicated template + 120-token cap; substantive default unchanged + 800-token cap; warm_opener exception returns a mode-appropriate canned opener.

**Modified — docs (3):** `docs/agents/ella/ella.md` (Trigger section rewritten for two-path LLM dispatch + new "@-Mention Handling (Structural)" section + changelog entry), `docs/state.md` (2026-05-19 late-evening entry), `docs/runbooks/ella_passive_monitoring.md` (pipeline § rewritten for two-path).

**Deleted / migrations / crons / env:** none.

## 2. What I did, in plain English

Took @-mention handling out of the decision Haiku entirely. New `agents/ella/mention_classifier.py` houses a tiny classifier whose output schema is `respond_haiku | respond_sonnet | acknowledge_and_escalate | warm_opener` — `skip` literally cannot be filled, and the parser collapses any attempted "skip" to `warm_opener`. `passive_monitor._evaluate` now branches on `is_ella_mentioned`: true → classifier, result lands on the new `PassiveEvaluation.mention_classification` field; false → existing decision Haiku. `passive_dispatch.persist_passive_evaluation` checks `mention_classification` first and routes through new `_dispatch_mention` covering the 4 shapes (response Haiku posts for `respond_haiku`; `pending_ella_responses` queue with the existing Sonnet shim for `respond_sonnet`; ack + escalations row + DM fan-out + digest item for `acknowledge_and_escalate`; warm_opener mode of response Haiku for `warm_opener`). `digest_response.generate_response` gained `mode='warm_opener'` with a tighter user template + 120-token cap so the model can't drift into a substantive answer. Pruned the decision Haiku prompt of every @-mention overlay (no @-mention reaches it anymore; those sections were rationalization surface). Documented + tested + pushed.

## 3. Verification

- **Classifier prompt verbatim** asserted byte-equal against the spec's fenced block — `VERBATIM MATCH` (hard stop #4 satisfied).
- **Decision Haiku prompt coherence** re-read end-to-end (hard stop #5): preamble + WHO ELLA IS + THE THREE DECISIONS + READING TIME-STAMPED CONTEXT + READING THE CONTEXT + DIGEST FLAG + DIGEST CATEGORY + DEFAULT STANCES + OUTPUT FORMAT — flows cleanly without orphan references. Only two `@-mention` strings remain, both intentional (the preamble's scoping sentence, and the "Do NOT include an @-mention of the advisor in the ack" formatting rule).
- **`pytest tests/`:** **653 passed**, 0 failed (baseline 635; +18 net). Re-run after `ruff format` — still 653.
- **`ruff check`** on the 8 touched files: **All checks passed!** (`ruff format` reformatted 5 files; no semantic change).
- **`tsc --noEmit`** exit 0; **`next lint`** clean (hard stop #3 — no TS touched).
- Structural assertions spot-checked: `skip not in mention_classifier._SHAPES`; `_SAFER_FALLBACK_SHAPE == 'warm_opener'`; prompt explicitly forbids `skip`; an attempted `"shape": "skip"` from a model collapses to `warm_opener` with `unknown_shape='skip'` in reasoning.
- **Smoke (gate c):** NOT performed — needs the live deploy + Slack. Unblock set below.

## 4. Surprises and judgment calls

1. **The branch is in `_evaluate`, not at the dispatch layer.** The spec's pseudocode showed the branch at dispatch level taking `(payload, kb_chunks, recent_context)`. The current architecture fetches those upstream and passes them through `PassiveEvaluation`. I added a `mention_classification` field to `PassiveEvaluation` and branched in `_evaluate` (call classifier when mentioned) + in `persist_passive_evaluation` (route mention-path when the field is set). Behavior-equivalent to the spec's intent; the LLM is still split exactly as the spec wants. Flagging because the file split differs from the pseudocode.
2. **`mention_classification` typed `Any` to avoid an import cycle.** `MentionClassification` lives in `mention_classifier.py` which imports from shared modules; `passive_monitor.py` is imported by `mention_classifier.py`'s caller chain. Typing the field as `Any` with a comment is the simplest fix; alternative is `TYPE_CHECKING`-guarded import. Trivial decision, surfaced for visibility.
3. **9 obsolete @-mention-overlay tests removed.** Per spec § Tests: "Remove tests for @-mention behavior in the decision Haiku (those move to test_mention_classifier)." All v1/v2 prompt-presence assertions for the now-absent sections + the v1/v2 mention-behavior plumbing tests were deleted. Added 1 consolidated `test_prompt_has_no_at_mention_overlay` asserting absence + new preamble. Net test delta: monitor 33 → 25, plus +14 classifier + +7 dispatch + +3 digest_response = +18 over the 635 baseline.
4. **`_dispatch_mention` writes digest items with `haiku_decision=f"mention/{shape}"`.** The schema column is free-text; using the prefixed value lets `/ella/runs` and audit SQL distinguish mention-path entries from decision-Haiku-path entries trivially. Spec didn't prescribe the column value for mention; this is my call, flagged.
5. **Cost model:** mention-path runs the classifier (~1 small Haiku call) plus the response Haiku for `respond_haiku`/`warm_opener` shapes. Today's mention-path was decision Haiku + response Haiku. Net: roughly flat (classifier + response Haiku ≈ decision + response Haiku — same call count, same model).
6. **The pre-existing out-of-scope `unused import pytest` in `tests/agents/ella/test_agent.py`** is still untouched. Same precedent as the previous three reports.
7. **`ella-passive-monitoring-default-on` left untouched.** Acknowledged per Drake's instruction; remains correctly blocked behind this spec's smoke (over-skip must be confirmed fixed before 7→~130 channel scale-up).

## 5. Out of scope / deferred

- Gate (c) smoke (the 6 cases) — § What's needed to unblock.
- `ella-passive-monitoring-default-on.md` — blocked, untouched.
- The pre-existing `test_agent.py` ruff item — pre-dates this; hygiene-pass candidate.

## 6. Side effects

- **No** Slack posts, DB writes, migrations, external API calls. Tests fully mock DB/Slack/Anthropic. `agents/ella/passive_monitor.py` docstring updated (no behavior change) to reflect the new two-path architecture.
- Git: 3 commits **pushed to `origin/main`** (`1fd5994` code+tests, `e0004d9` docs, + this report) — Vercel auto-deploy triggered (no gate (a)/(d) this spec).

## What's needed to unblock — gate (c), Drake

Once the Vercel build is green, the 6-case smoke in `#ella-test-drakeonly`. Cases 1-3 are the critical regression validation — if they still produce `skip`, the structural bypass isn't firing.

For cases 1-4, **verify in `/ella/runs` that `trigger_metadata.mention_classifier_shape` is set and `trigger_metadata.haiku_decision` is null/absent**. For cases 5-6, the reverse.

1. **Bare `<@Ella>` from Drake (advisor) with stale/resolved escalation in channel history.** Expected: a single response posted (most likely `warm_opener`). `mention_classifier_shape` populated; **NOT** `haiku_decision='skip'`. **This is the v1/v2 failure case.**
2. **Bare `<@Ella>` from Drake in a quiet channel.** Expected: `warm_opener`, friendly short opener posted.
3. **`<@Ella> what does the discovery section cover?`** Expected: `respond_haiku`, KB-grounded answer posted.
4. **`<@Ella>` with emotional content** ("@Ella I'm really frustrated, where do I actually find this stuff?"). Expected: `acknowledge_and_escalate`, warm ack posted in-channel, DMs to Scott + primary advisor fire.
5. **Non-@-mention message in active conversation** (chitchat without `<@U…>`). Expected: routes through decision Haiku, `skip`. `haiku_decision='skip'` set; `mention_classifier_shape` null/absent.
6. **Non-@-mention emotional content** ("I'm really frustrated lately" without `<@Ella>`). Expected: decision Haiku, `acknowledge_and_escalate`. Confirms emotional handling on the non-mention path is unaffected by this surgery.

If cases 1-3 still produce no response, STOP and hand back the failing `agent_runs` row contents — the structural bypass isn't firing and we need to root-cause. On a clean 6-case pass, Builder rewrites this report dropping `(PARTIAL)`, flips the spec `Status:` to `shipped`, and `ella-passive-monitoring-default-on` becomes eligible to run.
