# Gregory redesign wrap-up — docs + cleanup
**Slug:** gregory-redesign-wrapup
**Status:** in-flight

## Context

The Gregory redesign work merged to `main` today. This spec wraps up the working-norms updates, state snapshot, and spec/report cleanup that batched at the end of session.

**Working branch is `main` now** — the `gregory-redesign-part-1-foundations` branch is merged and can be deleted by Drake at his convenience (not Builder's job).

Five bundles of work in this one Builder pass:

1. **CLAUDE.md — design workflow + MCP-edit constraint.** Two paragraph insertions capturing implicit working norms that emerged during the redesign. Carried from a held earlier spec; merged into this wrap-up to avoid spec proliferation.
2. **CLAUDE.md — Current Focus + Next Session Priorities reshuffle.** Gregory redesign is shipped; the in-flight pointer needs to move to tomorrow's queue.
3. **`docs/state.md` — Gregory redesign as shipped state.** Snapshot of what landed: Calls list + detail, Clients list + detail, Ella audit pages, Part 1 foundation primitives, Playwright visual-verification harness.
4. **`docs/runbooks/design-handoff.md` — NEW file.** Documents the design workflow (Drake/Director ideate → Director writes Design prompt → Claude Design produces annotated HTML mocks → Director writes UI spec referencing mocks → Builder implements + Playwright verifies). Future Director sessions reach for this when visual work comes up.
5. **Spec/report cleanup.** Delete shipped spec/report pairs from the redesign work. The work is in git history; the files served their purpose.

## Reference reads (in this order)

1. `CLAUDE.md` — § Working Norms / Drake / Director / Builder, § Director / Builder System / Director behavior, § Current Focus, § Next Session Priorities. The four sections this spec amends.
2. `docs/state.md` — current shape, especially how prior batches are documented. Match the existing voice.
3. `docs/runbooks/` — directory structure for existing runbooks. Match the file's naming + opening conventions to siblings.
4. `docs/specs/` and `docs/reports/` — find all shipped spec/report pairs from the Gregory redesign for cleanup (full list under § E below).

**Acclimatization checkpoint:** before writing any code, confirm in 4–5 bullets in your first commit message: (a) the exact set of CLAUDE.md insertion points (line numbers or quoted surrounding text), (b) the existing voice of `docs/state.md`'s shipped-state entries (how prior batches are written up — Builder mirrors the structure), (c) the list of shipped spec/report files to delete (cross-check against the list in § E below — if any are missing on disk, or unexpected ones are present, surface), (d) where in `docs/runbooks/` the new design-handoff file lands and what naming convention matches, (e) any unexpected drift between this spec and what you find.

## Decisions locked in by Director

From Drake/Director conversation 2026-05-13. Build to these.

1. **Working branch is `main`.** The Gregory redesign branch is merged. All this spec's commits land on `main` directly, no PR.

2. **CLAUDE.md updates use `str_replace`-style precision edits, not full-file rewrites.** Builder edits specific paragraphs in-place. The "Why" — see § A, the MCP-edit constraint paragraph this spec adds — is exactly the principle being applied here.

3. **`docs/state.md` snapshot voice matches existing entries** — declarative, batch-by-batch, no hedging.

4. **`docs/runbooks/design-handoff.md` is a new file** matching the structure of existing runbooks (e.g. `seed_clients.md`, `apply_migrations.md`).

5. **Spec/report cleanup is hard delete** per the EOD-cleanup convention (CLAUDE.md § Cleanup cadence). Git history preserves them; the working directory stays clean.

6. **`docs/working/Gregory Calls Redesign.html` and `docs/working/Gregory Clients Redesign.html` stay in place for now.** They're the design hand-off artifacts referenced by the design-handoff runbook. Drake will decide later whether they get pruned. Builder does NOT delete them.

## What success looks like

### A. CLAUDE.md — design workflow + MCP-edit constraint

**Insertion 1: Design workflow paragraph.** In § Working Norms / § Drake / Director / Builder, insert after the existing paragraph that ends `Drake's role at runtime is the four gates in § Director / Builder System § Drake's gates: irreversibles (incl. SQL-review for migrations), context-confusing decisions, post-deploy testing on real surfaces, credentials / env vars. Everything else is Director's call (for planning / spec / doc work) or Builder's call (for code execution).` and before the `### Communication preferences` heading.

Paragraph content:

```
**Design workflow for visual work.** When work is primarily visual (page redesigns, new UI surfaces, layout changes that need design judgment more than code execution), the workflow is three-stage: Drake and Director ideate the visual direction in chat, Director writes a Design-facing prompt that Drake hands to Claude Design (a separate claude.ai session with the GitHub MCP connector authorized for this repo), Design produces annotated single-file HTML mocks and commits them to the repo at `docs/working/<surface> Redesign.html`. Director then reads the mocks and writes a UI spec for Builder that references the mocks by path, the existing primitives at `components/gregory/*`, and the data fields available. Builder implements against the spec, visually verifies via Playwright on the deploy preview (see `docs/runbooks/design-handoff.md`), and reports. The split keeps each agent in its specialty: Design designs, Code codes, Director sequences. Used end-to-end on the Gregory Calls + Clients redesigns; default to this pattern for future visual work rather than trying to spec design from chat alone or trying to have Code generate design.
```

**Insertion 2: MCP-edit constraint paragraph.** In § Director / Builder System / § Director behavior, insert immediately after the existing paragraph that ends `Director does NOT use GitHub MCP to commit code or Builder's reports.` and before the next paragraph (`**Bundling escape valve.**`).

Paragraph content:

```
**Why specs-only — the MCP-edit constraint.** The GitHub MCP connector Director uses for writes (`create_or_update_file`, `push_files`) only supports full-file overwrites — there's no patch / diff capability. Editing a standing doc means rewriting the whole file from chat memory, which is slow (a 500-line CLAUDE.md takes a full response turn to regenerate cleanly) and error-prone (any unrelated paragraph the Director didn't intend to change can drift in the rewrite). New files (specs at `docs/specs/<slug>.md`) are cheap to write because there's nothing to preserve. Standing-doc edits are expensive and risky. That's why the rule is "Director writes new specs, every other doc change rides in a spec Builder executes" — Builder has `str_replace` and can edit precisely. The rule is mechanical, not stylistic; don't drift back to direct edits when the spec-cost feels heavy.
```

### B. CLAUDE.md — Current Focus reshuffle

Replace the entire `## Current Focus` section with:

```
## Current Focus

**Gregory redesign — shipped 2026-05-13.** Full Calls + Clients + Ella visual refresh + Part 1 foundation primitives (HeaderBand, SentimentPill, InlineEditableField, EmptyStateAwareSection, DiagnosticsCollapse). Design workflow with Claude Design established as the default for visual work (see `docs/runbooks/design-handoff.md`).

**Next:** tomorrow's queue — see § Next Session Priorities item 1.
```

### C. CLAUDE.md — Next Session Priorities reshuffle

Replace items 1–8 in `## Next Session Priorities` with the new list below. Preserve the surrounding paragraph (the intro sentence) and the deferred-decision callout at the bottom.

New items 1–8:

```
1. **Tomorrow's wrap-up bundle — three small client-detail fixes.** Single spec, fast warm-up: (a) make CSM standing editable again on `/clients/[id]` — Scott needs to play around with it; (b) make NPS-enabled and Accountability-enabled toggles actually toggleable on `/clients/[id]`; (c) fix "Back to clients" / "Back to calls" navigation everywhere — currently uses `router.back()` which goes to the previous page in history, not the list. Should always go to the list page.

2. **Send-to-Slack server action.** Wire the Send-to-Slack button on `/clients/[id]` to a real Slack post. Posts open action items to the client's mapped Slack channel. Format / channel-resolution / safety-net are spec questions; needs a real scoping conversation before drafting.

3. **Action items transfer fix.** Action items completed on `/calls/[id]` (via the Confirm flow) need to actually appear on `/clients/[id]`'s Action items box. The data is there (`client.all_action_items` already includes them) but the wiring is incomplete — likely a query / display gap on the redesigned client detail page. Investigate first, spec second.

4. **Ella redesign with the new design workflow.** Same Drake → Director → Design → Builder pass that worked on Calls + Clients. Higher confidence now that the workflow is established. Surface: `/ella/runs` and `/ella/runs/[id]`. The earlier Ella visual work shipped but had quality issues (row dividers, emoji rendering, surrounding messages); a clean redesign pass with Claude Design should be much better.

5. **Ella V2 Batch 2.1 — Slack messages as retrieval surface.** Carried from prior priorities. The 3,641 backfilled `slack_messages` rows + ongoing realtime ingestion produce a rich retrieval surface, but pulling another client's channel content into Ella's prompt context for client X would be a privacy violation. Will need a per-client retrieval-scope gate similar to the call-summary retrieval pattern.

6. **Meeting tracking — bridge into Task Management.** Carried. Per-client + per-CSM cadence visibility, late flags, end-of-week report to Scott + Nabeel. Real scoping conversation needed at session-start before any spec.

7. **Batch B — NPS score piping V1.5.** Carried. Extend Path 1 to ingest the numeric NPS score alongside the segment classification, write to `nps_submissions.score`, surface in the dashboard.

8. **Batch C — Action item HITL flow (Nabeel's "transcript vision", V2 flagship).** Queued. AI drafts action item messages from transcripts → CSM reviews + edits in Gregory → CSM approves → Slack send to client channel + assigned-vs-completed tracking. Item 2 (Send-to-Slack) is a piece of this lighting up.
```

Items 9+ on the existing list (Batch D classifier tuning, Batch E client business context vault, the deferred-decision callout) stay as-is.

### D. `docs/state.md` — Gregory redesign shipped-state entry

Add a new entry under the existing shipped-batch / shipped-work pattern. Match the voice of the most recent entries. Position: at the most recent end of whatever chronological structure `state.md` currently uses.

Content should cover:

- **Gregory redesign — shipped 2026-05-13.** Full visual + UX pass across Calls (list + detail), Clients (list + detail), Ella (audit list + run detail). Editorial-dark theme with gold accent (`--color-geg-accent: #a08850`), decoupled sentiment palette, Newsreader serif + JetBrains Mono pairing.
- **Part 1 foundation primitives shipped:** `components/gregory/header-band.tsx`, `sentiment-pill.tsx`, `inline-editable-field.tsx`, `inline-editable-action-item-row.tsx`, `empty-state-aware-section.tsx`, `diagnostics-collapse.tsx`. Documented in `docs/gregory-conventions.md`.
- **Sentiment classifier shipped.** `agents/call_reviewer/sentiment_classifier.py` — Haiku classifies each call_review's sentiment_arc into green / yellow / red, written to `documents.metadata.sentiment_tier`. Backfill via `scripts/backfill_sentiment_tiers.py` (Drake-run).
- **CSM-on-calls data path.** `lib/db/calls.ts` extended to surface the active primary_csm via the `client_team_assignments` join (mirrors `lib/db/clients.ts:getClientsList`).
- **Visual verification harness.** `scripts/verify-calls-preview.ts` is a Playwright script that loads the Vercel preview deployment, screenshots `/calls` and one `/calls/[id]`, and saves to `scripts/.preview/`. Auth on preview is bypassed via the env-gated `NEXT_PUBLIC_DISABLE_AUTH` flag (Preview-only; never set in Production). Builder reads the screenshots to verify visual work without Drake in the loop.
- **Design workflow established.** Drake → Director chat-ideation → Director writes Design prompt → Claude Design produces annotated HTML mocks committed at `docs/working/<surface> Redesign.html` → Director writes UI spec referencing mocks → Builder implements + verifies via Playwright. Documented in `docs/runbooks/design-handoff.md`.

Builder writes the entry in `state.md`'s existing voice — Builder reads adjacent entries to match the tone and structure (don't paste the above bullet list verbatim; adapt to the file's prose style).

### E. `docs/runbooks/design-handoff.md` — NEW file

Create the file. Half-page runbook documenting the design workflow. Match the structure of existing runbooks in `docs/runbooks/` — Builder reads the closest sibling for the convention.

Required content:

- **When to use this workflow.** Visual work — page redesigns, new UI surfaces, layout changes where design judgment matters more than code execution. Not appropriate for pure data-layer work, small CSS fixes, or text-only changes.
- **The four-stage flow.** (1) Drake + Director ideate in chat. (2) Director writes a Design prompt — reference the existing redesign work (`docs/working/Gregory Calls Redesign.html`, `docs/working/Gregory Clients Redesign.html`) for the established visual vocabulary. Prompt includes: which surface(s) to design, what data fields exist (read `lib/db/<surface>.ts`), what primitives exist (`components/gregory/`), what tokens exist (`app/globals.css` `--color-geg-*`). (3) Drake hands the prompt to Claude Design (separate claude.ai session, GitHub MCP connector authorized for the repo). Design produces an annotated single-file HTML mock and commits it at `docs/working/<Surface> Redesign.html`. (4) Director reads the mock, writes a UI spec referencing the mock by path, hands to Builder via Drake's `/run` cue.
- **Builder's role.** Read the UI spec + the design mock + the conventions doc + the data layer. Implement using existing primitives and tokens, not raw hex. Visually verify via `scripts/verify-calls-preview.ts` (parallel for whatever surface) or a per-surface adaptation. Report inline.
- **The preview-auth bypass.** Visual verification requires hitting the Vercel preview without authentication friction. The mechanism is `NEXT_PUBLIC_DISABLE_AUTH=true` set ONLY on Preview env in Vercel (never Production). The bypass is env-gated in `app/(authenticated)/layout.tsx` — when the env var is unset, normal auth applies. Builder injects no cookie; the preview is open.
- **Spec/report cleanup.** Design hand-off HTML files at `docs/working/<Surface> Redesign.html` stay in place after the work ships — they're the durable reference for the visual language. Specs / reports for the work follow the standard EOD cleanup cadence.
- **What can go wrong + mitigation.** Quick list: Design produces a mock that doesn't reference existing primitives → spec catches this when Director writes UI spec (re-reference primitives explicitly). Code visually drifts from mock → Playwright verification catches. Auth bypass left on in Production → checklist item for any deploy: confirm env var is Preview-scope only.

### F. Spec/report cleanup

Delete the following shipped spec/report pairs. Each pair is one spec file + one report file. The work is preserved in git history; the working directory should be clean post-cleanup.

**Specs to delete from `docs/specs/`:**

- `gregory-redesign-part-1-foundations.md`
- `gregory-redesign-part-2-ella.md`
- `gregory-redesign-part-2-ella-list-polish.md`
- `gregory-redesign-part-2-ella-detail-and-cleanup.md`
- `gregory-redesign-part-2-ella-visual-verification.md`
- `gregory-redesign-part-2-calls-data-layer.md`
- Any other shipped specs Builder finds whose status flipped to `shipped` during the Gregory redesign work — Builder lists them in the acclimatization checkpoint for Drake's confirmation before deletion.

**Reports to delete from `docs/reports/`:**

- The matching report files for each spec above (same slug, in `docs/reports/`).

**Stays in place:**

- `docs/working/Gregory Calls Redesign.html` — design hand-off, referenced by the new runbook.
- `docs/working/Gregory Clients Redesign.html` — design hand-off, referenced by the new runbook.
- `docs/working/gregory-redesign-compiled.md` — the original compiled spec doc. Stays per its prior treatment.
- `docs/reports/README.md` — directory marker, not a report.
- `docs/specs/claude-md-design-workflow-and-mcp-edit-constraint.md` — this was a held earlier spec that was never executed; its content merged into this wrap-up spec. Delete it as part of cleanup.
- This wrap-up spec itself stays in place until it ships; gets deleted as part of the next EOD batch (not this one).

**Sanity-check before deletion:** Builder lists every shipped pair in the first commit message (acclimatization point c) and Drake confirms before deletion. If any pair Builder finds isn't on the spec's delete-list above OR any pair on the list is missing from disk, surface to Drake — don't silently delete or skip.

## Hard stops

1. **Before deleting any spec/report files.** Builder lists the full delete-set in the acclimatization commit message and waits for Drake's confirmation. The list above is the proposed set; Drake confirms or corrects before deletions land.

2. **If a CLAUDE.md insertion point's surrounding-line text doesn't match exactly.** The spec quotes the preceding/following lines for both insertion points; if Builder's `str_replace` lookup fails, stop and surface — don't guess at a similar position.

3. **If `docs/state.md`'s voice or structure doesn't readily accommodate the new shipped-state entry.** If the file's structure surprises Builder (e.g. uses headers per batch, or has a wildly different format than expected), surface before writing — don't reshape the file unilaterally.

That's the full hard-stop list. Everything else (the new runbook file's exact prose, the state.md entry's exact wording within the established voice, ordering of the deletion commits) is Builder's call.

## Think this through yourself — what could go wrong

- **CLAUDE.md insertion-point ambiguity.** The exact preceding/following lines this spec quotes may have shifted if anything else edited CLAUDE.md in the interim. **Mitigation:** Builder's first commit reports the actual matching surrounding context Builder found before writing, so Drake can spot a divergence.

- **`docs/state.md` voice mismatch.** Different shipped-state entries in `state.md` may use different structures. **Mitigation:** Builder reads at least 2-3 adjacent entries and matches the most recent / most consistent voice. Surface in Surprises if the voice across entries is inconsistent enough that a judgment call is needed.

- **Cleanup deleting too much.** Builder might find shipped specs/reports beyond what's listed (e.g. the calls UI spec from the design hand-off, the clients UI spec from the design hand-off, both shipped today). **Mitigation:** the acclimatization checkpoint requires Builder to enumerate the full set before deleting. Drake confirms.

- **Cleanup deleting too little.** Some spec files might have status still listed as `in-flight` despite the work shipping (a Builder hygiene miss earlier). **Mitigation:** Builder's enumeration surfaces the discrepancy and Drake decides whether to flip + delete or leave.

- **`docs/runbooks/design-handoff.md` structure mismatching siblings.** Existing runbooks have a specific shape. **Mitigation:** Builder reads `docs/runbooks/seed_clients.md` or `docs/runbooks/apply_migrations.md` for the closest convention and matches.

- **Bundling all five updates in one Builder pass leads to a long commit chain.** Per CLAUDE.md's commit policy, multiple commits is fine — but the push at end of task should be a single push. **Mitigation:** Builder commits per logical change (one for CLAUDE.md insertions, one for Current Focus / Next Session Priorities, one for state.md, one for the new runbook, one or more for cleanup deletions), then a single push. Don't bundle unrelated changes into one commit.

- **The deleted spec/report files include the visual verification spec, which has actual procedural value.** **Mitigation:** the procedural content of the visual-verification spec is being captured in the new `docs/runbooks/design-handoff.md` (the preview-auth bypass + the Playwright harness). The spec itself can go because the durable content is preserved in the runbook.

- **`docs/working/Gregory Calls Redesign.html` and `docs/working/Gregory Clients Redesign.html` — committing to keeping them.** These are referenced by the new runbook and serve as the durable visual reference. Builder does NOT delete them as part of this cleanup. The decision to prune them later is Drake's, not Builder's.

## Mandatory doc-update list

- `CLAUDE.md` — edited per § A, B, C.
- `docs/state.md` — new entry per § D.
- `docs/runbooks/design-handoff.md` — NEW file per § E.
- `docs/known-issues.md` — does not need updating.
- `docs/future-ideas.md` — does not need updating.
- `docs/agents/gregory.md` — does not need updating; the Gregory dashboard surface changes don't change the agent's brain or build phases.
- `docs/agents/ella/ella.md` — does not need updating in this spec. The Ella redesign queued for tomorrow will surface updates there.

## Out of scope for this spec (explicit)

- Implementing any of the tomorrow's-queue items (CSM editable, toggles, back-button, Send-to-Slack, action items transfer, Ella redesign). All separate specs.
- Pruning the design hand-off HTML files.
- Restructuring CLAUDE.md, state.md, or runbooks beyond the specific edits called out.
- Deleting the design hand-off HTML files at `docs/working/`.
- Tests — these are doc edits.
