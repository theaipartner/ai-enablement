# FAQ digest CC + questions_asked surface verification
**Slug:** faq-digest-cc-and-questions-surface-check
**Status:** in-flight

Two small follow-ups to `ella-threshold-trustpilot-first-month-faq-harvest`:

1. Add an optional CC recipient to the FAQ digest cron so Drake can see the same DM Scott sees during the validation period.
2. **Verification only — DO NOT modify code.** Confirm where `questions_asked` data lives in the rendering path, specifically whether it surfaces anywhere in the Gregory dashboard. Drake observed that it does NOT render on the call detail page, and prefers it stays that way. The task is to verify this is intended behavior, not accidental, so we know the data is cleanly isolated to the FAQ digest cron.

## Context Builder needs

Read these first, confirm understanding in 3-4 bullets:

- `api/faq_digest_cron.py` — the file Task 1 modifies. The Scott-recipient resolution lives in a helper near the top; Builder adds a CC alongside it.
- `docs/runbooks/faq_digest.md` — runbook to extend with the CC env var.
- `agents/call_reviewer/persistence.py` — how the review JSON lands in `documents.content`.
- For Task 2: search the dashboard surfaces for any reference to `questions_asked` or downstream consumers. Builder grep + verify; do not edit anything.

## Task 1: Add optional CC recipient to FAQ digest

**What changes.** New optional env var `FAQ_DIGEST_CC_SLACK_USER_ID`. When set, the cron DMs both Scott (primary, resolved dynamically by name) and the CC recipient. When unset, Scott only — current behavior preserved.

Implementation shape (Builder's call on exact factoring):

- New module-level constant or helper that reads `FAQ_DIGEST_CC_SLACK_USER_ID` from env.
- Recipient resolution path: resolve Scott as today, then append the CC UID if the env var is set and is a syntactically valid Slack user ID (starts with `U`, all uppercase alphanumeric — same loose validation as `ESCALATION_RECIPIENT_SLACK_USER_ID` precedent).
- Slack post fans out to all recipients in the list — one `post_message` call per recipient with one `webhook_deliveries` audit row per recipient. Mirrors the `ella_escalation_dm` fan-out pattern.
- If the CC env var is set but malformed (doesn't match the `U`-prefix pattern), log a warning and proceed with Scott-only. Don't crash the cron.
- If the CC Slack post fails (rate limit, channel not found, etc.), audit-row-with-error for that recipient but continue — same fail-soft pattern the rest of the cron uses.

**Env var.** Add `FAQ_DIGEST_CC_SLACK_USER_ID` to `.env.example` with a one-line comment explaining the optional CC behavior. Drake sets the actual value in Vercel Production as gate (d) after this lands — value is `U0AMC23G1SM` (Drake's slack_user_id). No code path hardcodes this UID.

**Tests.** Extend `tests/api/test_faq_digest_cron.py` with 4 cases:
1. CC env var unset → Scott-only DM (existing behavior, regression check).
2. CC env var set to a valid UID → both Scott and the CC get the DM; both audit rows present.
3. CC env var set to a malformed value → Scott-only, warning logged.
4. CC env var set and CC's Slack send fails → Scott still receives, CC's audit row carries the error, cron returns 200.

Use the existing test fixtures and `monkeypatch` for env var control. Mock the Slack post call to assert recipient list per existing patterns.

**Doc update.** Extend `docs/runbooks/faq_digest.md` with:
- One paragraph in the recipients section noting the optional CC env var, what value to set, and the gate (d) note for Drake adding it to Vercel.
- Note in the "How to disable temporarily" section that the CC can be removed alone (unset the env var) without affecting Scott's delivery.

## Task 2: Verify `questions_asked` rendering — INVESTIGATION ONLY

**What Drake asked.** Drake has confirmed via dashboard inspection that `questions_asked` does NOT render on Gregory's call detail page. He prefers it stays that way — the data should be cleanly isolated to feeder-data-for-the-FAQ-cron. This task confirms that's the intended state, not an accident the next session might "fix."

**What Builder does.** Investigation only. Builder reads files, greps the codebase, and reports findings in the report. **Builder makes NO code changes for Task 2** — even if Builder finds a bug or a half-wired surface, do not fix it. Surface in the report.

Specifically verify:

1. **Where does `questions_asked` get rendered?** Search the dashboard code (`app/`, `components/`, `lib/`) for references to `questions_asked`. Confirm zero rendering paths exist OR identify any paths that exist.

2. **Where in the call review path does the field get dropped?** Trace from `documents.content` (JSON blob) to whatever component renders the call review on `/calls/[id]`. The other four fields (`pain_points`, `wins`, `dodged_questions`, `sentiment_arc`) DO render — locate the render code, confirm whether it explicitly destructures only those four (which would be intentional) or destructures dynamically (which would be accidental and `questions_asked` would surface as a future-bug surprise).

3. **Is the absence intentional or accidental?** Builder makes the call based on code reading. Three possible reads:
   - **Intentional.** The render code explicitly picks the four old fields by name; new fields in the JSON blob are silently ignored. Good state.
   - **Accidental.** The render code dynamically iterates over the JSON keys and only happens to not render `questions_asked` because of some incidental reason (CSS hides it, the key name doesn't match a styling rule, etc.). Future-bug.
   - **Half-wired.** The render code tries to render `questions_asked` but fails silently (e.g., null check that always returns null, conditional that's always false). Worth knowing.

4. **Downstream consumers.** Confirm `questions_asked` is consumed by `api/faq_digest_cron.py` only. No other code path should be reading the field.

**Output.** Builder reports findings in the standard six-section report, with Task 2's findings under "What I did, in plain English" and any unusual observations under "Surprises and judgment calls." The investigation result should clearly answer: "Is questions_asked cleanly isolated to the FAQ cron, or is there a future-bug surface that needs awareness?"

## Hard stops

None. Both tasks are non-irreversible:

- Task 1 deploys via git-push; if the CC fan-out has a bug, audit ledger captures it and recovery is a follow-up commit. Drake's gate (d) is setting the env var value — Builder doesn't touch it.
- Task 2 is read-only — Builder explicitly doesn't change code, so there's nothing to roll back.

## Hard-numerical thresholds

- Task 2: if Builder finds `questions_asked` references in the dashboard code, count them. >0 references that surface the data anywhere = surface in the report, do not modify.

## What could go wrong

- **Task 1:** if the CC fan-out shares any state with Scott's send path (e.g., reuses the same `webhook_deliveries` row), the audit ledger gets confused. Verify each recipient gets its own audit row.
- **Task 1 malformed env var:** if Drake fat-fingers the env var (e.g., adds a space, uses display name instead of UID), the cron should degrade gracefully to Scott-only, not crash.
- **Task 2:** Builder might find a half-rendered surface and feel compelled to "fix" it. Don't. Report it.

## Mandatory doc-update list

- `docs/runbooks/faq_digest.md` — CC env var documented in recipients section + disable section.
- `.env.example` — `FAQ_DIGEST_CC_SLACK_USER_ID` entry with one-line comment.
- `docs/state.md` — single line entry under the 2026-05-15 bundle noting the CC follow-up.
- No CLAUDE.md update — § Next Session Priorities is already at the right shape.

## Acceptance criteria

- Task 1: code + tests committed and pushed. `pytest tests/api/test_faq_digest_cron.py` green (18 tests total: 14 existing + 4 new). `.env.example` updated. Runbook updated. Drake handles gate (d) Vercel env var set + manual curl fire after deploy.
- Task 2: Builder report carries a clear answer to "is the absence of questions_asked rendering intentional or accidental, and is the field cleanly isolated to the FAQ cron." No code changes for Task 2.

## Sequence

1. Task 2 investigation first (read-only, fast). Builder reports findings as it goes; doesn't need to wait for commit.
2. Task 1 code + tests.
3. Task 1 doc updates + .env.example.
4. Single report covering both tasks.

If Task 2 surfaces a real problem, Builder mentions it in the report but does not fix it — Drake decides whether to spec a follow-up.
