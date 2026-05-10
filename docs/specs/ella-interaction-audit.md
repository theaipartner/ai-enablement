# Ella interaction audit (pre-V2 sweep)

**Slug:** ella-interaction-audit
**Status:** in-flight

## Context

Before scoping Ella V2 Batch 2 (passive monitoring + behavioral expansion), Drake wants a full audit of every production interaction Ella has had so far. Two known bugs have already surfaced from a single recent message:

1. **`[ESCALATE]` token leaked into client-visible Slack response.** Per CLAUDE.md § Ella § System Prompt Direction point 10, the backend strips this token before it reaches the user. The detector only looks for the token at the start of the response; the leaked instance had it mid-response after a client-facing message. Ella generated both client text AND escalation handoff text in one response, with `[ESCALATE]` as a section separator rather than a routing flag.
2. **Speaker mis-identification.** Ella addressed Nico as "Javi" because the channel-to-client resolution defaults to `slack_channels.client_id` for every speaker. This is `docs/agents/ella/future-ideas.md` § V2.4, logged 2026-04-27 during pilot testing.

Both bugs were tolerated in V1 pilot because Drake/Scott were the only testers and knew how to interpret around them. They become unacceptable once Batch 2 (passive monitoring) ships — passive monitoring expands surface area to every message in every channel, and bug exposure scales with traffic.

This spec is **read-only diagnostic**. No fixes. Builder pulls every Ella interaction from production, joins it against surrounding context, flags anomalies, and produces a structured report Drake reads through one interaction at a time. The output of this spec is the input to Batch 1.5 — a fix-sweep spec that gets written *after* Drake reviews this audit and Drake + Director collaboratively identify the full bug list.

Estimated interaction count: <50, probably 20-30. Heavyweight analysis is feasible at this scale.

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. The shape of `agent_runs` — what columns exist (`agent_name`, `status`, `trigger_metadata`, `input_summary`, `output_summary`, `tokens_in`, `tokens_out`, `cost_usd`, `duration_ms`, `created_at`, plus the channel/user fields). Verify `agent_name='ella'` is the canonical filter.
2. The shape of `escalations` — how it links back to `agent_runs` (foreign key? embedded run_id?), what's stored in `escalations.context` (jsonb structure for `ella_response`, `proposed_response`, `reasoning`).
3. The shape of `slack_messages` — `slack_channel_id`, `slack_ts`, `slack_thread_ts`, `slack_user_id`, `author_type`, `text`, `sent_at`. Confirmed by the rollout that just shipped (3,641 rows across 8 channels).
4. The current state of `clients.slack_user_id` and `team_members.slack_user_id` populations — needed for the speaker-resolution-correctness check. If either is sparse, the check will produce many false-positives ("Ella didn't resolve speaker X" when really we just don't have X's slack_user_id mapped).
5. Whether any `agent_runs` rows for Ella exist with `status='error'` — these are likely informative bug surfaces in their own right (failure modes during V1 that were never debugged).

## Goal

Produce a single markdown document at `docs/reports/ella-interaction-audit.md` that contains, for every Ella production interaction, enough structured detail for Drake to read sequentially and flag behavior issues. Drake reviews the doc, identifies bugs and patterns, and Director uses Drake's annotations to scope Batch 1.5 (the fix-sweep spec).

This is a "report-as-spec-output" pattern — the report IS the deliverable. No code is committed beyond the diagnostic script Builder writes to produce it.

## What success looks like

The output report has the following structure:

### Section 1: Summary statistics

Top-level numbers Drake can scan in 30 seconds:

- Total Ella runs (`agent_runs WHERE agent_name='ella'`)
- Breakdown by `status`: responded / escalated / error / skipped (or whatever the actual status values are — Builder reads the schema)
- Date range (earliest run, latest run)
- Total tokens consumed, total cost
- Per-channel run count (how many in each of the 8 V1 pilot channels)
- Distinct triggering users (count of unique `slack_user_id` values that mentioned Ella)
- Count of runs flagged on each anomaly check (defined below)

### Section 2: Anomaly flags

Five specific anomaly checks. Each is a query Builder runs across all Ella runs, producing a list of run_ids that match. The summary section reports counts; this section lists the actual flagged runs with explanations.

**Check A: `[ESCALATE]` token leakage.** Any `agent_runs.output_summary` (or whichever column stores Ella's response text) that contains the literal string `[ESCALATE]` AND the corresponding row in `escalations` does NOT exist (or `agent_runs.status != 'escalated'`). These are runs where Ella tried to escalate but the detector didn't catch it.

If Ella's response text isn't fully stored on `agent_runs` (some pipelines truncate to a summary), Builder surfaces this limitation in the audit and falls back to whatever IS stored. Cross-reference with Slack-side message text via `slack_messages` if needed (the response gets posted to Slack, so it lands in `slack_messages` with `author_type='ella'`).

**Check B: Speaker mis-identification.** For each run, identify the triggering Slack user (`slack_user_id` of the @mention). Look up that user's `clients.slack_user_id` or `team_members.slack_user_id`. Compare to the channel's mapped `slack_channels.client_id` → `clients.full_name`. Flag any run where the triggering user is NOT the same as the channel's mapped client.

These are the runs where Ella was responding to someone other than the channel-mapped client — and based on V1 prompt design, would have addressed them by the wrong name. False-positive risk: if `clients.slack_user_id` or `team_members.slack_user_id` is null for the triggering user, Builder can't determine identity. Flag these as "unresolvable" rather than "mis-identified."

**Check C: Error runs.** Any `agent_runs WHERE agent_name='ella' AND status='error'`. Include the error message if stored. These are runs where something broke during execution; review them for failure-mode patterns.

**Check D: Suspiciously long or short responses.** Statistical outliers on output length (response text token count, or `tokens_out`). Top 3 longest, top 3 shortest. Long responses might be a sign of run-on or hallucinated padding; very short ones might be acks Ella shouldn't have sent.

**Check E: Bare-mention triggers.** Per future-ideas V2.3: a bare `@Ella` with no follow-up message. Heuristic: input text after stripping the mention is empty or <5 characters. Flag these and note what Ella actually returned.

### Section 3: Per-run detail (the body of the audit)

One subsection per run, in chronological order (oldest first — lets Drake see how V1 evolved). Each subsection has:

#### Run header
- Run ID (link to `agent_runs.id` for cross-reference)
- Timestamp (ISO 8601)
- Channel: `<channel name>` (`<slack_channel_id>`) → mapped client: `<client name>` (`<client_id>`)
- Triggering user: `<resolved name>` (`<slack_user_id>`) — author_type: `<client / team_member / ella / bot / unknown>`
- Status: `<responded / escalated / error / skipped>`
- Tokens: `<in>/<out>`, Cost: `$<x.xxxx>`, Duration: `<ms>`
- Anomaly flags fired on this run: `[A, B, C, ...]` (or "none")

#### Input
The actual message that triggered Ella — the @mention text, with mentions resolved to display names where possible.

If the run was inside a thread (not at thread root), include the thread root and any prior turns Ella *would* have seen (V2.2 says she doesn't see them today; this audit is the surface that would prove how often that matters).

#### Surrounding context
The 5 messages immediately before the trigger and the 5 immediately after, from `slack_messages` filtered to the same channel + thread (or channel-level if not threaded). Each line:

`[<sent_at HH:MM>] <author_type> <resolved_name>: <text (truncated to ~200 chars)>`

This is the conversational context Drake needs to judge whether Ella's response made sense.

#### Ella's response
The full response text Ella posted. Verbatim. Do NOT truncate — Drake needs to see the whole thing including any leaked `[ESCALATE]` tokens or weirdness.

If the response text isn't fully stored on `agent_runs`, fall back to looking up the corresponding `slack_messages` row (matching channel + thread + author_type='ella' + sent_at within a few seconds of the run's `created_at`) and include that text. Note in the audit which source was used.

#### If escalated: handoff context
The full `escalations` row for this run if status='escalated' — `proposed_response`, `reasoning`, `resolution`, `resolved_by`, `resolved_at`. Drake needs to see whether the escalation handoff was sensible and whether it was actually resolved.

#### Drake's notes
A blank `**Drake's notes:**` line with placeholder text like `_(fill in any concerns or patterns noticed)_`. This is where Drake annotates as he reads. The annotations become the input to the Batch 1.5 fix spec.

### Section 4: Patterns Director should consider

Builder's own observations after seeing the data. NOT prescriptive (don't propose fixes here — that's Director's job in the Batch 1.5 spec). Just patterns:

- "X out of Y runs had `[ESCALATE]` token leakage"
- "Speaker mis-ID happened on Z out of Y runs where the triggering user was distinct from the channel-mapped client"
- "Error runs cluster around <date> — possible deploy regression?"
- "Token costs spike on responses to <pattern> — worth investigating efficiency"

These are Builder's read of the data. Drake + Director use them as starting points for the Batch 1.5 conversation.

## Hard stops

- **No fixes.** This spec is diagnostic only. If Builder finds itself thinking "I could fix that while I'm in here," stop. Fixes go in the Batch 1.5 spec that follows this one.
- **No new tables, columns, migrations.** If a query needs data that isn't in the schema, surface that as a finding rather than adding columns.
- **No changes to Ella's runtime code.** The audit reads `agent_runs`, `escalations`, `slack_messages`, `clients`, `team_members`, `slack_channels`. That's it.
- **No PII in commit messages or anywhere outside the audit doc.** Client names and conversation content go in the audit doc itself (which lives in the repo's docs folder). Commit messages should be generic ("docs: add Ella interaction audit").
- **No deletion of any data.** Read-only queries throughout.
- **If `agent_runs` doesn't store full response text** (just summaries), that's a finding to surface, not a blocker. Use the slack_messages fallback as described in Section 3.

## What could go wrong

Think this through yourself:

- The `agent_runs` schema may not match Director's assumptions about column names. Read the actual schema before constructing queries.
- `clients.slack_user_id` may be sparsely populated, making Check B noisy. Builder distinguishes "mis-identified" from "unresolvable" cleanly.
- `escalations` may have different cross-reference shape than Director assumed (foreign key vs embedded run_id vs neither). Verify before writing the join.
- Some runs may have no surrounding `slack_messages` context if they happened in channels that weren't backfilled, or if the thread root is older than the backfill window. Note when context is unavailable.
- The audit doc may end up large (20-30 runs × ~30 lines each = 600-900 lines). That's fine — Drake explicitly asked for heavyweight. Don't truncate to make it shorter.
- The `[ESCALATE]` token might appear in responses that DID successfully escalate (i.e., the detector worked and the token was stripped from Slack but lingered in `agent_runs.output_summary` if storage happened pre-strip). Builder surfaces both cases distinctly: "leaked to Slack" vs "in agent_runs only, stripped from Slack."

## Mandatory doc updates

- **`docs/reports/ella-interaction-audit.md`** is the primary deliverable.
- **No CLAUDE.md update.** This is a one-shot diagnostic, not a system state change.
- **No `docs/agents/ella/ella.md` update.** Audit findings inform Batch 1.5; that spec will update Ella docs once fixes are designed.
- **No `docs/known-issues.md` updates** unless Builder finds something completely outside the audit scope (e.g., a schema integrity issue affecting other agents). In that case, surface in the report's Surprises section first; Director adds known-issues entries if warranted.

## Side effects expected

- **Read-only DB queries.** Multiple SELECT queries against `agent_runs`, `escalations`, `slack_messages`, `clients`, `team_members`, `slack_channels`. No writes.
- **A diagnostic script** at `scripts/audit_ella_interactions.py` (Builder's call on the path — could also be a one-shot inline script that runs and discards). If a script lands in the repo, it should be self-documenting and re-runnable later if the audit needs refreshing.
- **No external API calls** — everything is in our DB.
- **No Slack writes** — read-only on `slack_messages`, no posting.

If the script ends up reusable for future audits (e.g., a quarterly Ella behavior review), it lives in `scripts/` permanently. If it's truly one-shot, it can also live in `scripts/` — small files don't hurt, and a future Director might want to re-run the same analysis on different agents.

## Commit + report

The report IS the spec output, but it lives at `docs/reports/ella-interaction-audit.md` per the spec/report convention.

Commits:
- `feat(audit): add Ella interaction audit script` — if a script is created.
- `docs: add Ella interaction audit report` — the report itself.

Bundle into one commit if the script is trivial (under 100 lines) and inseparable from the report.

After the report lands, Drake reads through it and adds his annotations to the `**Drake's notes:**` placeholders. Then Director writes the Batch 1.5 fix spec based on Drake's annotations.
