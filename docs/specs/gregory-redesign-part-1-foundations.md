# Gregory Redesign Part 1 — Foundations
**Slug:** gregory-redesign-part-1-foundations
**Status:** in-flight

## Context

Gregory is mid-redesign. The compiled per-page proposal lives at `docs/working/gregory-redesign-compiled.md` and decomposes into Part 1 (cross-cutting standards) and Part 2 (per-page changes). This spec executes **Part 1 only** — the standardization layer that every per-page change in Part 2 will reference.

Today, every detail page (`/clients/[id]`, `/calls/[id]`, `/ella/runs/[id]`) and list page (`/clients`, `/calls`, `/ella/runs`) reinvents its own chrome: each page hand-rolls the eyebrow + serif title pattern, decides where state pills go, decides whether/how to collapse diagnostic JSON dumps, decides how empty sections render. The design tokens (`geg-eyebrow`, `geg-display`, `geg-numeric`, `--color-geg-border-strong`, etc.) already exist in `app/globals.css` — what's missing is a shared set of layout primitives that uses them consistently.

This spec builds those primitives and documents the conventions that pages must follow when composing them. **It does not touch any existing per-page layouts and lands no schema migration.** Per-page application happens in Part 2 specs.

Reference reads (do them in this order before writing any code):

1. `docs/working/gregory-redesign-compiled.md` — full context. Part 1 (sections 1.1–1.10) is the scope of this spec.
2. `app/(authenticated)/clients/page.tsx` — canonical example of the current "page rolls its own header" pattern. New primitives must produce header markup visually identical to what this page currently renders so adopting them in Part 2 is a pure refactor.
3. `app/globals.css` — design tokens (search for `geg-` prefix). New primitives consume these; do not invent new tokens.
4. `components/ui/` — existing shadcn/ui primitives. Reuse `Button`, `Badge`, `Separator`, etc. where applicable. Do not duplicate.
5. `app/(authenticated)/clients/editable-cell.tsx` — existing inline-edit pattern. The new generic primitive should pattern-match this (reuse the hook if one exists; factor a shared helper into `lib/inline-edit/` if not). Drake will accept either; flag your choice in Surprises.

**Acclimatization checkpoint:** before writing any code, confirm in 4–5 bullets in your first commit message: (a) which `geg-*` design tokens you'll consume, (b) which existing shadcn/ui primitives you'll reuse vs. wrap, (c) your plan to match `app/(authenticated)/clients/page.tsx`'s header markup byte-for-byte visually, (d) whether you're reusing the existing inline-edit hook from `editable-cell.tsx` or factoring a shared helper, (e) any unexpected drift between the compiled doc's Part 1 assumptions and what you find in the codebase. If (e) is non-trivial, surface to Drake before continuing.

## Decisions locked in by Director

These came out of Drake/Director conversation on 2026-05-12. They are not up for re-litigation; build to them.

1. **Slot orders accepted as drafted** in §1.1 (detail pages) and §1.2 (list pages) of the compiled doc.
2. **Documented convention, not enforced slotted component.** No `<GregoryDetail>` shell with named slots. Pages compose primitives in the documented order. Drift is policed by the conventions doc and code review, not by the type system.
3. **Empty-state tiers as drafted** in §1.3: Hide entirely / Stub / Show full structure. Section headers never appear without content underneath unless the empty state itself is actionable.
4. **Collapsed-by-default with per-section expand.** Every collapsed section (Configuration/Details slot, Diagnostics slot, anything else marked collapsible) is user-expandable on demand via a chevron affordance. State is per-section, not page-wide.
5. **Diagnostics collapsed by default for everyone**, including Drake. No role-based default.
6. **Inline-editable contract as drafted** in §1.5: optimistic update with on-blur persistence, inline error tooltip on failure (not toast), no row-level Save button, computed fields don't get the affordance.
7. **Sentiment-tier lives in `documents.metadata.sentiment_tier`** for `call_summary` rows. No new table, no new column, no migration. The field is for visual rendering only — never filtered or queried at scale. Haiku populates it at call-summary generation time (Part 2 work). The dashboard reads it and `<SentimentPill>` renders from it.
8. **No anomaly-code dictionary** — `/ella/runs` is being reworked entirely in Part 2; the speculative A/A'/B/B'/C/D/E dictionary from §1.7 is abandoned.
9. **Header pattern as drafted** in §1.8: eyebrow taxonomy + serif title + state pills + right-aligned actions.
10. **Baseline NFRs as drafted** in §1.9: desktop-first but doesn't fall apart below 1024px, skeleton over spinner, per-section error handling, real `<h1>` semantics, keyboard nav on inline edits, ARIA on pills, redundant-encoding for color signaling, header backlinks, permalink-able sections.
11. **Choke-point primitives first, in this order:** `HeaderBand`, `EmptyStateAwareSection`, `DiagnosticsCollapse`, `InlineEditableActionItemRow`.

## What success looks like

Concrete acceptance criteria. All must be satisfied before flipping status to shipped.

### A. Primitives shipped

Create new folder `components/gregory/` for these primitives.

1. **`HeaderBand`** at `components/gregory/header-band.tsx`. Props: `eyebrow` (string, e.g. `"CSM · CLIENTS"`), `title` (string or ReactNode for serif title content), `pills` (optional ReactNode for state pills slot), `actions` (optional ReactNode for right-aligned slot), `backlink` (optional `{ href: string; label: string }` for detail-page upward navigation). Renders an `<h1>` for the title (a11y requirement from §1.9). Uses existing `geg-eyebrow` and `geg-display` tokens. Border-bottom matches the existing pattern at `app/(authenticated)/clients/page.tsx`. Responsive baseline: doesn't fall apart below 1024px; single-column reflow below ~900px is acceptable.

   **Visual parity requirement.** `app/(authenticated)/clients/page.tsx` currently renders its header with hardcoded `style={{ fontSize: 52, lineHeight: '54px', marginTop: 8 }}` on the `geg-display` element, a 24px bottom padding, and `border-bottom: 1px solid var(--color-geg-border-strong)`. `HeaderBand` must reproduce this exactly so the Part 2 migration of that page is a pure refactor with zero visible diff. If the inline style captures something the token system doesn't, capture it in `HeaderBand`'s default rendering — don't expose it as a prop the page has to remember to set.

2. **`EmptyStateAwareSection`** at `components/gregory/empty-state-aware-section.tsx`. Props: `title` (string, the section header), `mode` (`'hide' | 'stub' | 'show'`), `stubContent` (ReactNode, required when `mode='stub'`), `children` (ReactNode, rendered when `mode='show'`), optional `collapsible` (boolean, default false) and `defaultCollapsed` (boolean, default false). Behavior: `'hide'` returns null entirely (no section header, no content); `'stub'` renders the title plus `stubContent` only; `'show'` renders title + children. When `collapsible`, a chevron toggles the body open/closed; state is local to the section.

3. **`DiagnosticsCollapse`** at `components/gregory/diagnostics-collapse.tsx`. Props: `children` (ReactNode, the diagnostic content). Renders a section titled "Diagnostics," collapsed by default for everyone (Decision 5), with a chevron to expand. When expanded, children render below. Intended placement: bottom of detail pages, never above the fold. The component itself doesn't enforce placement — that's a conventions-doc rule — but it should be visually distinct enough (muted border, smaller header, "diagnostics" eyebrow-style label) that misplacement is obvious in code review.

4. **`InlineEditableField`** at `components/gregory/inline-editable-field.tsx` — generic primitive for editable cells. Props: `value` (string or null), `onSave` (async callback returning success/failure), optional `type` (`'text' | 'select' | 'pill'`, default `'text'`), optional `options` (for `'select'` / `'pill'`), optional `placeholder`, optional `disabled`. Contract per Decision 6: optimistic update on edit, persist on blur, inline error tooltip on save failure (not toast), revert to last-known-good value on failure, no Save button, Escape cancels, Enter commits. Keyboard nav per §1.9: tab moves between editable fields, Enter commits + advances, Escape reverts.

5. **`InlineEditableActionItemRow`** at `components/gregory/inline-editable-action-item-row.tsx`. Props: `actionItem` ({ id, description, status, owner }), `owners` (array of selectable owners), `onSave` (async callback receiving the changed fields), optional `onDelete`. Composes `InlineEditableField` for the description (text), owner (select), and status (pill: `open` / `done` / `cancelled`). Same inline-edit contract. Computed-completion timestamp is not editable (computed field).

6. **`SentimentPill`** at `components/gregory/sentiment-pill.tsx`. Props: `tier` (`'green' | 'yellow' | 'red'` or null/undefined). Renders a small colored pill with the tier name. When `tier` is null/undefined, renders nothing (no placeholder). Used by Part 2 work on `/calls`, `/calls/[id]`, `/clients/[id]` recent-calls list to surface sentiment derived from `documents.metadata.sentiment_tier` on the call's `call_summary` document. Per §1.9, color must be redundantly encoded — the pill carries a text label, not just a color. Built in this spec because it's a tiny primitive and Part 2 specs will need it ready.

### B. Conventions doc shipped

Write `docs/gregory-conventions.md`. Contents:

- **Detail-page slot order** (§1.1 of compiled doc), with one paragraph per slot describing what belongs there and what doesn't.
- **List-page slot order** (§1.2 of compiled doc), same treatment.
- **Empty-state rules** (§1.3): the three tiers, when each applies.
- **Diagnostics-collapse rule** (§1.4): always at the bottom of detail pages, collapsed-by-default for everyone, never interleaved.
- **Inline-editable contract** (§1.5): the full Decision 6 contract.
- **Header pattern** (§1.8): eyebrow taxonomy table — fill in `CSM · CLIENTS`, `CLIENT · DETAIL`, `CSM · CALLS`, `CALL · DETAIL`, `ELLA · AUDIT`, `ELLA · RUN`. Serif-title treatment, pill placement.
- **Sentiment data flow:** one short paragraph noting that sentiment lives in `documents.metadata.sentiment_tier` for `call_summary` rows, is populated by Haiku at review-generation time (Part 2 work), and is consumed by `<SentimentPill>`. For visuals only — not filtered/queried.
- **Primitive index:** short table mapping each primitive's name to its file path, the slot it lives in, and which `geg-*` design tokens it consumes (so future token renames have visible impact).
- **Baseline NFRs** (§1.9): the six items, one short paragraph each.

This doc is what every Part 2 spec will reference. Keep it terse — Builder reads it blind in a fresh session weeks from now. Prose, not philosophy.

### C. No per-page layout changes

This is foundation only. **Do not edit `app/(authenticated)/clients/page.tsx`, `app/(authenticated)/calls/page.tsx`, or any existing page layout to consume the new primitives.** Part 2 specs do that, one page at a time. If you find yourself wanting to migrate a page "while you're in there," stop — that's a Part 2 spec, not this one.

### D. Tests

- Unit tests for each primitive covering: render correctness, empty/stub/show modes for `EmptyStateAwareSection`, expand/collapse behavior for `DiagnosticsCollapse` and collapsible `EmptyStateAwareSection`, the optimistic-save + revert-on-failure path for `InlineEditableField` and `InlineEditableActionItemRow`, the null-tier render-nothing behavior for `SentimentPill`.
- Use the existing test infrastructure (check `package.json` and any existing component test for conventions — match what's already there).
- Don't ship if tests fail.

### E. Branch + PR workflow

This spec is foundation work touching live surfaces, so it does **not** push to `main` directly per CLAUDE.md's normal Builder push policy. Instead:

1. Create branch `gregory-redesign-part-1-foundations` from latest `origin/main`.
2. All commits land on that branch (primitives, tests, conventions doc, report).
3. Push the branch to `origin`.
4. Open a PR against `main` titled `Gregory redesign Part 1 — foundations`. Body should be the report's "What I did, in plain English" section, plus a link to this spec and to `docs/reports/gregory-redesign-part-1-foundations.md`. List the files touched grouped by category (primitives / conventions doc / tests).
5. Do NOT merge. Drake reviews the deploy preview and merges manually.

The report (`docs/reports/gregory-redesign-part-1-foundations.md`) lands on the same branch as the rest of the work; it'll merge to main as part of the PR.

## Hard stops

1. **If acclimatization point (e) surfaces non-trivial drift** between the compiled doc and the codebase — e.g. design tokens have been renamed, the shadcn primitives don't match what the doc assumes, the existing inline-edit pattern at `editable-cell.tsx` is fundamentally different from what Decision 6 describes — stop and surface before continuing past the primitives' first commit.

2. **If a primitive's visual rendering doesn't match `app/(authenticated)/clients/page.tsx`'s current header byte-for-byte** and the gap requires a design call (not just a CSS tweak), stop and surface. Part 2's migration is a refactor; a visual-regression diff is a sign Part 1 isn't done yet.

That's the full hard-stop list. No migrations in this spec means no SQL-review gate. Routine commits, primitive design choices within the contract, test scaffolding choices, and the inline-edit-helper question (reuse vs. factor) are all Builder's call — note them in Surprises if non-obvious.

## Think this through yourself — what could go wrong

- The `geg-*` design tokens in `globals.css` are extensive but undocumented elsewhere. If a primitive consumes a token that gets renamed later, every primitive breaks silently until the page renders. **Mitigation:** the conventions doc's Primitive Index lists which tokens each primitive consumes, so rename impact is visible upfront. Builder maintains this list as it builds.

- `EmptyStateAwareSection` with `mode='hide'` returning null means a misconfigured page can silently drop sections. **Mitigation:** the conventions doc must be explicit that `mode` is chosen at composition time based on data presence, not toggled defensively. A page that renders `<EmptyStateAwareSection mode={data.length > 0 ? 'show' : 'hide'} ...>` is correct; a page that passes `mode='hide'` with non-empty children is a bug — flag it in code review.

- The existing inline-edit pattern at `app/(authenticated)/clients/editable-cell.tsx` may not exactly match Decision 6's contract (e.g. it might toast on error rather than inline-tooltip). If it doesn't match, the new `InlineEditableField` has to diverge from the existing pattern, which means two patterns coexist in the codebase until Part 2 migrates the clients list. **Mitigation:** flag the divergence in Surprises and update the conventions doc to say which pattern is canonical going forward (the new one). Don't refactor `editable-cell.tsx` in this spec — that's Part 2 territory.

- `DiagnosticsCollapse` being collapsed-by-default for everyone (Decision 5) means Drake's own debugging workflow gets one extra click per detail-page visit. **Mitigation:** none — Drake explicitly accepted this in the decision. Don't preemptively add a role check or feature flag. Future per-user preference work would be a separate spec.

- `SentimentPill` rendering nothing on null is the right behavior, but a page that forgets to handle the loading state can render the pill slot as a layout gap that pops in when data arrives. **Mitigation:** none at the primitive level — handle in Part 2 pages with skeleton states per §1.9 baseline NFRs.

- Branch-and-PR instead of push-to-main is a one-off override of CLAUDE.md's normal push policy. **Mitigation:** the override is explicit in § E above. Don't generalize it to other specs without an explicit Drake/Director conversation — `main` push remains the default for everything else.

## Mandatory doc-update list

End-of-work, update these docs explicitly. For each, either commit the change or state in the report that the doc didn't need updating and why.

- `docs/gregory-conventions.md` — NEW, created by this spec (§ B).
- `CLAUDE.md` — does not need updating. Working norms didn't change. The branch-and-PR override for this spec is a one-off captured in this spec's § E, not a permanent norm.
- `docs/state.md` — does not need updating. No batch shipped; foundation work that unblocks Part 2 is in-flight context, not a state snapshot.
- `docs/agents/gregory.md` — does not need updating in this spec. The primitives are surface-area for the dashboard, not for Gregory-the-agent's brain. Part 2 specs may update this when per-page changes land.
- `docs/known-issues.md` — only if something surfaces during build. State explicitly in the report whether anything was added.
- `docs/working/gregory-redesign-compiled.md` — does not need updating. It's the source-of-truth input to Part 1 + Part 2 specs; preserved as-is.

## Out of scope for this spec (explicit)

- Any edits to existing per-page layouts (`/clients`, `/clients/[id]`, `/calls`, `/calls/[id]`, `/ella/runs`, `/ella/runs/[id]`). Part 2 specs.
- Haiku-side population of `documents.metadata.sentiment_tier`. Part 2 spec, gated on the call-summary generation pipeline.
- The `/ella` Nabeel-facing dashboard (§2.6 of compiled doc). Deferred entirely; revisit in Part 2 scoping.
- `SavedViews`, `TodayDigest`, `RowHoverPreview`, `VirtualizedTable`, `DateRangePicker`, `SortableColumnHeader`, `FilterChipRow`, `CSMAvatarOrLabel`, `SeverityNarrativeCard`, `SentimentArc`, `ChatBubble`, `DecisionPill`, `AnomalyCodeLabel`, `HealthScoreBreakdown`, `NeedsReviewIndicator`, `QuoteToTimestampLink` — all listed in §1.10 of the compiled doc as either decoupled work or page-specific primitives. They land in Part 2 specs as the pages that need them get specced.
- Any schema migration. Decision 7's sentiment field lives in existing `documents.metadata`, no new column.
