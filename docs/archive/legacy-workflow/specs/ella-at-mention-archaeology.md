# Ella @-mention path archaeology — recover the proven pre-classifier behavior (read-only)
**Slug:** ella-at-mention-archaeology
**Status:** shipped

**Target branch: ella-worktree**

> Handed to Builder directly in the worktree (paste-to-Code workflow — avoids mid-session branch-sync). Save to docs/specs/ella-at-mention-archaeology.md in the worktree. Execution stays in the ella-worktree worktree at ~/projects/ai-enablement-ella, NOT main. A Close-ingestion backfill is running on main in parallel — Ella-only work; do not touch anything Close-related.

## Why this exists

Drake's recollection — corroborated by two diagnostics this session — is that Ella's @-mention behavior used to be excellent: a client or advisor @-mentioned her with a curriculum/content question and she answered it well, escalating only when genuinely appropriate. That behavior regressed. The `ella-kb-retrieval-access-diagnostic` report pinned the cause: the @-mention classifier introduced on 2026-05-19 (`agents/ella/mention_classifier.py`, commit `1fd5994`) over-escalates content questions as "navigation" questions, bailing to `acknowledge_and_escalate` before retrieval even runs. Retrieval itself is healthy (276 active course lessons, 592 embedded chunks, five of six probe queries returned correct results). The problem is purely in the post-retrieval decision layer that the structural-override churn introduced.

We are about to do a **path-split**: separate the @-mention path from passive monitoring, give @ its own clean handler, remove passive's in-channel responses (keeping passive *observation* → internal digest/flagger surfaces). Rather than design a new @ handler from scratch, Drake wants to **recover the proven older @ behavior from git history** and rebuild around it — restoration plus separation, not redesign.

**This spec is the archaeology pass that feeds the split spec.** It is READ-ONLY: find, read, and document the pre-2026-05-19 @-mention path. Do NOT change any code, do NOT restore anything yet. The output is a written reconstruction Director uses to scope the split.

## The historical boundary (what we already know)

From `docs/state.md` + the two diagnostic reports, the @-mention path evolved through these phases. Confirm/correct each against actual git history:

- **Pre-2026-05-18 (the "good" era Drake remembers):** @-mention and passive were SEPARATE paths. @-mentions ran through a reactive handler. Relevant machinery named in state.md: `agent.respond_to_mention`, `_should_dual_trigger`, `_build_app_mention_from_message`, `_process_mention` in `api/slack_events.py`, and a reactive `_run` in `agents/ella/agent.py` with an `[ESCALATE]` token + `_detect_and_strip_escalation`. Retrieval via `agents.ella.retrieval.fetch_recent_channel_context` (last-15-turn context). **This is the era to recover** — a dedicated reactive @ path with balanced respond-vs-escalate judgment.
- **2026-05-18 AM (`ella-architecture-refactor-and-daily-digest`):** reactive @ path started routing through the same decision Haiku as passive — first step of the collapse.
- **2026-05-18 PM (`ella-unified-path-intelligence-refactor`):** reactive + passive fully COLLAPSED into one pipeline. `app_mention` became a no-op; `_should_dual_trigger` / `_build_app_mention_from_message` / `_process_mention` removed; `respond_to_mention` reduced to a thin adapter. **This is the collapse that started the regression.**
- **2026-05-19 PM (`ella-at-mention-structural-override`, commit `1fd5994`):** introduced `agents/ella/mention_classifier.py` — the over-escalating classifier that's the confirmed current culprit.

So the recovery target is the @-mention handling as it existed **before the 2026-05-18 AM refactor** — the last commit where @-mentions had their own dedicated reactive path with balanced judgment, separate from passive.

## Acclimatization checklist

Read first, confirm in 4-5 bullets:

- `docs/reports/ella-kb-retrieval-access-diagnostic.md` + `docs/reports/ella-warm-opener-and-runs-page-diagnostic.md` — the two findings establishing retrieval is fine and the classifier is the regression.
- The CURRENT `agents/ella/mention_classifier.py`, `agents/ella/passive_monitor.py`, `agents/ella/passive_dispatch.py`, `agents/ella/agent.py` — so you can describe the delta between now and the recovered version.
- `docs/agents/ella/ella.md` § Trigger + § @-Mention Handling + Changelog — the documented evolution.
- Confirm git history is reachable in the worktree (`git log --oneline` reaches commits well before 2026-05-18; the worktree branched off origin/main so full history should be present).

## What to do

All read-only: git history spelunking + code reading + writing the reconstruction report. No code changes, no restoration, no checkout-of-old-files-into-the-tree (read them via `git show`, don't materialize them).

1. **Find the boundary commits.** `git log` the relevant files (`agents/ella/agent.py`, `api/slack_events.py`, `agents/ella/passive_monitor.py`, and any `agents/ella/retrieval.py`). Identify: (a) the last commit BEFORE the 2026-05-18 AM refactor where the reactive @ path was intact and separate; (b) the commit that collapsed it; (c) commit `1fd5994` that added the classifier. Give the actual SHAs + dates + messages so the split spec can reference exact revisions.

2. **Read the "good" reactive @ path at that pre-2026-05-18 commit.** Via `git show <sha>:<path>` for each relevant file. Reconstruct in plain English HOW it worked end to end:
   - How an @-mention was detected and dispatched (the `_should_dual_trigger` / `_process_mention` / `respond_to_mention` flow).
   - How it decided to respond vs escalate — the actual prompt and/or logic. What was the escalation trigger? Was there a navigation-vs-content distinction at all, or did it just retrieve-and-answer and escalate only on the out-of-scope list (billing/emotional/etc.)? **This is the heart of what Drake wants back** — quote the actual respond-vs-escalate instruction from the old prompt (it's our own prompt text, reproduce it in full).
   - What retrieval it ran and how the retrieved chunks fed the answer.
   - How it posted (thread vs main channel) and what persona/format.

3. **Characterize WHY it worked better.** Contrast the old respond-vs-escalate logic against the current classifier's navigation-escalate rule. The diagnostic found the current classifier escalates "what's covered in module 3" as navigation. Did the old path have that failure mode? If not, what specifically did it do differently — no navigation rule at all? retrieve-first-then-decide instead of decide-first? a different escalation enum? Name the concrete behavioral difference that explains "she used to answer these."

4. **Assess recoverability — faithful vs modernized.** Drake's steer: he wants the good behavior back, restored-but-MODERNIZED (same judgment, wired into CURRENT plumbing — current `retrieval.py`, current `escalation_routing.py` / `fire_escalation_dms`, current `shared/slack_post.py` — not the old `[ESCALATE]`-token plumbing). So assess:
   - Which parts of the old path are pure behavior (the prompt, the respond-vs-escalate logic) that can be lifted forward as-is?
   - Which parts are old plumbing (`[ESCALATE]` token, `_detect_and_strip_escalation`, thread-posting, dual-trigger reshaping) that should NOT come back because current equivalents exist and are better?
   - What's the cleanest mapping of "old behavior onto current wiring"? E.g. old prompt's respond-vs-escalate judgment → a new dedicated @ handler that retrieves, then decides, using current `escalation_routing` for the escalate case.
   - Flag anything that genuinely can't be cleanly modernized (a real fork in the road for the split spec to decide).

5. **Note what the split must also handle (not in the old path).** The old path predates passive monitoring entirely. The split spec will need to separate @ from passive AND keep passive's *observation* (digest + unanswered-flagger to internal channels) while removing its in-channel voice. The old @ path won't show how passive should behave post-split — just flag that the split spec owns that half; this archaeology is only about recovering the @ half.

## What success looks like

A report at `docs/reports/ella-at-mention-archaeology.md` containing:

- **Boundary commit SHAs + dates** for the three phases (pre-refactor good state / collapse / classifier introduction).
- **Plain-English reconstruction of the old reactive @ path** — detection, respond-vs-escalate logic (with the actual old prompt text quoted), retrieval, posting.
- **The concrete behavioral difference** that made the old path answer content questions the current classifier escalates.
- **A faithful-vs-modernized recoverability map** — what behavior to lift forward, what plumbing to leave behind, the cleanest mapping onto current wiring.
- **Open forks** the split spec needs to decide.

Tight and concrete. This is a foundation document for the split spec, not a history essay — every finding should be something the split spec can build on.

## Hard stops

- **Read-only.** No code changes, no restoration, no `git checkout` of old files into the working tree (use `git show` to read them in place), no migration, no flag flips. The deliverable is the report only.
- Operate in ella-worktree, not main.
- Do not touch anything Close-related.
- If git history doesn't reach far enough (shallow clone, or the worktree's history is truncated) — STOP and report that; don't reconstruct from state.md/docs alone. The whole value is reading the ACTUAL old code, not the documentation's description of it. (Docs are the corroborating cross-check, not the source.)

## What could go wrong — think this through yourself

Seeds: the "good" era might span several commits with incremental changes — don't fixate on a single SHA; find the commit that best represents the stable good behavior and note if it drifted. The old prompt might have had its OWN problems Drake's memory has rosied over — if the old respond-vs-escalate logic had a different failure mode (e.g. under-escalating, answering things it shouldn't), say so honestly rather than presenting it as flawless; the split spec needs the real picture, not nostalgia. The shipped specs for these phases (`ella-unified-path-intelligence-refactor.md` etc.) were deleted in EOD cleanup — they live only in git history too; `git show <sha>:docs/specs/<slug>.md` can recover them if useful for understanding intent. And: distinguish the old @ path's retrieval from the current one — if retrieval improved between then and now, "modernized" should keep the current better retrieval, not regress to the old one.

## Mandatory doc updates

- Write the report to docs/reports/ella-at-mention-archaeology.md.
- Flip this spec's Status to shipped in the same commit that lands the report (read-only archaeology, no gate).
- No other doc edits. Any known-issues-worthy finding gets NAMED in the report's Out of scope / deferred for Director to spec.
