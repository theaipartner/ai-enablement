# EOD 2026-05-19 Doc Update

**Slug:** eod-2026-05-19-doc-update
**Status:** in-flight

## Context

End-of-day doc reconciliation for 2026-05-19. Today shipped four Ella architecture iterations (refactor + daily digest → unified path → prompt sharpening v1 → prompt sharpening v2 → @-mention structural override → passive-monitoring default-on) and surfaced one real production misfire late evening that resulted in an emergency disable of passive monitoring across 136 channels. The architecture entries from each ship are already in `docs/state.md`'s historical timeline — they were written by Builder as each spec landed. What's missing is the end-of-day reconciliation: today's evening misfire, the kill switch, the lessons learned, and one Working Norms hardening that came out of the day.

This spec is **doc-only.** No code, no migrations, no env vars, no tests beyond pytest staying green at 653. Director writes the spec; Builder edits the docs precisely.

The work has three parts:

1. **`docs/state.md` — today's EOD entry** capturing the production misfire, the three distinct issues it surfaced, the kill switch, and the current paused-pending-investigation state.
2. **`CLAUDE.md` — Working Norms hardening** capturing the lesson that prompt-iteration on competing-rule LLM decisions hits diminishing returns; structural moves beat further prompt copy when a model keeps rationalizing through enumerated outputs.
3. **`docs/known-issues.md` — three new entries** for the three structural gaps the misfire exposed (idempotency, rate-limiting on ack_and_escalate, human-routing recognition). These are known issues to bring back to forward when production resumes.

## Acclimatization checklist

Builder reads these first and confirms in 3-4 bullets:

- `CLAUDE.md` § Working Norms, § Director / Builder System — particularly the spec-writing standards and gate trajectory sections.
- `docs/state.md` — the existing entries from today (architecture refactor, unified path, prompt sharpening v1/v2, structural override, default-on). Today's EOD entry appends BELOW the most recent existing entry (which is the default-on entry); the chronological-with-newest-on-top pattern means today's EOD entry goes at the very top of the dated-section block, immediately under the `Gregory editorial skin shipped` heading.
- `docs/known-issues.md` — Builder reads the file to confirm the formatting / structure convention before adding three new entries. New entries follow whatever the existing convention is.
- The smoke-diagnostic + the partial reports from today (`docs/reports/ella-decision-haiku-prompt-sharpening-smoke-diagnostic.md`, `docs/reports/ella-at-mention-structural-override.md`, `docs/reports/ella-passive-monitoring-default-on.md`, `docs/reports/ella-passive-monitoring-default-on-shipped.md`) — to ground the today's-events narrative in what actually happened.

## What changes — by file

### Modify: `docs/state.md` — add today's EOD entry

Insert at the top of the dated-section block, immediately under the `## Gregory editorial skin shipped` heading and above the existing `### 2026-05-19 — PM (late evening): Ella passive monitoring default-on` entry. This becomes the newest entry in the chronological timeline.

The entry copy:

```markdown
### 2026-05-19 — EOD: Production misfire + emergency kill switch + paused-pending-investigation

The default-on ship (entry below) brought Ella's passive monitor live across 137 channels. **Within hours, a production misfire surfaced three distinct structural gaps that combined into Ella posting 3 responses to a single client message that wasn't directed at her.**

**The misfire.** In channel C0AFEC456JG, Dhamen Hothi (client) posted "<@Scott> <@Lou> Who controls my sub account? I'm trying to integrate a power dialer into GHL…" — explicitly @-mentioning Scott and Lou, NOT Ella. Within 45 seconds Ella posted three acknowledge_and_escalate responses to the channel (4:58 PM ET ack #1, 4:58 PM ET ack #2, 4:59 PM ET ack #3 after Dhamen posted a second message adding `<@U0AR5684W0Y>`). Six total DMs fired to Scott + Lou (3× each). From the team's POV, Ella was firing wildly at a message that the client had already routed to two specific humans.

**Diagnostic findings (read-only, no code changed):**

1. **Duplicate processing of the first client message** (problem A). Two `agent_runs` rows with byte-identical `input_summary` reflected the same `slack_messages` row at 16:58:14 ET — Slack delivered the same message event twice (retry / `message_changed`) and the realtime-ingest fork fired the full passive pipeline twice. The acknowledge_and_escalate path on the decision-Haiku path has no idempotency check. `pending_digest_items` has a unique index on `(slack_channel_id, triggering_message_ts)`, but the upstream ack post + escalations row + DM fan-out doesn't consult anything like it. Slack's retry semantics produced ack #1 and ack #2 from the same source message.

2. **No firm-after-first / rate-limit on `acknowledge_and_escalate`** (problem B). Dhamen's second message at 16:58:59 ET (the bare `<@U0AR5684W0Y>` adding another teammate to the thread) triggered ack #3. From the system's POV correct — separate message, separate decision. From Dhamen's POV the thread feels acked-to-death because the first ack hadn't had time to settle. The unified-path refactor explicitly removed firm-after-first with no replacement on the ack path. A stuck client posting multiple messages in 45 seconds = multiple acks + multiple Scott/Lou DM rounds.

3. **No "client routed to specific humans → Ella stays silent" rule** (problem C). Dhamen's `<@Scott> <@Lou>` is a clear "I'm asking these specific humans" signal. The decision Haiku prompt has no rule like "if the client @-mentions an advisor by name, defer to them" — the only @-mention-related rule (and even that overlay was just removed in the structural-override surgery this evening) covered @-mentions of Ella herself. From the prompt's POV the message looked like a generic stuck-client question that warranted ack_and_escalate. From a human-watching-the-channel POV, "client tagged the two humans they want help from" reads as "the system should stay out — they've already routed it themselves."

**Critically: `is_ella_mentioned=false` on all 6 runs and `mention_classifier_shape=null` — the structural @-mention override shipped at 23:05 UTC worked correctly.** The misfire was NOT a regression of the structural override. The classifier was correctly bypassed because Ella was not @-mentioned. All 3 acks came through the DECISION HAIKU path, not the classifier path. Problems A and B are independent of @-mentions entirely (would fire identically if Dhamen had @-mentioned no one). Problem C is the part that the "Ella responded to a message not directed at her" framing zeroes in on.

**The amplifier was today's default-on ship.** Migration 0042 raised the monitored-channel count 7→137 (19.6×). Problems A, B, and C all existed pre-flip but with only 7 channels under observation, the probability of duplicate Slack delivery + multi-message stuck-client landing in real time was low. The 137× expansion is the volume vector that surfaced this. Not a regression of 0042 — pre-existing latent gaps exposed by 0042.

**Emergency kill executed.** Single `UPDATE slack_channels SET passive_monitoring_enabled = false WHERE test_mode = false` flipped 136 channels off. Post-state verified: `(passive=True, test_mode=True)` = 1 row (`#ella-test-drakeonly`, intentional), `(passive=False, test_mode=False)` = 136 rows. Drake retains @-mention access ONLY in the test channel — production channels see no Ella behavior at all (the `passive_monitoring_enabled` gate kills both the reactive + passive paths because the unified-path refactor collapsed them). The classifier-vs-decision-Haiku surgery is preserved; the kill is at the dispatch fork, not at the architecture. Re-enabling is a one-line UPDATE flipping the flag back true after the three structural gaps are addressed.

**Paused-pending-investigation state at EOD:** all four Ella architecture ships from today (refactor + daily digest, unified path, prompt sharpening v1/v2, @-mention structural override) remain shipped. Migration 0042 (default-on) is applied and not rolled back; the table-level default stays `true`. The data-level kill is the only thing keeping production quiet. Three new known-issues entries (idempotency on passive dispatch, ack rate-limiting, human-routing recognition) capture the structural gaps to address before the production resume. Test channel is still operational so further iteration on Ella behavior can continue in `#ella-test-drakeonly` without affecting clients.

**The day's larger architectural lesson.** Three prompt iterations (v1: "lean toward respond", v2: "skip is FORBIDDEN", v2+worked example: closing the resolved-thread loophole) all failed to make the @-mention override stick against competing rules in the same prompt. The fix was structural — bypass the decision Haiku entirely for @-mentioned messages and route through a classifier whose output enum doesn't contain `skip`. Each prompt iteration produced cleaner reasoning text from Haiku but reached the same wrong outcome by finding a new rationalization. The right move when an LLM keeps rationalizing through an enumerated decision is to make the decision structurally impossible at the schema layer, not to add more constraints in prose. This is captured as a CLAUDE.md working norm in the same EOD commit-sequence as this entry.

Post-state: **42 migrations, 13 Python serverless functions, 653 pytest passing, 6 TopNav tabs**. Drake gates: (a) none open; (c) production resume is gated on closing the three known-issues entries — separate specs, not today's work. The pre-existing out-of-scope `unused import pytest` ruff item in `test_agent.py` is still untouched (carried over from the v1/v2/structural-override entries; documented for hygiene-pass timing).
```

### Modify: `CLAUDE.md` — Working Norms hardening

Add a new bullet to `## Working Norms` § Operational patterns Director and Builder are strict about (the bulleted list near the end of the section, before the § The people subsection). Insert immediately after the existing "Real-API smoke test before --apply on backfills" bullet:

```markdown
- **Structural fixes beat prompt iteration when an LLM keeps rationalizing through an enumerated decision.** When a Haiku/Sonnet/Opus decision has an enumerated output set (e.g., `skip | respond | escalate`) and the model keeps picking the wrong outcome despite increasingly emphatic prompt copy — three iterations of "lean toward X" → "X is FORBIDDEN" → "X is NEVER allowed plus worked examples" all failing — stop iterating on the prompt and remove the wrong option from the schema. Two patterns work: (a) bypass the model entirely for that subset of inputs via a pre-LLM structural check that routes them to a different code path; (b) split the decision into a smaller classifier whose output enum literally cannot fill the wrong value, with the parser falling back to a safer-than-wrong default on out-of-enum responses. Working example: today's @-mention structural override (2026-05-19 evening). After three prompt iterations failed to make Haiku stop skipping bare advisor @-mentions, the structural fix moved @-mention handling to a separate classifier whose enum is `respond_haiku | respond_sonnet | acknowledge_and_escalate | warm_opener` — no `skip` to pick. The right move when the model keeps finding new rationalizations is to make the wrong outcome structurally impossible, not to add another constraint in prose.
```

### Modify: `docs/known-issues.md` — three new entries

Add three new entries. Builder reads the file first to match whatever the existing convention is for entry formatting (each issue's structure, headers, status field shape). The content for each entry below describes what to capture; Builder formats it to match the file's existing pattern.

**Entry 1 — passive-dispatch idempotency on duplicate Slack events.**

Title: "Passive dispatch has no idempotency check against duplicate Slack message delivery"

Body: Realtime ingest forks to `passive_monitor.evaluate_passive_trigger` on every `slack_message_ingest` event. When Slack delivers the same message event twice (retry semantics, `message_changed` events that match prior content, or webhook redelivery during outages), the full pipeline fires twice including the LLM decision and any client-facing dispatch action. The `pending_digest_items` table has a unique index on `(slack_channel_id, triggering_message_ts)` that prevents double-flagging, but the upstream `acknowledge_and_escalate` dispatch (ack post + `escalations` row + DM fan-out via `fire_escalation_dms`) consults no such guard. Caused 2 of the 3 acks in the 2026-05-19 evening misfire (Dhamen Hothi message in channel C0AFEC456JG fired ack #1 and ack #2 from the same source `slack_messages` row at 16:58:14 ET). Fix shape: add an idempotency check at the dispatch layer reading `(slack_channel_id, triggering_message_ts)` against prior `agent_runs` rows OR a small dedicated dedup table before the LLM call (cheaper) or before the dispatch action (more conservative). Spec required before production resume. Surfaced from the EOD 2026-05-19 diagnostic.

**Entry 2 — no rate-limiting on `acknowledge_and_escalate` for stuck clients.**

Title: "No firm-after-first / rate-limit on acknowledge_and_escalate path"

Body: The unified-path refactor (2026-05-18 PM) removed the firm-after-first gate that the original architecture had with no replacement on the `acknowledge_and_escalate` decision path. When a stuck client posts multiple messages in quick succession (even seconds apart), each one independently triggers an ack + DM round to Scott + primary advisor. From the system's POV each decision is correct (separate message, separate evaluation, both warrant escalation). From the client's POV the thread feels acked-to-death; from Scott/advisor's POV they get multiple DMs about the same situation within minutes. Caused ack #3 in the 2026-05-19 evening misfire (Dhamen's second message at 16:58:59 ET adding `<@U0AR5684W0Y>`, 45 seconds after the first message). Fix shape: per-channel rate-limit on `acknowledge_and_escalate` (e.g., one ack per channel per 5 minutes, with the digest item still writing each time for Scott's daily skim). Implementation can be in-memory cache, DB-backed check against recent `agent_runs`, or Redis if introduced. Spec required before production resume. Surfaced from the EOD 2026-05-19 diagnostic.

**Entry 3 — decision Haiku doesn't recognize client-routed-to-humans signal.**

Title: "Decision Haiku has no rule for 'client @-mentioned specific humans → Ella stays silent'"

Body: When a client explicitly @-mentions one or more team_member users (advisors, Scott, anyone other than Ella) the message is a clear "I'm routing this to these specific humans" signal — Ella should defer. The decision Haiku prompt has no rule covering this case. The only @-mention-related rules in the current prompt cover @-mentions of Ella herself (and even those overlays were removed during the 2026-05-19 evening structural-override surgery — the decision Haiku no longer sees any @-mention overlay because @-mention routing is handled by the structural pre-LLM branch). The result: messages where clients tag advisors-not-Ella get evaluated by the decision Haiku, which can decide `acknowledge_and_escalate` if the content has emotional / money / confusion / stuck-ness signals — interjecting on a conversation the client has already routed. Caused all 3 acks in the 2026-05-19 evening misfire (Dhamen's `<@Scott> <@Lou>` should have been read as routing-to-humans-signal → skip). Fix shape: add a soft rule to the decision Haiku prompt that detects @-mentions of team_member users in the triggering message and defaults to skip unless the message also has other strong "Ella needed" signals. The detection can be structural (parse `<@U…>` mentions, check against `team_members.slack_user_id`) and pass as a boolean field to Haiku in the user prompt, mirroring how `is_ella_mentioned` is already plumbed. Spec required before production resume. Surfaced from the EOD 2026-05-19 diagnostic.

### Tests

None. This is doc-only. Builder confirms `pytest tests/` still passes at 653 post-edit but doesn't add new tests.

## Hard stops

1. **`pytest tests/` regression.** Must stay at 653. If lower, STOP and surface.
2. **`tsc --noEmit` or `next lint` regression.** Must stay clean. No TS touched in this spec, so should be clean by definition.
3. **No code changes in this spec.** If Builder finds itself touching anything outside `docs/state.md`, `CLAUDE.md`, or `docs/known-issues.md`, STOP and surface — this spec is strictly doc-only.

## Smoke test

None — doc-only. Builder verifies the changes render correctly in their respective files by reading them back after edit.

## Mandatory doc updates

Already enumerated above:
- `docs/state.md` — EOD entry inserted at top of dated section.
- `CLAUDE.md` — Working Norms bullet added.
- `docs/known-issues.md` — three new entries.

## Done means

- All three doc edits pushed to `main`.
- `pytest tests/` still passes at 653.
- Spec status flipped to `shipped` in same commit-sequence as the report.
- Report at `docs/reports/eod-2026-05-19-doc-update.md` follows 6-section structure.

Drake's gates:
- (a) None — no migrations, no production changes.
- (b) Any genuinely context-confusing decision Builder hits — surface immediately.
- (c) None — doc-only, no live surfaces to verify.
- (d) None — no env vars.
