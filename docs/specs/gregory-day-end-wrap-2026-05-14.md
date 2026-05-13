# Gregory day-end wrap — Ella booking-link note + cleanup + future ideas + state recalibration
**Slug:** gregory-day-end-wrap-2026-05-14
**Status:** in-flight

## Context

End-of-day bundle. Five workstreams in one Builder pass:

1. **Ella system prompt — one new line.** Scott observed Ella suggested a client `@`-mention their CSM to book a call. The right path is the calendar booking link. Add a generic note to Ella's system prompt so she steers clients to the booking link uniformly. Universal — one line, no per-CSM config.

2. **Spec/report cleanup.** Delete shipped specs and reports from today's session. Git history preserves them; working tree stays clean.

3. **Branch cleanup.** Delete merged feature branches (locally + remote). **Preserve the `promethean` branch** — it has unmerged work Drake wants to keep available.

4. **File/folder cleanup.** Delete the `fix pics/` folder and the three `Gregory <surface> Redesign.html` files — historical reference no longer needed; recoverable from git history or re-generatable via Design if ever wanted.

5. **Doc recalibration to live state.** Update `CLAUDE.md` and `docs/state.md` to reflect (a) the Gregory redesign as fully shipped, (b) the Playwright-on-preview visual verification workflow as the durable norm for visual work, (c) the three future ideas Drake wants tracked.

Working branch: `main`. No PRs needed; commit + push directly.

## Reference reads (in this order)

1. `agents/ella/prompts.py` — Ella's system prompt lives here (24KB file). Find the section that lists Ella's behavioral norms / conventions / what-to-do guidance. Insert the booking-link line in the most natural place.
2. `CLAUDE.md` — § Current Focus, § Next Session Priorities, § Working Norms / Drake-Director-Builder. Updates land in those sections.
3. `docs/state.md` — read the existing voice and pattern. Append a new entry for today's wrap.
4. `docs/future-ideas.md` — existing file. Three new entries get appended.
5. `docs/runbooks/design-handoff.md` — already documents the Playwright workflow per yesterday's wrap. Confirm the Playwright workflow is documented there; if not, add a short paragraph.

**Acclimatization checkpoint:** before writing any code, confirm in 5–6 bullets in your first commit message: (a) the exact section + insertion point in `agents/ella/prompts.py` where the booking-link line will land — quote the surrounding lines, (b) the full list of shipped specs and reports to delete (cross-check against the proposed list in § B below — surface any discrepancies), (c) `git branch -a` output showing branches, with your proposed delete list (highlighting `promethean` as preserved), (d) the file paths of the four file/folder deletions (`fix pics/`, three HTML files), (e) the design-handoff runbook's current coverage of Playwright — does it already document the workflow or does this spec need to add a paragraph, (f) any unexpected drift.

## Decisions locked in by Director

From Drake/Director conversation 2026-05-14.

1. **Ella system prompt line is generic, universal, no per-CSM linking.** Exact phrasing:

   > "Clients meet with their advisors via a calendar booking link."

   That's the whole line. No instruction to avoid `@`-mentioning a CSM, no specific URL, no per-client logic. The information is enough — Ella infers the right behavior from knowing the mechanism. Insert at a natural place in the prompts.py system prompt (Builder picks the section based on what fits the prompt's structure; surface choice in Surprises).

2. **Specs to delete** (with their matching reports):

   From today's work:
   - `docs/specs/gregory-client-detail-warmup-fixes.md` + `docs/reports/gregory-client-detail-warmup-fixes.md`
   - `docs/specs/gregory-editable-primary-csm.md` + `docs/reports/gregory-editable-primary-csm.md`
   - `docs/specs/gregory-csm-visual-and-list.md` + `docs/reports/gregory-csm-visual-and-list.md` (if exists; verify)
   - `docs/specs/gregory-action-items-transfer-fix.md` + `docs/reports/gregory-action-items-transfer-fix.md`
   - `docs/specs/gregory-send-to-slack-action-items.md` + `docs/reports/gregory-send-to-slack-action-items.md`
   - `docs/specs/gregory-ella-pre-redesign-fixes.md` + `docs/reports/gregory-ella-pre-redesign-fixes.md`
   - `docs/specs/gregory-ella-escalation-output-body.md` + `docs/reports/gregory-ella-escalation-output-body.md`

   From yesterday's work (if not already cleaned in the wrap spec yesterday — Builder verifies):
   - `docs/specs/gregory-redesign-wrapup.md` + `docs/reports/gregory-redesign-wrapup.md`

   This spec itself (`gregory-day-end-wrap-2026-05-14.md`) plus its report stay in place — they're in-flight during this session and get cleaned in the next session's wrap (if Drake bundles that way).

3. **Branches to delete** (local + remote):

   Likely set:
   - `gregory-redesign-part-1-foundations`
   - `gregory-csm-visual-fixes`

   Plus anything else Builder finds in `git branch -a` that's fully merged into main AND isn't `promethean`. Surface the full proposed delete list in the acclimatization commit; Drake confirms before deletion.

   **PRESERVE the `promethean` branch.** Has unmerged work; do not delete.

4. **Files/folders to delete:**
   - `fix pics/` (folder, contains screenshots no longer needed)
   - `docs/working/Gregory Calls Redesign.html`
   - `docs/working/Gregory Clients Redesign.html`
   - `docs/working/Gregory Ella Redesign.html`

   The HTMLs were referenced in the design-handoff runbook as the visual reference; that reference becomes git-history-only. The runbook should be updated to remove the dead path references — see § E below.

5. **Future ideas land in `docs/future-ideas.md`.** Three new entries, in the file's existing voice. Drake's three:

   - **Gregory CSM utilization check.** A quick routine that audits whether CSMs are actually using Gregory (logging into the dashboard, editing action items, marking journey stages, sending Slack messages from the Action items box, etc.). Surface for Nabeel/Drake to see which CSMs are leaning on Gregory vs. ignoring it. Format and scoping deferred.
   - **Teams page.** A meeting-tracker view for CSMs based on Google Calendar. V1: each CSM sees their own meetings; Nabeel sees all team members'. Permission scoping is the load-bearing part. Builds toward CSM cadence tracking + late-flag workflow.
   - **Admin cost hub.** A view (admin-only) showing costs across all the tools we use (Anthropic API spend, Supabase, Vercel, Slack, etc.) so Nabeel can spot cost-reduction opportunities. Scoping deferred — likely starts with what's already trackable (Anthropic + Supabase) and grows.

6. **`CLAUDE.md` updates** — three specific edits:

   a. **§ Current Focus** — flip from "Gregory redesign — shipped 2026-05-13" entry to reflect the additional Gregory work shipped today (Primary CSM, action items, Send-to-Slack, Ella visual fixes + redesign). One paragraph.

   b. **§ Next Session Priorities** — re-rank with the three future ideas (CSM utilization check, Teams page, Admin cost hub) added to the carried items. Drop items already shipped (the three CSM-detail bug fixes from yesterday's queue are done). Rough new order: Send-to-Slack production cutover (turn off dry-run, let CSMs use it real) is item 1 if not already done; everything else carries; future ideas land at items 4-6 or wherever they fit Drake's perceived priority.

   c. **§ Working Norms** — confirm the Playwright visual-verification workflow is documented (already added in yesterday's wrap if Builder confirms; if missing, add a short paragraph noting Playwright + preview-branch + env-gated bypass).

7. **`docs/state.md` updates** — add a new entry for today's work:

   - Primary CSM editable on detail + list (yesterday's Decision + today's polish)
   - Action items transfer fixed (the `.eq('owner_client_id', id)` predicate)
   - Send-to-Slack server action shipped (dry-run-validated, awaiting production cutover)
   - Ella pre-redesign fixes (mrkdwn renderer, full message expansion, surrounding context removed, escalation body persistence)
   - Ella visual redesign by Claude Design + Builder
   - Brief mention of the booking-link prompt note shipped today
   - The Playwright-on-preview workflow as the durable visual-verification mechanism

   Match the existing voice; don't paste this list as bullets, weave into prose like prior entries.

## What success looks like

### A. Ella prompt update

In `agents/ella/prompts.py`, locate the system prompt's behavioral-norms section (or whatever the natural insertion point is per acclimatization point a). Add the line:

```
Clients meet with their advisors via a calendar booking link.
```

The line should be a complete statement, fit naturally in the prompt's flow, and not feel bolted on. If the existing prompt has a numbered list or bulleted list of behavioral norms, the line joins that list. If it's prose, the line gets its own short sentence.

### B. Spec/report cleanup

Delete the files listed in Decision 2. Each pair is one `docs/specs/<slug>.md` + one `docs/reports/<slug>.md`. The acclimatization checkpoint requires Builder to enumerate the actual delete-set and Drake's confirmation before deletion lands.

If Builder finds shipped specs/reports beyond what's listed, surface them with the question "delete or keep?" — don't silently delete unlisted items.

### C. Branch cleanup

After acclimatization commit lists the actual branches that exist (via `git branch -a`), and after Drake confirms the delete-list, delete the merged branches:

```bash
# Local branch
git branch -d <branch-name>

# Remote branch
git push origin --delete <branch-name>
```

Use `-d` (lowercase) not `-D`. `-d` refuses to delete branches with unmerged commits as a safety net. If `-d` errors on a branch, surface — that branch may have orphaned work.

**DO NOT DELETE `promethean` BRANCH.** Drake has unmerged work there.

### D. File/folder cleanup

Delete:
- `fix pics/` (folder; use `rm -rf "fix pics/"` since the name has a space)
- `docs/working/Gregory Calls Redesign.html`
- `docs/working/Gregory Clients Redesign.html`
- `docs/working/Gregory Ella Redesign.html`

Commit with a message like `chore: remove archived design artifacts and fix-pics folder`.

### E. Runbook reference cleanup

`docs/runbooks/design-handoff.md` references the three design HTML files as "the durable visual reference for the visual language." With the HTMLs deleted, those references become dead paths. Update the runbook to:

- Remove the dead-path references
- Reframe the section to say something like "Past hand-offs at `docs/working/Gregory <Surface> Redesign.html` were the reference during the Gregory redesign; they've since been archived to git history. For future visual work, follow the four-stage flow with fresh hand-offs."

Or alternatively — if Builder thinks the references should stay because the file paths are useful even pointing at git-history-only files, surface the call in Surprises. Drake's lean: remove the dead references; the runbook should point at live things.

### F. CLAUDE.md updates

Three sections per Decision 6.

**Current Focus** — replace the existing "Gregory redesign — shipped 2026-05-13" paragraph with something like:

```
**Gregory redesign — fully shipped 2026-05-14.** Full Calls + Clients + Ella visual refresh + Part 1 foundation primitives. Editable Primary CSM (detail + list). Action items transfer between /calls and /clients. Send-to-Slack action items (dry-run-validated; production cutover pending). Ella pre-redesign fixes (mrkdwn renderer, message expansion, escalation body persistence). Ella visual redesign by Claude Design + Builder.

**Next:** see § Next Session Priorities item 1.
```

Builder writes in the actual file's voice; this draft is illustrative.

**Next Session Priorities** — re-rank. Drake's new ordering preference:

```
1. **Send-to-Slack production cutover.** Turn off SLACK_DRY_RUN in Vercel Production. Let a CSM be the first real send. Monitor Vercel function logs for the first few real sends.

2. **CSM utilization check.** A quick routine to audit whether CSMs are actually using Gregory — logging in, editing action items, marking journey stages, sending Slack messages from the Action items box. Surface for Nabeel/Drake to see which CSMs lean on Gregory. Format and scope deferred.

3. **Teams page.** A Google Calendar-backed meeting tracker. V1: CSMs see their own; Nabeel sees all. Permission scoping is the load-bearing part. Builds toward cadence tracking + late-flag workflow.

4. **Admin cost hub.** Admin-only view across all tools we use (Anthropic API, Supabase, Vercel, Slack, etc.) for Nabeel to spot cost-reduction opportunities. Likely starts with Anthropic + Supabase and grows.

[carry the remaining items from yesterday's queue: Ella V2 Batch 2.1, Meeting tracking, Batch B NPS scores, Batch C Action item HITL flow, Batch D classifier tuning, Batch E client business context vault]
```

The three CSM-detail bug fixes from yesterday's queue are done; drop them. Anything else that's been completed gets pruned. Items not started carry.

**Working Norms** — confirm the Playwright visual verification workflow is documented. If yesterday's wrap added it, no change needed. If missing, add a short paragraph under § Drake / Director / Builder noting that visual work uses Playwright on the Vercel preview branch with `NEXT_PUBLIC_DISABLE_AUTH=true` set Preview-only.

### G. docs/state.md update

Append a new entry for 2026-05-14 capturing today's ship per Decision 7. Match the existing voice — prose, batch-by-batch.

### H. docs/future-ideas.md update

Append three new entries under whatever section is appropriate (existing voice). Per Decision 5:

- **Gregory CSM utilization audit** — short paragraph
- **Teams page (calendar-based meeting tracker)** — short paragraph
- **Admin cost hub** — short paragraph

Match how existing future-ideas entries are structured.

## Hard stops

1. **Before deleting any spec/report files OR branches OR design artifacts**, Builder lists the full delete-set in the acclimatization commit message and waits for Drake's explicit confirmation. The lists in this spec are proposed; Drake confirms before deletions land.

2. **DO NOT delete the `promethean` branch** under any circumstances. Drake explicitly preserved it. If Builder's branch enumeration shows `promethean`, it stays in the keep list.

3. **If the Ella prompt's structure doesn't have a natural insertion point** for the new line (e.g. the prompt is purely instructional and the booking-link statement feels out of place anywhere Builder considers), surface before inserting. Don't force a fit.

4. **If `docs/runbooks/design-handoff.md` doesn't reference the HTML hand-off files at all** (i.e. Builder's plan to remove dead references doesn't apply), surface — the deletion might still happen but the runbook update is unnecessary.

## Think this through yourself — what could go wrong

- **Spec/report cleanup might miss something or include something that shouldn't be deleted.** The acclimatization enumeration is the safety net. Drake reviews the full proposed list before any deletions.

- **Branch cleanup might surface an `error: branch X is not fully merged` for something Builder assumed was merged.** That's the safety net working — `git branch -d` won't delete branches with unmerged commits. If Builder hits this, surface and Drake decides whether to investigate or `-D` force-delete.

- **The Ella prompt insertion might cause prompt regressions.** Adding a sentence changes the prompt's overall shape. If the booking-link sentence accidentally crowds out an existing instruction, Ella's behavior could drift. **Mitigation:** Builder reads the surrounding context carefully before inserting; the insertion is one sentence, low risk.

- **Future-ideas entries land in a section Drake didn't intend.** `docs/future-ideas.md` may have multiple sections (e.g. "Gregory ideas" / "Ella ideas" / "Operations ideas"). Builder picks based on the file's structure; if ambiguous, all three go under a "Gregory" or "Dashboard" section since they all relate.

- **state.md update voice mismatch.** Different entries may use different prose styles. Builder reads 2-3 recent entries and matches the closest one.

- **CLAUDE.md Next Session Priorities re-ranking could drop something important.** Drake's ordering in Decision 6 is illustrative, not exhaustive — Builder should preserve all carried items, not just the ones I named. The carried items include: Send-to-Slack production cutover (item 1 above is this), Ella V2 Batch 2.1, Meeting tracking, Batch B (NPS scores), Batch C (HITL flow), Batch D (classifier tuning), Batch E (context vault). Anything else from yesterday's list that hasn't shipped also carries.

- **The HTML deletion makes the design-handoff runbook reference dead.** § E covers this. If Builder forgets, the runbook says "see docs/working/Gregory Calls Redesign.html" pointing at nothing.

- **`fix pics/` folder name has a space.** `rm -rf "fix pics/"` works with quotes. Builder uses quotes; documented in § D.

- **Deleting branches doesn't reclaim git history.** All the deleted branches' commits are still accessible via their SHAs. This is fine — git history is the durable record.

## Mandatory doc-update list

- `agents/ella/prompts.py` — one-line addition per § A.
- `CLAUDE.md` — three section edits per § F.
- `docs/state.md` — new entry per § G.
- `docs/future-ideas.md` — three entries per § H.
- `docs/runbooks/design-handoff.md` — possibly, per § E (remove dead-path references).
- `docs/known-issues.md` — no update needed unless something surfaces during build.
- `docs/agents/ella/ella.md` — possibly small. If the prompt change is significant enough to surface in the agent's behavior doc, add. Builder's call.

## Out of scope for this spec (explicit)

- Per-CSM booking links (universal line only).
- Implementing any of the three future-ideas items.
- Send-to-Slack production cutover (separate small action — flipping the env var).
- Anything beyond cleanup, prompt update, and doc recalibration.
- Tests beyond build cleanliness (`npx tsc --noEmit`, ESLint) — no Playwright needed for this spec since no UI changes.
- Touching any code paths beyond the one-line prompt update.
- `promethean` branch — preserved.
