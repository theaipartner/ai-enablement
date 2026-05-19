# Smoke Diagnostic: Ella Decision-Haiku Prompt Sharpening
**Slug:** ella-decision-haiku-prompt-sharpening (gate (c) smoke — FAILED)
**Pairs with:** docs/reports/ella-decision-haiku-prompt-sharpening.md (still PARTIAL — left intact)
**For:** Director — to scope the follow-up. No fix applied; diagnosis only, at Drake's instruction.

## TL;DR

The prompt-sharpening smoke **failed**, but **not** for a deploy or routing reason. The two real bare @-mentions still got `skip` despite `is_ella_mentioned=true`. Evidence points to a **prompt-efficacy gap**: the model found a rationalization the absolute @-mention override didn't close — *"bare @-mention, no fresh text, prior thread already escalated **and resolved** ⇒ nothing open to answer ⇒ skip."* Routing is healthy; ingest, passive-monitor, and @-mention detection all fired correctly.

## What was tested (Drake, `#ella-test-drakeonly` / C0AUWL20U8J)

| Time UTC | Message | `is_ella_mentioned` | Decision | Skip rationale (Haiku reasoning) |
|---|---|---|---|---|
| 17:16:37 | `Hey Ella` | **false** | skip | "chitchat… prior escalation already resolved" |
| 17:18:41 | `<@U0B03PTJD3P>` | **true** | skip | "advisor… bare @-mention = continuation of escalated convo from **15:30 ET yesterday**" |
| 18:24:53 | `<@U0B03PTJD3P>` | **true** | skip | "advisor… bare @-mention, no new message… escalated to Scott **~22h ago** and acknowledged" |

## Conclusions

1. **`Hey Ella` skip is correct, exclude it.** Plain text is not a Slack @-mention (`is_ella_mentioned=false`); the override never applied; advisor-greeting-no-question → skip is by design. Drake's expectation here was mismatched to the input — only a real `<@U…>` triggers the override.
2. **Routing confirmed working.** agent_runs rows exist for all three; `is_ella_mentioned` resolved correctly (true on the two real mentions, false on plain text). `SLACK_USER_TOKEN` present; detection fine. Not a routing failure — webhook_deliveries query intentionally skipped per the spec's branch logic (rows exist).
3. **Deploy: very likely live by the 18:24 run.** Both commits (`b79b28b`, `767d44b`) are on `origin/main` (auto-deploy triggered). Reasoning-text tell of a deploy boundary between 17:18 and 18:24 UTC: the 17:16/17:18 runs cite a clock time ("15:30 ET") = the *old* timestamp-only context; the **18:24 run cites "~22h ago"** = the *new* pre-computed delta format this spec introduced. So the 18:24 run appears to be running the **new prompt + rendering and still skipped a true @-mention.** (Builder cannot read the live Vercel function or confirm build timestamp — Drake/Director should verify the `a4952a3` deploy time to firmly classify the 17:18 run as pre-deploy.)
4. **Therefore: prompt-efficacy issue, not deploy/routing.** The sharpened override forces respond/ack when mentioned and threads bare mentions to a prior **question**. But the prior context here was a *resolved escalation*, not an open question — Haiku concluded "no open question ⇒ nothing to do ⇒ skip," treating it as effectively referential/no-op. The "skip FORBIDDEN unless referential" carve-out has an unclosed third path: **resolved/stale prior thread + contentless bare @-mention**.

## For Director — scoping the follow-up

The fix is prompt-only again. Options to weigh:
- **A.** Explicitly close the loophole: when `is_ella_mentioned=true`, a resolved/stale prior thread is NOT grounds for skip — a contentless bare @-mention with no open question gets the warm-opener `respond/haiku` (the prompt already says this for "no prior question"; it needs to also cover "prior thread exists but is resolved/stale"). Tighten the referential carve-out so "no fresh content" alone never qualifies.
- **B.** Add an explicit worked example to the override section using exactly this case (bare `<@Ella>`, advisor speaker, 22h-old resolved escalation in context → `respond/haiku` opener) so the band reasoning has a concrete anchor.
- Likely both A+B in one tight prompt-sharpening-v2 spec. Still no architecture/migration/env — same shape as this spec.

`ella-passive-monitoring-default-on` remains correctly **blocked** behind this — the over-skip is not yet fixed; raising channel volume 7→~130 now would scale the regression. Builder left it untouched as instructed.
