# Report (PARTIAL): Ella Decision Haiku Prompt Sharpening
**Slug:** ella-decision-haiku-prompt-sharpening
**Spec:** docs/specs/ella-decision-haiku-prompt-sharpening.md
**Status:** halted — code shipped + pushed + deploy auto-triggered; awaiting Drake's gate (c) 5-case smoke in `#ella-test-drakeonly`. Spec stays `in-flight` until smoke passes (no gate (a)/(d) this spec).

> Read order: **§ What's needed to unblock** (the 5-case smoke) → **§ Verification** → **§ Surprises**.

## Acclimatization (3-4 bullets, per spec)

- `CLAUDE.md` working norms / critical rules + `docs/state.md` 2026-05-18 PM entry confirm the unified-path baseline this corrects: one decision Haiku, `respond`/`acknowledge_and_escalate`/`skip`, `is_ella_mentioned` already plumbed through `PassiveTriggerPayload`.
- `agents/ella/passive_monitor.py` housed `_HAIKU_SYSTEM_PROMPT` exactly in the pre-sharpening shape the spec describes (@-mention rule mid-prompt, "Strongly lean toward respond", no time-decay bands). Confirmed before rewriting.
- `agents/ella/retrieval.py:fetch_recent_channel_context` rendered `[YYYY-MM-DD HH:MM ET] <role> (<name>): <text>` with no delta; `fetch_recent_channel_messages` is the row primitive. Confirmed.
- **Reality-check vs spec:** the spec says `_evaluate` passes the triggering message's `sent_at` "already available via the slack_messages row lookup that backs the trigger." `passive_monitor._evaluate` does **not** do a slack_messages lookup — but the Slack `ts` on the payload **is** the message's unix timestamp, so I derive `relative_to` from it directly (accurate, always available, no DB call). Judgment call, flagged in § Surprises.

## 1. Files touched

**Modified — source (2):**
- `agents/ella/passive_monitor.py` — `_HAIKU_SYSTEM_PROMPT` replaced **verbatim** with the spec's full prompt (byte-equality asserted, see § Verification). Added `_trigger_ts_to_dt` helper + `from datetime import datetime, timezone`; `_evaluate` now passes `relative_to=_trigger_ts_to_dt(payload.triggering_message_ts)` to `fetch_recent_channel_context`.
- `agents/ella/retrieval.py` — new `_parse_utc` + `_format_time_ago(seconds)` helpers; `_et_stamp` refactored onto `_parse_utc`; `fetch_recent_channel_context` gains `relative_to: datetime | None = None` (default `now(UTC)`) and renders `[… ET — <delta>]`. `fetch_recent_channel_messages` unchanged.

**Modified — tests (2):**
- `tests/agents/ella/test_retrieval_recent_context.py` — two exact-format assertions updated to pass a fixed `relative_to` + expect the delta; new tests: `_format_time_ago` all bands, delta-relative-to-param-not-wall-clock, default-fallback-to-now.
- `tests/agents/ella/test_passive_monitor.py` — `_HAIKU_SYSTEM_PROMPT` imported; new tests: override-section-precedes-THREE-DECISIONS, override-is-absolute, time-decay-bands-present, bare-mention-threading, skip-gated-on-not-mentioned, plus a behavioral plumbing test (mention=true + mocked Haiku `respond` → surfaces respond).

**Modified — docs (2):** `docs/agents/ella/ella.md` (System Prompt Direction point 12 + new "Recent Context Format" subsection + changelog), `docs/state.md` (2026-05-19 entry).

**Deleted:** none. No migrations, no crons, no env vars (per spec).

## 2. What I did, in plain English

Replaced the decision Haiku system prompt verbatim with the spec's sharpened version — the @-mention rule is now an absolute structural override at the top of the prompt (skip forbidden when mentioned unless referential; advisor speakers don't bypass), bare-mention threading is non-negotiable, and a new time-decay-bands section tells Haiku to treat 24h+ context as stale (the direct fix for the "skipped a fresh @-mention because yesterday's escalation was still in context" production miss). To support the time-decay reasoning, `fetch_recent_channel_context` now pre-computes a human "time ago" delta per context line, measured against the triggering message's send time (derived from the Slack trigger ts) so the deltas are stable regardless of when the cron-drain path runs. Updated the tests around both surfaces (including the spec's required prompt-structure and band assertions) and the two docs.

## 3. Verification

- **Prompt verbatim:** asserted byte-equal against the spec's fenced block — `VERBATIM MATCH` (hard stop #4 satisfied).
- **`pytest tests/`:** **635 passed**, 0 failed (baseline 626; +9). Re-run after `ruff format` — still 635.
- **`ruff check`** on the 4 touched files: **All checks passed!** (clean before and after `ruff format`; `ruff format` reformatted the 2 test files only — line-wrapping long assertions).
- **`tsc --noEmit`** exit 0; **`next lint`** "No ESLint warnings or errors" (hard stop #3 — no TS touched, verified clean).
- **`_format_time_ago` bands** spot-checked: 30s→`<1 minute ago`, 120s→`2 minutes ago`, 8100s→`2h 15m ago`, 7200s→`2h ago`, 79200s→`22h ago`, 172800s→`2d ago` — all match the spec bands.
- **Smoke (gate c):** NOT performed — needs the live deploy + Slack. The unblock set below.

## 4. Surprises and judgment calls

1. **`relative_to` derived from the Slack `ts`, not a `slack_messages` lookup.** The spec assumed `_evaluate` has the triggering `sent_at` via a row lookup; it doesn't do that lookup. The Slack `ts` *is* the message's unix timestamp, so `_trigger_ts_to_dt(float(ts))` is exact and avoids an extra DB round-trip. Falls back to `None` → `fetch_recent_channel_context` defaults to `now(UTC)` (graceful, per spec). Behavior-equivalent to the spec's intent; flagging because the mechanism differs from the spec's stated one.
2. **Pre-existing out-of-scope `ruff` error left as-is.** `ruff check` over the whole `agents/ella/ tests/agents/ella/` tree reports one `unused import pytest` in `tests/agents/ella/test_agent.py` — a file this spec does not touch (unmodified in my tree). It's pre-existing on the branch, matching the prior `ella-unanswered-message-flagger` report's documented "~30 pre-existing ruff items in tests/ on HEAD." I scoped hard-stop #2 to the files I changed (clean) and left the unrelated file alone rather than churn an out-of-scope diff — same precedent the prior Builder set. Trivial autofix if you want it swept in a hygiene pass.
3. **Two existing retrieval-format tests updated, not just added-to.** Adding the delta changed `fetch_recent_channel_context`'s exact output, so the two byte-equality assertions had to change. I made them deterministic by passing a fixed `relative_to` (rather than asserting on a wall-clock-dependent delta). Necessary, not optional.
4. **Spec's "Recent Context Format section" in ella.md didn't exist as a named section.** I added one (under System Prompt Direction) rather than inventing a top-level section, and updated point 10's sibling as point 12. The spec's doc-update intent is met; the exact section name is my call.

## 5. Out of scope / deferred

- Gate (c) smoke (the 5 cases) — § What's needed to unblock.
- `docs/specs/ella-passive-monitoring-default-on.md` — **acknowledged, untouched.** Per Drake's explicit instruction it's queued for after this spec's smoke clears (Spec 1 fixes over-skip before Spec 2 raises channel volume 7→~130). Not executed this session.
- The pre-existing `test_agent.py` ruff item (Surprise 2) — pre-dates this spec; left for a hygiene pass.
- `ella-unanswered-message-flagger` is still mid-resume on its own slug (its state.md "shipped" entry deferred per its report); not touched here.

## 6. Side effects

- **No** Slack posts, DB writes, migrations, deploys-from-code-execution, external API calls. Tests fully mock DB/Slack/Anthropic.
- Git: 3 commits **pushed to `origin/main`** (`b79b28b` code+tests, `767d44b` docs, + this report) — Vercel auto-deploy triggered (no gate (a)/(d) this spec, so the push is unblocked; prompt-only change, no schema/env dependency).

## What's needed to unblock — gate (c), Drake

Once the Vercel build is green, the 5-case smoke in `#ella-test-drakeonly` (verify each in `/ella/runs` — `haiku_decision` + reasoning should cite the new sections):

1. **Bare `@Ella`, quiet channel** → short warm opener, `respond`/`haiku`.
2. **"where do I find the sales lessons?" → wait → `@Ella`** → threads to the prior question; KB-navigation ⇒ `acknowledge_and_escalate`, single warm ack.
3. **`@Ella what does the discovery section cover?` posted as team_member** → `respond`, no default-skip-advisor override (advisor @-mention responds).
4. **`@Ella` today with a stale (~22h-old) escalation in channel history** → treated as a NEW conversation, responds — **this is the regression case**; reasoning should reference "stale / 24h+" not "continuation."
5. **Non-@-mention client follow-up during simulated active advisor-client back-and-forth** → `skip` (default-skip-advisor-active still holds when `is_ella_mentioned: false`).

If any case still over-skips or mis-decides, STOP and hand back — the prompt is iterative. On a clean pass, Builder rewrites this report dropping `(PARTIAL)` and flips the spec `Status:` to `shipped` (same commit-sequence), and `ella-passive-monitoring-default-on` becomes eligible to run.
