# Report (PARTIAL): Ella Decision-Haiku Prompt Sharpening — v2 (loophole closure)
**Slug:** ella-decision-haiku-prompt-sharpening (v2 pass)
**Pairs with:** docs/reports/ella-decision-haiku-prompt-sharpening.md (v1 PARTIAL — left intact) + docs/reports/ella-decision-haiku-prompt-sharpening-smoke-diagnostic.md (the failure this closes)
**Status:** halted — code shipped + pushed + deploy auto-triggered; awaiting Drake's gate (c) re-smoke in `#ella-test-drakeonly`, specifically the bare-mention regression case. No gate (a)/(d).

> Read order: **§ What's needed to unblock** → **§ Verification** → **§ Surprises**.

## 1. Files touched

**Modified — source (1):** `agents/ella/passive_monitor.py` — `_HAIKU_SYSTEM_PROMPT` only. Verified the sole diff in this file is inside the prompt string (23 ins / 2 del, zero `def`/`class`/`import`/constant/control lines changed — hard stop #4 satisfied).
**Modified — tests (1):** `tests/agents/ella/test_passive_monitor.py` — 3 v2 tests added (new-copy presence, worked-example presence + ordering + carve-out preserved, behavioral plumbing); 1 stale v1 wording-assertion test updated to the v2 sub-case (a) string (see Surprise 1).
**Modified — docs (2):** `docs/agents/ella/ella.md` (System Prompt Direction point 13 + changelog), `docs/state.md` (2026-05-19 PM evening entry).
**Deleted / migrations / crons / env:** none.

## 2. What I did, in plain English

Applied the two prompt-only changes from the instruction **verbatim**. CHANGE 1: rewrote the bare-@-mention bullet in `# THE @-MENTION OVERRIDE` so a bare @-mention with `is_ella_mentioned=true` is NEVER skip — three sub-cases: (a) unanswered prior question → thread + answer; (b) resolved / answered / >24h-stale prior thread → fresh warm opener via `respond`/`haiku`; (c) no prior context → same opener — plus the explicit "if you're reasoning 'no open question so I'll skip' — STOP, that's the loophole; the @-mention itself IS the signal" instruction. CHANGE 2: added a `# WORKED EXAMPLE — RESOLVED-THREAD BARE MENTION` section inside the override (before THE THREE DECISIONS) anchoring exactly the 22h-old-resolved-escalation failing case with WRONG vs CORRECT reasoning. Everything else in the prompt is byte-identical; the referential carve-out ("Hey Scott, ask @Ella…" → skip allowed) is preserved unchanged. Updated tests + the two docs.

## 3. Verification

- **Prompt-only diff** in `passive_monitor.py` — confirmed via `git diff` (no structural lines).
- **`pytest tests/`:** **638 passed**, 0 failed (baseline 635; +3 v2 tests, 1 v1 test updated). Re-run after `ruff format` — still 638.
- **`ruff check`** on the 2 touched files: **All checks passed!** (`ruff format` applied — reformatted the test file only).
- **`tsc --noEmit`** exit 0; **`next lint`** clean (hard stop #3 — no TS touched).
- Prompt assertions spot-checked: new copy present, worked example present + ordered before THE THREE DECISIONS, referential carve-out string still present.
- **Smoke (gate c):** NOT performed — needs the live deploy + Slack. Unblock set below.

## 4. Surprises and judgment calls

1. **One stale v1 test updated, not just additive.** `test_prompt_bare_mention_threading_non_negotiable` asserted v1's exact wording ("not chitchat when prior context contains a question" / "answer THAT question") — strings v2 deliberately removed (my v2 test even asserts the old phrasing is gone). I updated that test to assert the v2 sub-case (a) wording ("…NEVER skip when is_ella_mentioned=true" + "UNANSWERED question → thread to that question and answer it"), which preserves its intent (threading to a prior unanswered question stays non-negotiable). Expected churn from a superseding prompt change, not a regression — flagging because it's a test edit beyond pure addition.
2. **No v2 spec file.** The instruction came inline via remote-control with the exact replacement text, not as a `docs/specs/…-v2.md`. Treated the provided text as the authoritative spec (copied verbatim, same as v1's hard-stop-#4 discipline). The report pairs with the existing `ella-decision-haiku-prompt-sharpening` slug as a v2 pass; v1's PARTIAL report + the smoke-diagnostic are left intact (audit trail: v1 → diagnostic → v2).
3. **Pre-existing out-of-scope `ruff` item untouched.** The `unused import pytest` in `tests/agents/ella/test_agent.py` (documented in the v1 state.md entry + v1 report) is still pre-existing and out of this change's scope — left as-is per the established precedent; my 2 touched files are clean.

## 5. Out of scope / deferred

- Gate (c) re-smoke — § What's needed to unblock.
- `docs/specs/ella-passive-monitoring-default-on.md` — **acknowledged, untouched.** Stays blocked until this v2 smoke passes (over-skip must be confirmed fixed before 7→~130 channel scale-up). Not executed.
- The pre-existing `test_agent.py` ruff item — pre-dates this; hygiene-pass candidate.

## 6. Side effects

- **No** Slack posts, DB writes, migrations, external API calls. Tests fully mock DB/Slack/Anthropic.
- Git: 3 commits **pushed to `origin/main`** (`71c2e39` code+tests, `a3484e9` docs, + this report) — Vercel auto-deploy triggered (no gate (a)/(d); prompt-only, no schema/env dependency).

## What's needed to unblock — gate (c), Drake

Once the Vercel build is green, re-run the smoke battery in `#ella-test-drakeonly`. The **load-bearing case** (the v1 regression v2 closes):

- **Bare `<@Ella>` (real mention, autocomplete-selected so it renders `<@U…>`), with a stale/resolved escalation in the channel's recent history (e.g. yesterday's 22h-old refund→ack thread).** Expected: `respond`, `response_model=haiku`, a warm short opener — **not** skip. In `/ella/runs` the reasoning should cite the override / "22h-old, resolved, treat as new conversation / the @-mention IS the signal" — not "no open question, nothing to do."

Also re-confirm the other v1 cases still pass (bare mention quiet channel → opener; advisor @-mention with question → respond; non-@-mention active CSM dialogue → skip). Note: plain text `Hey Ella` (no `<@U…>`) is correctly NOT a mention and will still skip — that's by design, not the regression.

If the bare-mention case still skips, capture the full `/ella/runs` reasoning and hand back — there may be a further rationalization path to close. On a clean pass, Builder rewrites this report dropping `(PARTIAL)`, flips the spec `Status:` to `shipped`, and `ella-passive-monitoring-default-on` becomes eligible to run.
