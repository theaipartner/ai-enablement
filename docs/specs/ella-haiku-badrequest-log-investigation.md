# Ella Haiku BadRequestError — root cause from Vercel logs (read-only)
**Slug:** ella-haiku-badrequest-log-investigation
**Status:** in-flight

**Target branch: ella-worktree**

> Specs live on `main` (Builder reads them from there). Execution targets the `ella-worktree` worktree at `~/projects/ai-enablement-ella`, NOT `main`. A Close-ingestion backfill is running on `main` in parallel — this work is Ella-only; do not touch anything Close-related.

## Why this exists

The `ella-warm-opener-and-runs-page-diagnostic` report (read it first — `docs/reports/ella-warm-opener-and-runs-page-diagnostic.md`) established that Ella's Haiku calls are failing fleet-wide with `BadRequestError` (HTTP 400) — both the mention-path classifier (`agents/ella/mention_classifier.py`) and the passive decision Haiku (`agents/ella/passive_monitor.py`). 130+ rows across 50+ channels in 36h. The mention path collapses to a `warm_opener` fallback (visible — posts the canned "Hey — what can I help with?" to the channel); the decision path silently skips (invisible — Ella just doesn't respond when she should).

A 400 means the API is healthy and is **rejecting the request Ella sends** as malformed/invalid — not an outage. The actual rejection reason (which field, which limit) is in the **Anthropic API error body**, which is logged to Vercel function logs but NOT persisted to the database (`agent_runs.metadata` is empty `{}` on the failing rows; the code only `logger.warning`s the exception). So the diagnostic couldn't name it without the logs.

**This spec gets the actual error body from the Vercel logs.** That single string almost certainly names the exact fix. This is a read-only investigation — find the cause, do NOT ship the fix in this pass (the fix depends on what the error says, and Director scopes it from confirmed findings).

## Acclimatization checklist

Read first, confirm in 3-4 bullets:

- `docs/reports/ella-warm-opener-and-runs-page-diagnostic.md` — the full prior finding (the two failure sites, the fleet-wide scope, the affected channel ids).
- `agents/ella/mention_classifier.py` — the classifier Haiku call + the `except Exception` branch that writes `classifier_call_failed: <ExcName>` (around lines 204-215). Note the exact `logger.warning` string it emits so you know what to grep for.
- `agents/ella/passive_monitor.py` — the decision Haiku call + its `haiku_call_failed: BadRequestError` log path.
- `shared/claude_client.py` — how Ella builds the Anthropic request (model id, max_tokens, message assembly). This is where the malformed-request would originate; useful for interpreting the error body once you have it.
- Confirm Vercel CLI is authenticated/available in the worktree (`vercel whoami` / `vercel ls`). If it is NOT, stop and say so — that's the whole method; surface it rather than improvising.

## What to do

**This is read-only: log retrieval + code-read only. No fix, no prompt edit, no code change beyond a throwaway if needed for reproduction.**

1. **Pull the Vercel function logs** for the Ella functions where the failures originate. The diagnostic named the loud channels (most failures in 36h): `C0AFEC456JG` (15), `C0AEEPVK36W` (15), `C0B1DHYL9D5` (9), `C0ALJ8UN1FH` (7), `C09UMFVQNMU` Ruphael (5). The failing call sites run inside `api/slack_events.py` (realtime ingest → passive monitor fork → mention classifier / decision Haiku) and possibly `api/passive_ella_cron.py` (the Sonnet drain — less likely, but check). Use `vercel logs` against the production deployment. Grep the log stream for the warning strings the two call sites emit — `classifier Haiku call failed` (mention path) and `haiku_call_failed` / the decision-path equivalent. The log line(s) at or near those warnings will carry the full `anthropic.BadRequestError` message.

2. **Extract the actual error body verbatim.** This is the deliverable. The Anthropic 400 comes with a message that names the problem — e.g. `prompt is too long: N tokens > 200000 maximum`, or `messages.N.content: cannot be empty`, or `max_tokens: must be ≤ M for model X`, or an invalid-role / invalid-model message. Quote it exactly in the report (it's Anthropic's error string about our own request — not copyrighted content; reproduce it in full so Director can scope the fix precisely). If multiple distinct error bodies appear, quote each distinct one — there may be more than one failure mode hiding under the same `BadRequestError` class name.

3. **If the logs have aged out / are unavailable** (Vercel log retention is short — often only the last hour or a few hundred lines on the runtime stream): fall back to a controlled reproduction. Find one failing call's actual inputs from cloud `agent_runs` (the `input_summary` + channel + timestamp give you the message; reconstruct the context the same way the call site does), and run the *exact* request-building path Ella uses (via `shared/claude_client.py`) against the real Anthropic API once, capturing the full error. **This is the one allowed live API call** — a single reproduction to capture the error body, nothing more. If you do this, note it in Side effects. Do NOT loop / retry / bulk-reproduce.

4. **Once you have the error body, interpret it against the request-building code.** If it's a token-ceiling error: measure where the bloat is coming from — is it the channel context (the last-15-messages block), the KB chunks, the system prompt, or the combination? Pull the approximate token count of a failing request's components if you can. If it's a malformed-content error: identify which message/field is bad and what produces it (e.g. an empty Slack message body, a system-subtype message slipping through, a mrkdwn structure). Name the specific component — that's what the fix will target.

5. **Bonus, cheap, do if quick:** correlate failure-start timing with deploys. `vercel ls` / deploy history — did the `BadRequestError`s start clustering after a specific deploy? If the diagnostic's "context growing as 136 channels ran for days" theory is right, failures would ramp gradually (no deploy correlation). If it's a code/prompt change, they'd start sharply at a deploy. This distinguishes "gradual context bloat" from "a change broke the request shape" and sharpens the fix.

## What success looks like

A report at `docs/reports/ella-haiku-badrequest-log-investigation.md` that contains:

- **The verbatim Anthropic `BadRequestError` message body** — the literal string(s) from the logs (or the single reproduction). This is the core deliverable.
- **The named cause** — which part of the request is invalid and what produces it, tied to a specific component in the request-building path (`shared/claude_client.py` / the context assembly / the KB block / the model+max_tokens config).
- **Gradual-vs-deploy timing read** (step 5) if obtainable.
- **A "what the fix touches" pointer** (NOT the fix) — e.g. "cap context at N messages / truncate KB block / fix the model id / guard empty content" — enough for Director to scope the fix spec immediately.

Keep it tight. Drake wants the error string and the cause, not a treatise.

## Hard stops

- **Read-only.** No fix, no prompt edit, no committed code change. The ONE exception is step 3's single controlled reproduction call if logs are unavailable — one call, capture the error, stop. No bulk reproduction.
- **No secrets in the report or logs output.** The Anthropic key / Slack tokens may appear in env dumps or verbose CLI output — never paste them into the report, the committed report, or any persistent file. Quote only the error message body, not request headers/auth.
- Operate in `ella-worktree`, not `main`.
- Do not touch anything Close-related — backfill running on `main` in parallel.
- If Vercel CLI isn't authenticated in the worktree, STOP and report that — don't improvise an alternate method beyond step 3's reproduction.

## What could go wrong — think this through yourself

Seeds, surface anything else: Vercel runtime log retention is short — the 36h-old failures from the diagnostic may already be gone; you may need to either catch a *fresh* failure (they're still happening — passive monitoring is live on 136 channels) or use the step-3 reproduction. The error body might reveal MORE than one distinct failure mode under the single `BadRequestError` class — don't stop at the first; check whether the token-ceiling and a malformed-content error both exist. The reproduction path (step 3) must rebuild context exactly as the call site does or you'll get a *different* (passing or differently-failing) request and a misleading answer — if you can't faithfully reconstruct the inputs, say so rather than reporting a reproduction that didn't match production shape. And: if the cause is token-ceiling, confirm it's the *input* ceiling (200k context window) vs an *output* `max_tokens` misconfiguration — these have different fixes and the error string distinguishes them.

## Mandatory doc updates

- Write the report to `docs/reports/ella-haiku-badrequest-log-investigation.md`.
- Flip this spec's `Status:` to `shipped` in the same commit that lands the report (read-only investigation, no gate).
- No other doc edits. If a `docs/known-issues.md` entry is warranted, NAME it in the report's "Out of scope / deferred" for Director to spec — don't edit known-issues directly.
