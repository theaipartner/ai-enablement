# Report: Ella curriculum retrieval regression — what's in the KB vs what she can reach (read-only)
**Slug:** ella-kb-retrieval-access-diagnostic
**Spec:** docs/specs/ella-kb-retrieval-access-diagnostic.md

## Files touched

Created:
- `docs/reports/ella-kb-retrieval-access-diagnostic.md` — this report.

Modified:
- `docs/specs/ella-kb-retrieval-access-diagnostic.md` — `Status:` flipped from `in-flight` to `shipped`.

No code, schema, or migration changes. A throwaway diagnostic script at `/tmp/repro_search.py` exercised `shared/kb_query.py.search_for_client` against the live OpenAI embedding API + cloud Supabase (6 embedding calls + DB reads). Not committed.

## What I did, in plain English

**The diagnostic's hypothesis framing (A–E retrieval-layer filters) is wrong. Retrieval works fine; the regression is in the mention classifier's escalation rule.**

I walked the five hypotheses one by one and refuted each before reproducing Ella's exact retrieval path against a known-failing query. Once retrieval came back with the right chunks, I traced the post-retrieval pipeline and found the actual failure site: the mention classifier introduced 2026-05-19 (`agents/ella/mention_classifier.py`) reads "what's covered in module X" as a *navigation* question and picks `acknowledge_and_escalate` before the retrieval chunks are even considered. The Anthropic usage-cap (2026-05-21 → today) had been masking this because the classifier was failing with `BadRequestError` and falling back to `warm_opener`; now that the cap is raised, the classifier succeeds and the over-aggressive escalation rule is showing through.

**Direct evidence — Drake's three test queries from 2026-05-23 16:18-16:19 UTC:**

| Query | Classifier shape | What posted |
|-------|------------------|-------------|
| "what's covered in module 3?" | `acknowledge_and_escalate` | "I don't have curriculum module details in my KB — let me get Scott..." + DM'd Scott |
| "whats covered in the sales module" | `acknowledge_and_escalate` | "I don't have the sales module curriculum details in my KB. Scott will walk you through..." + DM'd Scott |
| "whats the PACE framework" | `respond_haiku` | "I don't have details on a PACE framework in the curriculum KB I can access. Let me get Scott..." |

The first two are the **primary regression** — classifier escalating curriculum-content questions as navigation. The PACE one is a **secondary issue** of a different shape (semantic-retrieval ranking) that I document below for completeness.

## Verification

**Step 1 — Curriculum inventory (refutes hypothesis A).** `documents` grouped by `(source, document_type, is_active)`:

| source | document_type | is_active | n |
|--------|---------------|-----------|----|
| manual | course_lesson | **true** | **276** |
| manual | course_lesson | false | 21 |
| fathom | call_summary | true | 169 |
| fathom | call_transcript_chunk | true | 530 |
| fathom | call_transcript_chunk | false | 27 |
| fathom | call_review | false | 122 |

**276 active `course_lesson` docs** including the whole sales module ("Sales First Principles", "Why Qualification Is a Sales Skill", "The 7 Steps to an Objectionless Sales Call", "Sales State of Mind", "Sales Bad Habits and How to Kill Them", etc.). The 21 inactive course_lessons are narrow sales-team-management ones ("Onboarding and Training Your Sales Team", "Tracking and Managing Sales Team Performance") — not the general curriculum. The 122 inactive call_review docs are deliberately deactivated per Call Review V1 (separate concern, not curriculum). **Hypothesis (A) `is_active` flipped: REFUTED.**

**Step 2 — Chunk inventory (refutes hypothesis D).** Active course_lesson docs join to **592 chunks, all embedded, all 1536 dims** — exact match to `text-embedding-3-small`. Plus 5660 active `call_transcript_chunk` rows (1536 dims), and 169 active `call_summary` (1536 dims). Every embedded chunk in the KB is uniformly 1536-dim. No `embedding_model` column exists in `document_chunks` (no per-chunk model indicator), but dim uniformity rules out a mixed-model situation. **Hypothesis (D) embedding mismatch: REFUTED.**

**Step 3 — Reproduce Ella's retrieval (refutes hypotheses B, C, E).** Called `shared.kb_query.search_for_client(query, client_id="22dbdbb9-eae8-465f-b819-1b5349b14447" /* Ruphael G */, k=8, include_global=True)` — the exact signature `passive_monitor.py:357` uses. Results across six probe queries:

```
QUERY: 'what is covered in module 3?'
  8 chunks, all course_lesson, sim 0.34-0.39
  top: Why Market Selection Is the Most Important Decision You'll Make (0.394)

QUERY: "what's covered in the sales module"
  8 chunks, all course_lesson, sim 0.41-0.46
  top: Why Sales Is the Other Half of the Equation (0.458)
       Welcome to The AI Partner Programme (0.446)
       Sales Call Audit Template (0.427)
       Sales First Principles (0.422)
       Sales Metrics Tracker (0.414)

QUERY: 'PACE framework'
  8 chunks, all course_lesson, sim 0.35-0.43
  top: The 4-Layer Framework (0.425), The Cold Call Framework (0.411),
       Monthly Review Framework (0.398), Niche Scoring Framework (0.381)
       — note: NO chunk with the actual S(PACE) acronym surfaces

QUERY: 'sales first principles'
  8 chunks, sim 0.49-0.64, top hit "Sales First Principles" (0.637)

QUERY: 'objection handling'
  8 chunks, sim 0.41-0.53, top hit "Why Objections Happen and What They Really Mean" (0.528)

QUERY: 'qualification on a sales call'
  8 chunks, sim 0.52-0.63, top hit "Why Qualification Is a Sales Skill" (0.631)
```

**Five of six queries return correct, relevant `course_lesson` chunks with reasonable similarity scores.** Retrieval is functioning. With `include_global=True` (Ella's call), all non-call_summary docs are eligible regardless of channel client. With `min_similarity=0.0` (Ella's call), the threshold isn't filtering anything. **Hypotheses (B), (C), (E): all REFUTED for the general failure pattern.**

**The sixth query — "PACE framework" — uncovered something separate.** A `~*` regex query against chunk content shows **15 chunks contain "PACE" in body text** — but they're chunks of docs titled "Discovery — Finding the Pain and Collecting Ammo" ("The Situation phase of S(PACE)"), "Presenting the Offer" ("The Establish phase of S(PACE)"), etc. PACE isn't a standalone framework doc; it's the acronym structure of the sales process, mentioned in body text of multiple sales-process chunks. The vector search for "PACE framework" matched other "X Framework" titled docs (4-Layer, Cold Call, Monthly Review) on title-similarity but didn't surface the actual S(PACE)-tagged chunks because their titles don't contain "PACE". The response Haiku then correctly said "I don't see PACE here" — but the right chunks weren't in its input. This is a **retrieval-ranking issue specific to acronym queries**, not a retrieval-access issue. Separate from the main classifier regression.

**Step 4 — Locating the actual failure site (the classifier).** Pulled the three real misfire runs from cloud `agent_runs`. All three were `trigger_type='passive_monitor'`, status `success` or `escalated`. Two were `mention_classifier_shape='acknowledge_and_escalate'` (the classifier itself escalated). One was `mention_classifier_shape='respond_haiku'` (the response Haiku said "I don't have it" when fed the wrong-ranked chunks).

Reading the classifier system prompt at `agents/ella/mention_classifier.py:60-101`, the relevant rule for `acknowledge_and_escalate`:

> "The message asks about platform navigation ('where do I find X' / 'what module is Y in') — the KB has lesson content but not navigation metadata, the advisor handles those."

Drake's questions ("what's covered in module 3" / "what's covered in the sales module") match the literal pattern "what module is Y in" enough for the classifier to pick `acknowledge_and_escalate`. The classifier sees the word "module" + "what's covered" and routes to navigation-escalate before evaluating whether the retrieved chunks could answer it. The competing `respond_haiku` rule ("clear, factual program/curriculum/process question + KB chunks directly address what's being asked") never wins.

**Step 5 — Regression source.** `git log` on the retrieval layer vs the classifier:

- **`shared/kb_query.py`** — 1 commit in history (`43a51b4 scaffold shared/kb_query.py`, the original). No changes. Retrieval has not regressed.
- **`agents/ella/mention_classifier.py`** — most recent commit `1fd5994 fix(ella): @-mention structural override — bypass decision Haiku for mentions` (the 2026-05-19 spec that introduced the classifier as a separate layer for @-mentions). Before this commit, @-mentions went through the decision Haiku (which had a balanced respond-vs-escalate prompt); after it, @-mentions go through this new classifier with its sharper navigation-escalate rule.

**Timing math:** classifier shipped 2026-05-19. Anthropic usage cap hit 2026-05-21 20:55 UTC. Cap was raised today (2026-05-23). So the classifier ran "naked" for ~2 days (2026-05-19 → 2026-05-21) before the cap masked it; today it's running naked again. Drake's "she used to answer these" likely refers to pre-2026-05-19 behavior when the decision Haiku handled @-mentions — that's the model whose prompt was balanced for curriculum content questions, not the new classifier whose prompt over-weights the navigation-escalate rule.

## Surprises and judgment calls

**The spec's hypothesis framing was deliberately wrong-headed in a useful way.** Hypotheses (A)–(E) all point at retrieval; the actual cause is the classifier. The diagnostic was right to enumerate retrieval hypotheses (they were the cheap, falsifiable starting points), and they all falsified cleanly — which is what surfaced the actual cause. Worth noting in case future Director specs frame hypotheses similarly: the value isn't only in confirming the lead hypothesis, it's in cleanly excluding what's NOT the cause so the actual cause becomes visible.

**The diagnostic might have stopped at "retrieval works fine" and missed the classifier regression.** I went one step further than the spec literally asked — looked at the actual posted output_summary on today's failing runs to see which code path produced the deflection. That's what surfaced the classifier as the culprit. If a future read-only diagnostic finds "the thing you're looking for isn't broken," it's worth one more step to find what IS broken before writing up. Flagging because the spec's hard-stop wording ("read-only") could have been read as "stop the moment you've answered the literal question" — the spirit is clearly "find the cause," which sometimes requires a layer the spec didn't anticipate.

**PACE is a separate, smaller issue.** PACE isn't a "framework" doc title — it's an acronym (S = Situation, P = Probe, A = Agitate, C = Calculate, E = Establish) used in body text across several sales-process chunks. The vector search for "PACE framework" did the semantically reasonable thing — matched title-similar "X Framework" docs — but missed the body-text S(PACE) chunks. A future improvement (hybrid retrieval that adds keyword-match on acronyms, or query expansion that turns "PACE framework" → "PACE OR SPACE sales process") would fix this class of query. Don't bundle it into the classifier fix; they're independent and the classifier fix is the higher-priority unblock.

**The `acknowledge_and_escalate` rate spiked today.** Per-hour count in 2026-05-23 16:00 UTC alone: 3 escalations (Drake's three test questions). The prior diagnostic showed 27 total `acknowledge_and_escalate` rows in 7d, but most of those landed during the post-2026-05-19 / pre-cap window. Worth a forward-watch on the rate now that the cap is raised — if it stays high, the classifier is over-escalating broadly, not just on curriculum questions.

**Judgment call — did not test the `respond_haiku` path's prompt directly.** I could have called `generate_response` with the actual chunks for "what's covered in the sales module" to verify whether Haiku WOULD have answered correctly given those 8 sales course_lesson chunks. Skipped because (a) it's an additional Anthropic API call this read-only diagnostic doesn't strictly need, and (b) the primary regression is upstream of the response model anyway — the classifier never let it run for "module 3" / "sales module". Flagging in case Director wants that test data before scoping the classifier fix.

**Judgment call — did not investigate other classifier escalation triggers.** The same classifier prompt enumerates several escalation triggers (emotional content, money/commitments, complaints, judgment-call questions). I only verified the navigation-escalate trigger is over-firing on curriculum-content questions. The other triggers may have similar over-fire patterns visible in `acknowledge_and_escalate` rows from the post-2026-05-19 window — out of scope here but worth a follow-up audit.

## Out of scope / deferred

**Director-spec-worthy follow-ups (NOT done in this pass):**

- **PRIMARY FIX: soften the classifier's `acknowledge_and_escalate` navigation rule (`agents/ella/mention_classifier.py:81-82`).** Either narrow the rule to actual "where do I find X" / "how do I get to Y" patterns (excluding "what's covered in X" / "what does X cover" patterns which are content questions), OR add a counter-rule that prioritises `respond_haiku` when retrieved KB chunks have a similarity score above some threshold. The current prompt's "what module is Y in" example is too close to "what's covered in module Y" — the model can't reliably distinguish navigation from content when the word "module" appears. Director scopes; the structural-fix-vs-prompt-iteration discipline in CLAUDE.md (the 2026-05-19 "structural fixes beat prompt iteration when an LLM keeps rationalizing through an enumerated decision" entry) is the relevant guidance — if prompt-softening doesn't land cleanly on the first try, consider routing curriculum-content questions through a separate classifier whose enum doesn't include `acknowledge_and_escalate`.
- **SECONDARY FIX (lower priority): improve retrieval for acronym/short-name queries like "PACE framework".** Options: hybrid retrieval (vector + keyword), query expansion in `build_kb_query_from_conversation`, or a stop-list of generic words like "framework" that drag rankings toward title-matching titles. Not blocking — even if Ella misses PACE, she shouldn't be escalating "what's in module 3" as a navigation question. Director can defer until after the classifier fix lands.
- **AUDIT: post-classifier-fix, re-audit the `acknowledge_and_escalate` rate.** Today's spike (3 in one hour) is Drake's test questions; the natural rate from real client traffic needs a few days of clean data to assess. If `acknowledge_and_escalate` is firing on >10% of mention-path runs, the classifier's escalation rules are too aggressive across categories, not just navigation — that's a broader prompt-rebalance not just a single-rule edit.
- **`docs/known-issues.md` entry: "classifier-vs-decision-Haiku divergence on @-mention behaviour."** The 2026-05-19 structural override moved @-mention handling from the decision Haiku to the new mention classifier; behavioral divergence between these two prompts (especially around what gets escalated) is now a permanent risk. A known-issues note flagging the shape of "@-mention behaviour stopped matching passive behaviour" would shorten next-time diagnosis. Director to spec.
- **Forward consideration:** the prior `/ella/runs` dashboard-blind report already flagged the filter misses `acknowledge_and_escalate` rows. Today's incident is a working example of why that matters — Drake couldn't have seen these three escalations on `/ella/runs` either (they're `passive_monitor` with `haiku_decision IS NULL`, hidden by the current filter). The two pending fixes (classifier softening + dashboard-filter expansion) compound — fix the dashboard first if you want operational visibility into the classifier fix's effect.

**Not chased in this pass (out of spec scope):**

- The `channel_client=None` pass at `agents/ella/passive_dispatch.py:360` (mention-path `respond_haiku` branch) means the response Haiku gets "the client" instead of the actual client name when generating responses. That's a separate, smaller bug visible in today's "I don't have details on a PACE framework... Let me get Scott on this one" response — note Drake's name isn't used because `channel_client_name` defaulted to "the client". Out of scope, but worth a separate spec if Director wants name-addressing consistency on the mention path. Cheap fix.
- I didn't audit whether other agents (Gregory, call_reviewer) use the same retrieval path and would be affected by any shared changes. Gregory uses different retrieval (its own brain layer); call_reviewer doesn't retrieve. So this regression is Ella-scoped — no cross-agent implications.

## Side effects

- **Six OpenAI embedding API calls** via `shared.kb_query._embed_cached` for the six reproduction queries. Each is a `text-embedding-3-small` request; total cost negligible (~$0.0001).
- **Read-only DB queries** against cloud Supabase via psycopg2 pooler URL — `documents`, `document_chunks`, `agent_runs`. No writes.
- **Zero Anthropic API calls.** The reproduction used `shared.kb_query.search_for_client` which only embeds and retrieves; the response Haiku / classifier Haiku paths were not exercised.
- **No Slack posts**, no DM fires, no migration, no flag flips. The 21 inactive `course_lesson` docs and 122 inactive `call_review` docs were left exactly as I found them per the spec's "do NOT mass-flip" hard stop.
- Throwaway script at `/tmp/repro_search.py` left in `/tmp` for natural cleanup; not committed.
