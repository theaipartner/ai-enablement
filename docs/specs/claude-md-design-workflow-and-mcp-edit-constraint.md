# CLAUDE.md updates — design workflow + MCP-edit constraint
**Slug:** claude-md-design-workflow-and-mcp-edit-constraint
**Status:** in-flight

## Context

Two working-norms additions to capture in CLAUDE.md:

1. **The design workflow** that emerged during the Gregory redesign — Drake / Director chat-ideation, prompt to Claude Design, Design produces annotated HTML mocks committed to the repo, mocks hand off to Code via a UI spec. Worked well across both the Calls and Clients redesigns. Should be a documented norm so future Director sessions reach for it on visual work rather than reinventing or trying to spec design from chat alone.

2. **The MCP-edit constraint.** Director writes via GitHub MCP, which only supports full-file overwrites — there's no patch/diff capability. Editing a standing doc means rewriting it in full, which is slow and error-prone (a stale paragraph elsewhere in the doc can leak into the rewrite). The existing rule "Director writes specs only, every other doc change rides in a spec Builder executes" exists partly because of this — but the *reason* isn't documented in CLAUDE.md, which makes the rule feel arbitrary. Capturing the why prevents future Directors from drifting back into direct doc edits when the rule starts to feel cumbersome.

Both are small additions, no behavior change beyond making implicit norms explicit.

## Reference reads (in this order)

1. `CLAUDE.md` — § Working Norms / Drake / Director / Builder, § Director / Builder System / Director behavior, § Things Director can update without asking. These are the three sections this spec amends.

**Acclimatization checkpoint:** before writing any code, confirm in 2–3 bullets in your first commit message: (a) the three sections you'll touch and the exact insertion points, (b) that no other section content drifts in the rewrite, (c) any unexpected drift between this spec and what you find in the file.

## Decisions locked in by Director

From Drake/Director conversation 2026-05-13. Build to these.

1. **Design workflow goes in § Drake / Director / Builder** as a new sub-paragraph under the existing description of how the three agents interact. Position: after the current paragraph defining Builder's role, before § Communication preferences.

2. **MCP-edit constraint goes in § Director behavior** as a clarifying paragraph appended to the existing "Director's own commits" paragraph. Explains the *why* behind the specs-only rule.

3. **Tone of additions matches the existing CLAUDE.md voice** — declarative, no hedging, no fluff. Match the surrounding paragraphs' density.

## What success looks like

### A. Design workflow paragraph

Insert this paragraph in § Working Norms / § Drake / Director / Builder, after the paragraph describing Builder and before § Communication preferences. Exact insertion point: between the line ending `Drake's role at runtime is the four gates...` and the section heading `### Communication preferences`.

```
**Design workflow for visual work.** When work is primarily visual (page redesigns, new UI surfaces, layout changes that need design judgment more than code execution), the workflow is three-stage: Drake and Director ideate the visual direction in chat, Director writes a Design-facing prompt that Drake hands to Claude Design (a separate claude.ai session with the GitHub MCP connector authorized for this repo), Design produces annotated single-file HTML mocks and commits them to the repo at `docs/working/<surface> Redesign.html`. Director then reads the mocks and writes a UI spec for Builder that references the mocks by path, the existing primitives at `components/gregory/*`, and the data fields available. Builder implements against the spec, visually verifies via Playwright on the deploy preview, and reports. The split keeps each agent in its specialty: Design designs, Code codes, Director sequences. Used end-to-end on the Gregory Calls + Clients redesigns; default to this pattern for future visual work rather than trying to spec design from chat alone or trying to have Code generate design.
```

### B. MCP-edit constraint paragraph

Append this paragraph to § Director / Builder System / § Director behavior. Exact insertion point: immediately after the existing "**Director's own commits.**" paragraph (the one ending `Director does NOT use GitHub MCP to commit code or Builder's reports.`).

```
**Why specs-only — the MCP-edit constraint.** The GitHub MCP connector Director uses for writes (`create_or_update_file`, `push_files`) only supports full-file overwrites — there's no patch / diff capability. Editing a standing doc means rewriting the whole file from chat memory, which is slow (a 500-line CLAUDE.md takes a full response turn to regenerate cleanly) and error-prone (any unrelated paragraph the Director didn't intend to change can drift in the rewrite). New files (specs at `docs/specs/<slug>.md`) are cheap to write because there's nothing to preserve. Standing-doc edits are expensive and risky. That's why the rule is "Director writes new specs, every other doc change rides in a spec Builder executes" — Builder has `str_replace` and can edit precisely. The rule is mechanical, not stylistic; don't drift back to direct edits when the spec-cost feels heavy.
```

### C. § Things Director can update without asking — no change needed

The existing line `That's the entire list.` plus the surrounding context already enforces the rule. The new paragraph in § B above explains the why; the existing rule wording stays as-is.

## Hard stops

None. Pure doc edit, no risk of breaking anything functional. Builder edits CLAUDE.md, runs no tests (there are no tests for prose), commits + pushes.

## Think this through yourself — what could go wrong

- **Surrounding paragraph drift.** The biggest risk in any Director-driven CLAUDE.md edit is collateral changes — a paragraph elsewhere in the doc that Director didn't mean to touch gets rewritten subtly differently. **Mitigation:** Builder uses `str_replace` for both insertions (find the exact preceding line, insert the new paragraph after it, leave everything else byte-identical). Don't rewrite the file.

- **Insertion-point ambiguity.** If the exact preceding line Builder is looking for has been edited since this spec was drafted (concurrent work, etc.), the `str_replace` will fail. **Mitigation:** if the insertion-point line doesn't match exactly, stop and surface — don't guess at a similar position.

- **Paragraph voice drift.** The new paragraphs may sound off relative to the surrounding voice. **Mitigation:** read the surrounding paragraphs and adjust. Director's voice is declarative, density-matched, no hedging. The drafts above are in that voice.

## Mandatory doc-update list

- `CLAUDE.md` — the file this spec edits. Two paragraph insertions per § A and § B above.
- `docs/state.md` — does not need updating.
- `docs/known-issues.md` — does not need updating.
- `docs/future-ideas.md` — does not need updating.

## Out of scope for this spec (explicit)

- Anything beyond the two paragraph insertions.
- Restructuring CLAUDE.md.
- Renaming any sections.
- Editing § Things Director can update without asking (the existing wording stands).
