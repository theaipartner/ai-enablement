# Pre-handoff cleanup pass

**Slug:** pre-handoff-cleanup
**Status:** in-flight

## Context

End of a long working session. Multiple shipped specs and reports accumulated under the new EOD-batch cleanup convention; several follow-up items captured in chat memory need to land in durable docs before context drops. This spec is the housekeeping pass before handoff.

Builder's job: delete shipped specs and reports per the convention, capture follow-up items in `docs/known-issues.md` and `CLAUDE.md`, and surgically update CLAUDE.md sections that drifted during the session. No code changes anywhere.

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. The current state of `docs/specs/` — which slugs exist, which are pre-convention (no front-matter), which are status=`in-flight` vs `shipped`. Listed in § "Spec/report cleanup" below for sanity-check.
2. The current state of `docs/reports/` — paired reports exist for each shipped spec; verify before deleting.
3. The current state of `docs/known-issues.md` — read it once. The file's existing entry format and section structure determine where new entries land. The "RESOLVED YYYY-MM-DD" strike-through pattern with preserved-original-bullets is the model for follow-ups that get logged as known issues.
4. The current state of `CLAUDE.md` § Live System State — confirm the Batch 2.2 entry that Builder added during the audit-dashboard ship is correct (or needs adjustment based on validation gaps Drake flagged).
5. The current state of `CLAUDE.md` § Working Norms § Communication preferences — confirm the existing language so the new time-references clarification slots in without conflicting.

---

## Task 1 — Delete shipped specs and reports

Per the EOD-batch cleanup convention codified mid-session in CLAUDE.md § Spec and report convention: when work ships, status flips to `shipped` mid-day and Drake batches deletion at EOD. This is that EOD batch.

**Delete (verify each is shipped before removing):**

- `docs/specs/ella-v2-batch-1-finish-rollout.md` + `docs/reports/ella-v2-batch-1-finish-rollout.md`
- `docs/specs/docs-sync-batch-1-done.md` + `docs/reports/docs-sync-batch-1-done.md`
- `docs/specs/ella-interaction-audit.md` + `docs/reports/ella-interaction-audit.md`
- `docs/specs/ella-v2-batch-1-5-behavioral-fixes.md` + `docs/reports/ella-v2-batch-1-5-behavioral-fixes.md`
- `docs/specs/ella-v2-batch-2-2-audit-dashboard.md` + `docs/reports/ella-v2-batch-2-2-audit-dashboard.md`

For each pair: check that the spec's `Status:` line is `shipped`. If any is still `in-flight`, flag and skip — don't delete unshipped work.

**Preserve `docs/reports/README.md`** if it exists, or the `.gitkeep` placeholder mentioned in CLAUDE.md § Spec and report convention. The folder should still exist after cleanup.

**Do NOT touch the two pre-convention specs in `docs/specs/` for this pass:**
- `cs-call-summary-review-content.md`
- `ella-v2-batch-1-cloud-slack-ingestion.md`

These are flagged for separate handling — see Task 2.

## Task 2 — Pre-convention specs decision

Two specs in `docs/specs/` predate the front-matter convention (`# Title` / `**Slug:**` / `**Status:**`). The `/run` slash command currently flags them as unparseable on every invocation.

**The two specs:**
- `docs/specs/cs-call-summary-review-content.md` — the M6.1 spec from 2026-05-09 that birthed the CS visibility surface. The work shipped. No paired report exists at `docs/reports/cs-call-summary-review-content.md`.
- `docs/specs/ella-v2-batch-1-cloud-slack-ingestion.md` — the original Batch 1 cloud Slack ingestion spec (separate from the `ella-v2-batch-1-finish-rollout` spec Task 1 deletes). The work shipped 2026-05-09. No paired report exists.

**Builder's call:** delete both. Rationale: they describe shipped work that's already documented in CLAUDE.md § Live System State and the relevant runbooks. Keeping them around as "historical record" duplicates information that lives more durably elsewhere, and they keep failing `/run` matching. The right historical record for these is git history.

If Builder disagrees and prefers to backfill front-matter instead, that's an acceptable alternative — flag in the report. Don't leave them as-is though.

## Task 3 — Log the five Batch 2.2 dashboard follow-ups in known-issues

Drake flagged five items needing fixes on the new Ella audit dashboard during validation. Drake said "note that for follow up" — meaning durably log so they can be picked up after handoff. They were NOT specified individually in chat; Drake mentioned them collectively.

**Builder's job:** add a single placeholder entry to `docs/known-issues.md` for the dashboard follow-ups. Use this exact wording, since the specific items haven't been enumerated yet:

```markdown
## Ella audit dashboard (`/ella/runs`) — 5 follow-up fixes flagged during validation

- **What:** Drake validated the Batch 2.2 audit dashboard in production on 2026-05-11 and flagged five distinct items requiring follow-up fixes. The specific items were not enumerated in the chat session; they'll be captured here when Drake re-engages with the dashboard and writes them up. Five issues total — each gets either its own followup line below this entry, or a single bundled spec, depending on whether they cluster.
- **Why it matters:** the dashboard is shipped but has known rough edges. Without capturing the specific issues, they could get lost in the post-handoff context drop. The 5 flagged items represent the gap between "the dashboard works" and "the dashboard is ready for CSM use beyond Drake."
- **Next action:** Drake fills in the five specific items below this entry when he next engages with the dashboard. If they cluster (e.g., "filter UX issues" + "detail-view rendering bugs" + "performance"), bundle into a single fix spec. If they're independent, capture as individual followups. Either way, the gap closes when the five items are addressed.
- **Logged:** 2026-05-11.
```

The placeholder is the durable signal that the follow-ups exist. Drake fills in specifics post-handoff.

## Task 4 — Log the four held items from session memory

Four items Drake explicitly asked Director to commit to memory during the session for integration after Ella work wraps. They now need durable storage.

Add these as four separate entries in `docs/known-issues.md`. The format follows the file's existing 4-line shape (What / Why it matters / Next action / Logged).

### 4a. Vercel auto-deploy intermittent failures — deeper investigation owed

There's already a known-issue entry titled `## Vercel auto-deploys silently failed on recent pushes to main (intermittent)` logged 2026-05-10. **Builder does not duplicate this.** Verify the entry exists and is up to date; if it needs anything appended (e.g., a note about the recurrence Drake mentioned in the Batch 2.2 validation step), append a sentence rather than creating a new entry.

If the existing entry is fine as-is, no action for 4a.

### 4b. `/run` slash command fix needed

```markdown
## `/run` slash command requires `/run .` to invoke — bug

- **What:** The `/run` slash command in `.claude/commands/run.md` is designed to find the single in-flight spec under `docs/specs/` without a matching report and execute it. In practice it doesn't fire on `/run` alone or `/run ` (with trailing space); the user has to type `/run .` (with a trailing period or arg) for the command to invoke. Likely cause: the `disable-model-invocation: true` directive in the command frontmatter requires an argument for the command to be recognized as user-invoked vs. model-attempted, but the no-arg invocation path treats it as the latter and silently drops it.
- **Why it matters:** every Builder session adds friction. Drake has to remember to type `/run .` (with the trailing token) rather than `/run`, which is the more natural shape. Doesn't break anything — workaround is known — but compounds over time as the convention scales.
- **Next action:** investigate the command frontmatter. Two likely fixes: (a) remove `disable-model-invocation: true` if model-invocation isn't a real concern for this command, OR (b) make the command accept a no-arg shape by adjusting the command body to handle "no spec specified" cleanly. ~15-min Builder task once someone can read the actual Code-side slash-command runtime to understand why no-arg invocation drops. Drake mentioned in chat he has a fix queued — that note's preserved here as a hand-off pointer.
- **Logged:** 2026-05-11.
```

### 4c. Partial report on hard stop — new Builder norm

```markdown
## Partial report on Builder hard stop — Builder norm not yet codified

- **What:** Today's Builder behavior on hard-stop is: surface the issue in chat to Drake (since Drake is in the loop on the Code session) and wait. If Drake walks away or aborts, there's no automatic "write what got done so far" step. The work that completed before the hard stop sits as committed code on `main`, but Director has no async-readable artifact describing it. Asymmetric with Builder's end-of-task report flow, which produces a report only when work completes.
- **Why it matters:** Director-and-Drake conversation about what to do next has to be synchronous (Drake summarizes Builder's chat output) instead of async (Director reads a partial report). Cost is real — every hard-stop incident adds Drake-summarization overhead.
- **Next action:** add a paragraph to CLAUDE.md § Director / Builder System § Builder behavior. Suggested wording: "When Builder encounters a hard stop and cannot proceed without Drake or Director input, Builder writes a partial report at `docs/reports/<slug>.md` describing what was completed (with commit hashes), what was attempted and blocked, the specific block (error message, missing schema, unresolvable ambiguity), and what input would unblock it. Then Builder exits cleanly. The partial report uses the same six-section structure as a normal report — the empty sections still get filled with explicit 'none' or 'blocked by X.'" This Builder-norm change is the integration item; the spec itself is the placeholder.
- **Logged:** 2026-05-11.
```

### 4d. File MCP for chat — Director-side improvement queued

```markdown
## File MCP for chat (Director side) — Drake has fix queued

- **What:** Today's GitHub MCP requires Director (chat-Claude) to rewrite full files on every edit. This is slow and high-token-cost on a 70KB CLAUDE.md — every small surgical change becomes a full file rewrite. Drake has a fix queued (a file MCP that supports `str_replace`-style targeted edits in chat, mirroring Builder's `str_replace` tool). Not urgent today but worth tracking.
- **Why it matters:** Director's effective rate-limit on doc edits is much lower than Builder's because of the full-file-rewrite pattern. Once the file MCP lands, Director can do surgical doc edits as fast as Builder can, which speeds up the "in-chat doc hygiene" loop materially.
- **Next action:** Drake ships the file MCP when ready. No Director-side action needed — Director starts using `str_replace`-style operations once the new MCP is available. Until then, Director continues writing specs for Builder to execute when surgical edits would be too painful via full-file rewrite.
- **Logged:** 2026-05-11.
```

## Task 5 — CLAUDE.md § Working Norms § Communication preferences — time-references clarification

Drake asked Director to clarify the "no time references" rule for future sessions. The rule's origin: Director kept misreading "EOD" as calendar-end-of-day when Drake meant "end of the current work session/workflow position." The rule prevents Director from over-anchoring on time language.

**Surgical edit:** find the existing § Working Norms § Communication preferences section in CLAUDE.md. Find the existing line that addresses time references (if one exists from a previous session's edit) or the natural insertion point. Add or update with this clarification:

```markdown
- **Time references mean workflow position, not calendar position.** When Drake says "EOD," "end of session," or "today," these refer to the *workflow phase* (the end of the current focused work session), not the literal calendar end of day. Director historically misread "EOD" as "before midnight tonight" and made urgency calls that didn't match Drake's intent. When in doubt about which sense applies, ask Drake to clarify rather than guess.
```

If the existing section already has language addressing this, Builder may need to merge the new wording with the existing wording rather than appending. Use judgment — the goal is one coherent rule, not duplicated language.

## Task 6 — CLAUDE.md § Next Session Priorities + Ella sections restructure

The Ella work has moved from "sidelined" to "active focus." CLAUDE.md should reflect this — but the active "Gregory" focus also still exists. Both can be active priorities; the doc just shouldn't say Ella is sidelined.

**Two specific edits:**

### 6a. § Ella (sidelined) section header

Currently this section header in CLAUDE.md says `## Ella (sidelined)`. Builder updates the header to `## Ella (active focus)` and updates the body of the section to reflect the post-Batch-1.5 + post-Batch-2.2 state:

- Ella V2 Batch 1 ingestion is live for 8 channels with backfill complete (3,641 messages).
- Ella V2 Batch 1.5 behavioral fixes shipped + validated on 2026-05-10.
- Ella V2 Batch 2.2 audit dashboard shipped on 2026-05-11.
- Batch 2.3 (passive monitoring) is queued next.
- Batch 2.1 (Slack messages as retrieval surface) deferred but re-promoted to active roadmap, scheduled after 2.3.

Don't write a verbose status dump — keep it concise (5-7 lines max). The detailed state lives in § Live System State.

### 6b. § Next Session Priorities — reorder

The current ordering has Meeting tracking + Gregory batches first, then Ella deferred. Update to reflect that Ella V2 is now the active multi-batch focus. Suggested new ordering:

1. **Ella V2 Batch 2.3 — passive monitoring.** (Big spec, will need its own scoping pass before code. Drake will scope when ready.)
2. **Ella V2 Batch 2.1 — Slack messages as retrieval surface.** (After 2.3; has anonymization/cross-client privacy constraints that need scoping pass.)
3. **Meeting tracking — bridge into Task Management.** (Gregory-side, was previous current focus; still queued.)
4. **Gregory Batches A-E remaining work.** (As-is from existing list.)

Use Builder's judgment on the exact wording — the goal is the priority order shifts to reflect the actual state.

## Task 7 — `docs/agents/ella/future-ideas.md` — mark Batch 2.1 status

The future-ideas doc has two relevant entries for the Slack retrieval surface:

- **"Slack real-time ingestion via Events API"** (logged 2026-04-23) — superseded by Batch 1 cloud ingestion shipping. Mark as `~~SUPERSEDED 2026-05-09~~` with a short note.
- **"Slack messages as a retrieval surface (V1.1)"** (logged 2026-04-23) — this is what's now Batch 2.1. Update the entry's `Revisit trigger` line to reflect: "ACTIVE — scheduled for Batch 2.1 after Batch 2.3 passive monitoring ships. See CLAUDE.md § Next Session Priorities."

Don't delete either entry — the historical context (why these were deferred originally) is useful when designing 2.1's spec.

## Hard stops

- **No code changes anywhere.** This is pure docs/hygiene work.
- **No deletion of specs whose Status is `in-flight`.** If any spec on the delete list reads `in-flight` rather than `shipped`, flag in the report and skip that one.
- **No deletion of `docs/reports/README.md` or any `.gitkeep` placeholder** that keeps the directory present in git.
- **No new sections in CLAUDE.md beyond what's specified.** All Task 5/6 edits are surgical updates to existing sections.
- **No new known-issues entries beyond the ones Task 3+4 specify.** Builder doesn't add "while I'm in here" entries — surface anything else as a flag in the report's Surprises section.
- **No backfilling front-matter on the pre-convention specs** (per Task 2's decision to delete rather than backfill).

## Mandatory doc updates

Every change in this spec is itself a doc update. The output is:

- 5 spec/report pairs deleted (Task 1)
- 2 pre-convention specs deleted (Task 2)
- 6 new entries in `docs/known-issues.md` — 1 dashboard placeholder (Task 3) + 3 individual entries (4b, 4c, 4d) + 1 verification of 4a (no edit if it's current) + 1 implicit if Task 4a needs appending
- 1 surgical update to CLAUDE.md § Working Norms § Communication preferences (Task 5)
- 2 surgical updates to CLAUDE.md (Task 6a + 6b)
- 2 surgical updates to `docs/agents/ella/future-ideas.md` (Task 7)

## What could go wrong

- **The spec Status lines might already be `shipped`** (per the EOD-batch convention being followed mid-session), or they might still be `in-flight`. Builder verifies before deleting.
- **The existing § Communication preferences section might already have time-reference language** from an earlier edit Builder isn't tracking. Read the section before adding; merge if there's overlap.
- **The pre-convention specs might have value I'm not seeing.** If Builder finds reason to preserve one (e.g., it documents something not captured anywhere else), flag in the report rather than just executing the delete.
- **The known-issues file is large.** Builder needs to find the right insertion point for new entries — match the file's existing convention for "most recent at top" vs "most recent at bottom" vs section-grouped. Read the file once before inserting.
- **The dashboard placeholder entry in Task 3 is intentionally vague** because the specific items aren't enumerated. Drake fills in after handoff. Builder's job is to land the placeholder; don't try to enumerate items Builder doesn't know.

## Commit + report

One logical commit per logical change. Suggested commits:

1. `chore: delete shipped specs and reports (EOD batch)` — Task 1.
2. `chore: delete pre-convention specs (cs-call-summary + cloud-slack-ingestion)` — Task 2.
3. `docs: log Batch 2.2 dashboard follow-ups placeholder in known-issues` — Task 3.
4. `docs: log 4 session followups in known-issues (run, partial-report, file-mcp)` — Task 4 (Vercel followup either already exists or gets touched here per 4a).
5. `docs: clarify time-references rule in CLAUDE.md communication preferences` — Task 5.
6. `docs: move Ella to active focus + reorder CLAUDE.md Next Session Priorities` — Task 6.
7. `docs: update Ella future-ideas for Batch 2.1 active roadmap` — Task 7.
8. Final report commit.

If commits naturally bundle (e.g., Task 4 entries all land cleanly in one commit, Task 6a+6b in one commit), bundle. The principle is one logical change per commit.

Report at `docs/reports/pre-handoff-cleanup.md` per the spec/report convention.

After report lands, Drake reads. If Drake confirms clean, the session ends.
