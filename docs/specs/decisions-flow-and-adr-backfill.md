# Decisions-flow ritual + ADR backfill (decision capture into docs/decisions/)
**Slug:** decisions-flow-and-adr-backfill
**Status:** shipped

**Target branch: main**

> NOT Ella-worktree work — this is whole-system docs (CLAUDE.md + docs/decisions/). Run from the MAIN checkout. Close backfill unaffected. This is the session close-out doc task: wire ADR-writing into the working norms so decisions stop evaporating, and backfill the load-bearing decisions that were made recently but never got an ADR.

## Why

`docs/decisions/` has only three ADRs (0001 foundational stack, 0002 title convention, 0003 timezone) despite many architectural/process decisions since. The reason is structural: under the specs-only topology, Director can't write ADRs directly — they must ride a Builder spec — and there's no ritual forcing that. Decisions get captured in *specs*, which get *deleted at EOD* (§ Director/Builder System › Cleanup cadence), so the durable "why" disappears with them. Concrete cost this session: the @-mention/passive split (a major behavior decision) lives only in chat memory + now-deleted spec bodies; the cost-hub misdiagnoses happened partly because prior decisions weren't durably recorded. Drake wants decision-writing to be a standing duty in the working norms, not an ad-hoc thing.

## Part 1 — wire ADR-writing into the working norms (CLAUDE.md edits)

Two complementary mechanisms (both, deliberately — most decisions ride a feature spec, but some don't, so we need the per-spec habit AND an end-of-session backstop):

**A. Per-spec default.** When a spec embodies a real architectural or process decision (not every spec — only ones making a durable "we chose X over Y, because Z" call), the ADR write rides in that spec's mandatory-doc-updates list. Director adds it when writing the spec; Builder writes/updates the ADR in `docs/decisions/` as part of execution.

**B. End-of-session backstop ("decisions sweep").** At session close — alongside the existing state.md / CLAUDE.md update expectations — any decisions made during the session that did NOT get an ADR via mechanism A get captured now, via a dedicated tiny spec Builder executes. This catches decisions that didn't ride a feature spec (pure judgment calls, design reframes mid-session).

**The specific CLAUDE.md edits** (use str_replace precisely — do NOT regenerate the whole file):

1. **§ Working Norms › Communication preferences › the "Capture decisions in writing as you make them" bullet.** It currently conflates decision-capture with spec-writing and doesn't mention ADRs at all. Rewrite it to distinguish two tiers: (i) *lightweight* decisions that ride along in a spec body / chat memory short-term (as today), and (ii) *architectural/process* decisions that get a durable ADR in `docs/decisions/`. State that because specs get deleted at EOD, anything meant to be a durable "why we did this" record must become an ADR — a spec body is NOT a durable record. Cross-reference mechanism A (rides a feature spec's doc-updates) and mechanism B (EOD sweep). Keep the existing "Drake wants to look back and see why calls were made" intent — that's exactly what this fixes.

2. **§ Director/Builder System › Spec and report convention › Cleanup cadence.** The paragraph that says shipped specs/reports get deleted at EOD and "the durable record lives in CLAUDE.md § Live System State + git history." Add: durable *decision rationale* lives in `docs/decisions/` ADRs, not in the spec bodies (which are deleted) — so a decision worth remembering must be ADR'd before its spec is cleaned up. This closes the gap where the deletion ritual silently discards the only written "why."

3. **Add an explicit EOD-ritual mention.** There's no single "EOD ritual" block today — the EOD duties are scattered (spec/report deletion in Cleanup cadence; state.md/CLAUDE.md update expectations in § Update Policy). Add a short standing list of EOD close-out duties. Cleanest home: a new short subsection in § Director/Builder System (e.g. "### Session close-out (EOD)") that enumerates: (a) flip + batch-delete shipped spec/report pairs (existing, cross-ref Cleanup cadence), (b) update state.md / CLAUDE.md Current-Focus + Next-Session-Priorities if anything shifted (existing, cross-ref Update Policy), (c) NEW: decisions sweep — any architectural/process decision made this session that isn't yet ADR'd gets one. Keep it tight — a pointer list, not prose. Reference the existing sections rather than duplicating their detail.

Use judgment on exact wording + placement; the REQUIREMENT is that a future Director/Builder reading CLAUDE.md cold understands: architectural decisions get ADRs, ADRs ride specs (per the specs-only constraint), and the EOD sweep is the backstop that catches un-ADR'd decisions before specs are deleted.

## Part 2 — backfill the load-bearing recent decisions as ADRs

Write these as new ADRs in `docs/decisions/`, matching the existing template exactly (read `docs/decisions/0003-timezone-conventions.md` for the shape: `# ADR NNNN: Title`, Date / Status / Decision makers, Context, Decision, Consequences [Positive / Negative-accepted], Known deviations, Implementation pointers, Review). Next numbers are **0004, 0005**. Backfill ONLY the load-bearing architectural ones — not an exhaustive sweep:

**ADR 0004 — Ella @-mention / passive-monitoring split (synchronous @-handler, observation-only passive).** The big one. Context: the 2026-05-18 unified-path refactor + 2026-05-19 over-escalating classifier broke @-mention curriculum answers (deflected to humans). Decision: split into a dedicated synchronous `handle_at_mention` path (retrieve KB → one Sonnet call with chunks visible → structured-JSON {response_text, escalate, handoff_reasoning} → answer or ack+escalate) vs an observation-only passive path (feeds digest + unanswered-flagger, no in-channel voice). Includes the sub-decisions: structured-JSON escalation output with four categories (judgment-call / emotional / money / no-good-context) and explicitly NO navigation-escalation rule; recent-conversational-context plumbing kept (last 3 @-exchanges, this-channel, paired by USER_ID); the structural-fix-over-prompt-iteration principle as applied here (already an operational pattern in CLAUDE.md — reference it, don't duplicate). Consequences: @-mentions answer curriculum questions again; passive is silent-but-observing; @ dispatch currently gated behind passive_monitoring_enabled (accepted, passive left on everywhere). Source specs (deleted, recover from git if needed): the ella-at-mention-passive-split + ella-at-mention-recent-context + ella-reply-as-human slugs. Decision makers: Drake with Director.

**ADR 0005 — Cost-hub archive semantics: cancel-vs-remove + cancelled-but-visible.** Context: a cancelled-mid-month subscription (ElevenLabs) wrongly vanished from the current-month total; Drake wanted cancelled subs to stay visible-and-counted for their paid month. Decision: (i) current-month total counts rows active-in-month including mid-month-archived (matches history-path semantics via `subscriptionActiveInMonth`); (ii) two operations on the × button — Cancel (soft-archive: stops next month, stays counted + visible-with-badge this month) vs Remove (hard delete: mistakes, gone from all totals/history); (iii) cancelled-but-still-in-paid-month subs render in the list with a "cancelled" badge so visible line items sum to the total; drop from the list once the month passes (stay in history); (iv) extras are Remove-only (one-offs have no "next month"). Consequences: page line-items reconcile to the total; the editable-table-vs-total split is the structural guard against the co-edit divergence that caused the original bug. Source specs (deleted): cost-hub-current-month-total-fix + cost-hub-total-cancel-remove-and-add. Decision makers: Drake with Director.

Do NOT backfill exhaustively — skip decisions already adequately captured elsewhere (e.g. the structural-fix-over-prompt-iteration principle is already in CLAUDE.md § Operational patterns; reference it from ADR 0004 rather than making it its own ADR). If you judge another recent decision genuinely load-bearing and undocumented, note it in the report for Director rather than writing it unprompted.

## Acclimatization checklist

Confirm in 4 bullets:
- The three CLAUDE.md edit sites (Communication-preferences decision bullet; Cleanup-cadence paragraph; where the new EOD close-out subsection goes).
- `docs/decisions/0003-timezone-conventions.md` — the ADR template to match.
- The next ADR numbers (0004, 0005).
- The source material for the two backfill ADRs (this session's work; specs are deleted but the decisions are summarized in Part 2 above + recoverable from git log if more detail needed).

## What success looks like

- CLAUDE.md reads coherently: architectural decisions → ADRs, ADRs ride specs, EOD sweep is the backstop. No contradiction with the existing specs-only / Director-doesn't-edit-docs rules.
- `docs/decisions/0004-*.md` + `0005-*.md` exist, match the template, capture the two decisions with enough "why" that a cold reader gets it.
- The edits are surgical (str_replace), no unrelated CLAUDE.md drift.

## Hard stops

- **str_replace for CLAUDE.md — do NOT regenerate the whole file.** Unrelated-paragraph drift in a full rewrite is the exact risk the specs-only rule exists to avoid. Precise edits only.
- No code changes (docs-only spec). No schema, no migration, no Close/Ella-code touches.
- MAIN checkout.
- If a CLAUDE.md edit would contradict an existing rule, STOP and surface rather than papering over it.

## What could go wrong — think this through yourself

Seeds: the specs-only constraint is the subtle trap — "Director writes an ADR when a decision is made" is literally impossible under the topology (Director writes only specs), so the wording must be "decisions become ADRs via a spec Builder executes," not "Director writes the ADR." Make sure the new ritual text doesn't accidentally tell Director to do something it structurally can't. Don't duplicate detail across sections — the EOD subsection should POINT to Cleanup-cadence and Update-Policy, not restate them (stale-duplication risk). ADR 0003 references `/ella/runs` (`getEllaSummaryStats`) as a consumer — but the prior spec (`remove-ella-runs-page`) deletes that surface; if that spec already ran, ADR 0003's implementation-pointers are now stale — note this in the report as a tiny follow-up (don't fix ADR 0003 here unless trivial; flag it). The backfill ADRs describe decisions whose specs are deleted — lean on the Part 2 summaries; if a detail's genuinely unrecoverable, write what's known and note the gap rather than inventing specifics.

## Mandatory doc updates

- CLAUDE.md — the three edits in Part 1.
- `docs/decisions/0004-*.md` + `0005-*.md` — the backfill (Part 2).
- `docs/reports/decisions-flow-and-adr-backfill.md` — the report; note any stale cross-refs found (e.g. ADR 0003 ↔ removed `/ella/runs`) + any decision judged load-bearing-but-skipped for Director.
- Flip Status to shipped on completion (docs-only; no smoke needed beyond reading coherently).
