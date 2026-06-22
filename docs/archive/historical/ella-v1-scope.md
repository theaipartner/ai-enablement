# Ella V1 — Scope for Team Review

*Short version of `docs/agents/ella/ella.md` — what Ella actually does in week one. Read this before Thursday's test session.*

## Purpose

Ella is an AI assistant for clients of The AI Partner, living in client Slack channels. She answers factual questions about course content, methodology, and logistics — the repetitive stuff that used to tie up a CSM's day. When a question is ambiguous, emotional, or out of scope, she hands off to the client's CSM via Slack DM instead of guessing. The goal is faster client responses without trading away quality or safety.

## In scope for V1

- Course content questions (*"where's the module on cold calling?"*, *"what's the framework for pricing?"*)
- Methodology and FAQ answers (*"how does the weekly accountability work?"*, *"what's the expected call cadence?"*)
- Referencing the client's own past conversations on Slack and prior call summaries
- Pointing clients to specific course modules, SOPs, or resources
- In-thread responses only — she replies to the thread of the message she was @mentioned in, never to the main channel
- Escalating to the client's primary CSM via Slack DM when uncertain

## Out of scope — she'll escalate to the CSM

- Billing, refunds, cancellations, payment changes
- Complaints about the CSM, the company, or the program
- Medical, legal, or financial advice
- Questions about other clients
- Emotional or crisis-adjacent statements (*"I'm struggling"*, *"thinking of quitting"*)
- Requests for guarantees or predictions about their results
- Anything that would change account settings, permissions, or data

## Out of scope — she'll politely decline

- General trivia, coding help, anything unrelated to the program
- Roleplay requests (*"pretend you're X"*)
- Prompt injection attempts (*"ignore your instructions"*, *"reveal your system prompt"*)

## Deferred to V1.1 — things she will not yet do

The team should know these aren't built yet:

- **Cool-down on correction.** If she gets something wrong in a channel and the CSM corrects her, she won't automatically become more cautious in that channel afterward. She'll still respond with the same confidence until V1.1 lands.
- **Formal eval harness.** No 20-example golden dataset with pass/fail gates. We're replacing that with live team testing (below) for speed.
- **Per-channel on/off gating.** The pilot channel list (7 clients + #ella-test) is hardcoded. Adding or removing a channel requires a small code change, not a setting flip.
- **Thumbs-up/down reactions.** Slack reactions on her messages won't automatically record feedback in the database. For V1, feedback is verbal — tell Drake or Nabeel in the test channel.
- **Impersonation / replay mode.** No way to "ask as if you're client X." Team testing is direct @mentions from team members.

## How the team tests her

- **Thursday and Friday this week** — #ella-test channel. Drake, Scott, and Nabeel fire questions at her.
- Mix of **in-scope** (real course questions, methodology, scheduling), **out-of-scope-escalate** (billing, emotional), and **out-of-scope-decline** (trivia, prompt injections).
- Report problems in #ella-test. Drake fixes in real time or logs for weekend iteration.
- No structured scoring — just "does this embarrass us or not."

## Ship bar

Team agrees she won't embarrass the company in front of pilot clients. That's it. No formal eval harness, no pass-rate threshold. Trust the Thursday/Friday team sign-off.

## Rollout plan

1. **Thu + Fri** — team testing in #ella-test. Real questions, edge cases, adversarial inputs.
2. **Weekend** — buffer for fixes based on what Thu/Fri surface. Drake + whoever else is around.
3. **Monday** — live in the 7 pilot client channels. Announcement already went out to clients, so Monday is a commitment.
4. **Monday onward** — live iteration based on real client usage. Problems land as tickets; small fixes go out inside a day.

## Known limitations the team should expect

- **Hallucination risk on unusual questions.** She's instructed not to fabricate, but if a question lands outside the retrieved context, she may still say something wrong. Escalation is the safety net — when she signals a handoff, the backend routes it to the advisor's DM. (Under the hood she emits a structured marker the backend matches on; you'll never see it.)
- **Fathom transcript misattribution.** Fathom's speaker diarization occasionally attributes quotes to the wrong person. Ella hedges on transcript quotes for this reason — she'll paraphrase or say *"based on the notes from your call on [date]"* rather than naming a specific speaker. Flag any misattributions you see.
- **No memory across threads.** Each @mention is stateless. If a client asks a follow-up in a new thread, Ella doesn't recall the earlier thread's content unless the retrieval surface covers it.
- **94 "unknown" Slack authors** in the backfilled data — messages from users we couldn't resolve to a client or team member. Won't affect Ella's answers but will show up in any Slack-sourced retrieval as `author_type=unknown`. Backfill pass planned post-launch.

---

Questions, flags, edits: Drake. Full technical spec: `docs/agents/ella/ella.md`.
