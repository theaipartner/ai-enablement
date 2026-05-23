# Report: Ella Haiku BadRequestError — root cause from Vercel logs (read-only)
**Slug:** ella-haiku-badrequest-log-investigation
**Spec:** docs/specs/ella-haiku-badrequest-log-investigation.md

## Files touched

Created:
- `docs/reports/ella-haiku-badrequest-log-investigation.md` — this report.

Modified:
- `docs/specs/ella-haiku-badrequest-log-investigation.md` — `Status:` flipped from `in-flight` to `shipped`.

No code, schema, or runtime change. Vercel CLI used in read-only mode (`vercel logs --no-follow`, `vercel ls`). One throwaway psycopg2 read against cloud Supabase to pin the failure-start timestamp; not committed.

## What I did, in plain English

The prior diagnostic established Ella's Haiku calls are erroring fleet-wide with `anthropic.BadRequestError` but couldn't name the cause because the Anthropic 400 body isn't persisted to `agent_runs` (the call-site code only `logger.warning`s the exception). This spec gets that error body from Vercel function logs.

**Found it on the very first matching log line.** The verbatim Anthropic error message is:

> **`You have reached your specified API usage limits. You will regain access on 2026-06-01 at 00:00 UTC.`**

This is an **account-level usage cap hit on the Anthropic Console** — not a token-ceiling error, not malformed content, not a model-id problem, not a code or prompt regression. The Anthropic API itself is healthy; it's rejecting Ella's calls because the account/org has crossed a spending or call-volume limit that was configured in the Console.

That explains every part of the diagnostic's surface:
- **Fleet-wide affecting all channels** — the cap is per-API-key, not per-request, so every call from Ella's deployment hits it equally.
- **Both mention-classifier and decision Haiku failing identically** — same API key, same response.
- **Identical `type(exc).__name__ = BadRequestError`** on both call sites — `anthropic.BadRequestError` is what the SDK raises for any 400 reason, including usage-cap exhaustion.
- **Sharp start (not a gradual ramp)** — first failure landed 2026-05-21 20:55:36 UTC; the very first hour had 13 failures, the second hour 19. That's the signature of "limit was crossed at a point in time," not "request grew over days until it exceeded a ceiling." 181 failed rows total since first occurrence; the most recent at 2026-05-23 14:03:24 UTC.
- **Mention path posts the canned warm-opener loudly; decision path silently skips** — both paths' fallback handling kicks in correctly; the rejection is upstream of any code Ella controls.

**The fix is in the Anthropic Console, not the code.** Either raise the org's spending/usage cap, remove it, or add billing capacity. Code changes — context truncation, KB-block resizing, model swaps, request reshape — won't help and shouldn't be attempted; the API is rejecting *any* call from this key, not a specific request shape. Until either the cap is lifted or 2026-06-01 00:00 UTC rolls around (~8 days), Ella's Haiku decision path will continue to skip every passive message silently, and the mention path will continue to post the canned warm-opener fallback.

This is gate (d) territory — credentials / Anthropic Console billing — so the fix sits with Drake.

## Verification

Vercel CLI authenticated as `drakeynes`, linked to `prj_EeWPd4k8agIsq90BILpxnTX24JB8` (`drakeynes-projects/ai-enablement`). Logs pulled with `--no-follow --no-branch --environment production` against recent ready deployments.

**Step 1+2 — verbatim error body from a real production log line** (production deployment, 2026-05-23 14:03:24 UTC, request id `2327ad89-986b-455a-9964-58aeac6ced9d`, Anthropic request id `req_011CbKdEQPHcRwpxMx1ZtQyP`):

```
[INFO]  HTTP Request: POST https://api.anthropic.com/v1/messages "HTTP/1.1 400 Bad Request"
[WARNING] passive_monitor: decision Haiku call failed (Error code: 400 - {'type': 'error',
  'error': {'type': 'invalid_request_error', 'message': 'You have reached your specified
  API usage limits. You will regain access on 2026-06-01 at 00:00 UTC.'},
  'request_id': 'req_011CbKdEQPHcRwpxMx1ZtQyP'}); skip
```

The `passive_monitor: decision Haiku call failed (...)` warning string matches `agents/ella/passive_monitor.py:571` exactly. The `mention_classifier: classifier Haiku call failed` warning at `agents/ella/mention_classifier.py:204-208` would emit the same body for the mention path; no mention-path warnings appeared in the 6h log window because mention-path runs themselves are rare (the prior diagnostic showed only 7 mention rows in 7 days).

**Distinct-error-pattern sweep over 12h of production logs** (`-q "400" -n 500 --json`, parsed for unique `'message': '...'` bodies):

```
Distinct 400 reasons: 1
  All 8 occurrences:  You have reached your specified API usage limits.
                      You will regain access on 2026-06-01 at 00:00 UTC.
```

Only one failure mode under the `BadRequestError` umbrella. No token-ceiling errors, no malformed-content errors, no `max_tokens`-config errors hiding under the same class name. Single root cause.

**Step 5 — failure-start timing** (cloud query against `agent_runs`):

```
First seen:  2026-05-21 20:55:36 UTC
Last seen:   2026-05-23 14:03:24 UTC
Total:       181 rows

Hourly:
  2026-05-21 20:00 — 13   ← starts sharp here
  2026-05-21 21:00 — 19
  2026-05-21 22:00 — 8
  2026-05-21 23:00 — 3
  ...
  2026-05-22 15:00 — 28   ← peak
  2026-05-22 20:00 — 24
  2026-05-23 14:00 — 1    ← most recent
```

Sharp start (13 failures in the first hour vs 0 before), confirming the failure is not a gradual context-bloat ramp. Consistent with an account-cap that was crossed at 20:55 UTC on 2026-05-21. The hour-to-hour variance after that just tracks Slack message volume into Ella's monitored channels — every Haiku call has been failing identically since the cap hit; you just see more failures during high-volume hours.

**Sonnet sanity check** — `SELECT llm_model, count(*) FROM agent_runs WHERE agent_name='ella' AND status='success' AND llm_cost_usd IS NOT NULL AND started_at >= now() - interval '24 hours' GROUP BY llm_model` returned **zero rows**. No Ella Sonnet (or Haiku-with-cost) call succeeded in the last 24h. The prior diagnostic also showed zero `passive_substantive` / `passive_general_inquiry` rows in 7d, so the Sonnet response drain hasn't been firing — meaning I can't independently confirm from production traffic whether Sonnet would also be rejected by the same cap. The API-side error message says "your specified API usage limits" (plural / generic), which in Console terms usually means an org-wide spending cap that applies to all models — but I can't rule out that it's a Haiku-model-specific cap. **For step 3's controlled-reproduction option: not needed.** The error body and request_id are both in production logs; no live API call was made.

## Surprises and judgment calls

**The fix is purely in the Anthropic Console — not a single line of code change is warranted from this finding.** Worth saying loudly because the natural Builder-instinct reading "Haiku calls returning 400" would reach for context-truncation, KB-block resizing, or model swaps. None of those would do anything. Until the cap is lifted, every call fails. After the cap is lifted, every call succeeds again with no code change.

**The 5-day window to 2026-06-01 is the deadline that matters.** If the cap is a deliberate monthly budget guardrail (e.g. Anthropic Console "monthly spend limit"), it'll auto-reset at month boundary on 2026-06-01 00:00 UTC. That means doing nothing is technically a valid plan — Ella's Haiku path resumes automatically on June 1. Whether to wait or raise the cap is a Drake call dependent on (i) how much Ella functionality should be live in the interim, (ii) whether the budget was deliberately tight, (iii) what's expected to happen between now and the next billing cycle. Flagging in case the implication isn't immediate.

**Mention-path runs didn't show in the 6h log window because they're rare, not because they're working.** The 7d diagnostic showed 7 mention rows total; 2 were `classifier_call_failed` (the two Ruphael misfires). At ~1 mention row/day fleet-wide, no mentions happened to fire during the 6h Vercel log window. The mention-path failure is identical to the decision-path failure structurally — same API key, same error response — so no separate investigation needed; when a mention does fire, it'll error the same way.

**Did not perform step 3's controlled reproduction.** Spec allowed one live reproduction if logs weren't available; logs were available. Skipped to avoid burning a call that'd hit the same 400 anyway.

**Did not deep-dive Vercel deploy history for correlation.** Step 5 said "if quick." The cloud-side hourly bucketing answered the question definitively (sharp start, not gradual ramp, no deploy correlation needed) without needing `vercel ls --since 2026-05-21` to enumerate deploys. The 20:55 UTC timestamp is too specific for any deploy-based explanation — that's the moment a billing meter crossed a threshold, not the moment a deploy went live.

**One small surprise — `dev.log` / `vercel logs --json` line shape.** The Vercel CLI returns one JSON record per *request*, with every stdout/stderr line in that request concatenated into a single `message` string. So `-n 100` doesn't mean "100 error lines" — it means "up to 100 requests' worth of logs." Mention this so future Builders pulling Vercel logs don't undersize the `-n` parameter and miss errors.

## Out of scope / deferred

**Director-spec-worthy follow-ups (NOT done in this pass):**

- **Drake gate (d) action: raise / remove the Anthropic Console usage cap, OR confirm the deliberate wait-to-2026-06-01 plan.** This is the actual unblocker. Until this happens, every cron / event firing through Ella's Haiku path will continue to silently no-op (decision path) or post the canned warm-opener (mention path).
- **`docs/known-issues.md` entry: "Ella Haiku decision path silent on Anthropic 4xx."** Worth a permanent note because the failure mode is invisible — `status='success'`, no error column, just a `haiku_reasoning='haiku_call_failed: ...'` buried in trigger_metadata. Without the prior `/ella/runs` dashboard fix (also pending), this would be hard to spot operationally for any future similar issue. Director to spec the known-issues entry.
- **`docs/known-issues.md` entry (or runbook entry): how to recognize Anthropic Console cap hit.** The error body + request_id pattern is distinctive (`'message': 'You have reached your specified API usage limits...'`). A runbook stub mapping "Ella stopped responding fleet-wide" → "check Anthropic Console usage caps" would shorten next-time diagnosis to seconds. Director to spec.
- **Optional but high-value: persist the Anthropic API error body to `agent_runs.error_message` on the failing rows** so future diagnostics don't need to drop into Vercel logs to find the cause. Today, `agent_runs.metadata` is `{}` and `error_message` is null on these rows; the warning-log-only pattern means the database has the symptom but not the cause. A one-line capture in the `except` branches at `agents/ella/passive_monitor.py:570` and `agents/ella/mention_classifier.py:204` would close that gap permanently. Director to scope if desired; the diagnostic friction this would have saved on this exact issue is several hours.
- **Forward consideration:** the prior `/ella/runs` dashboard-blind report flagged that `acknowledge_and_escalate` (27 rows in 7d) and mention-path rows are hidden. If/when that filter is fixed, today's 181 silent-skip rows will retroactively become visible, which is exactly the audit recovery the spec implied. No additional work needed here; flagging the synergy.

**Not chased in this pass (out of spec scope):**

- I did not pull / interpret Anthropic Console state directly (would require Anthropic Console access; not a Vercel CLI concern).
- I did not investigate whether other consumers of the same API key (Gregory, call_reviewer, ai_call_signal, FAQ digest cron) are also failing — the diagnostic mentioned Gregory has 196 runs in 24h. If Gregory is silently failing too, that's a separate audit; flagging as worth checking in a follow-up rather than rolling into this read-only investigation.

## Side effects

None. Read-only diagnostic. All Vercel CLI invocations used `--no-follow` (one initial streaming attempt was killed before producing output). One cloud psycopg2 read for the failure-start timestamp; no writes. **No live Anthropic API call made** — step 3's controlled-reproduction allowance was not exercised because the Vercel logs already contained the verbatim error body and request id. Throwaway diagnostic script was inline in the Bash heredoc; nothing committed. No secrets emitted to any committed file (Anthropic + Slack tokens never appeared in the Vercel log output read).
