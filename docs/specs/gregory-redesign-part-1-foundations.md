# Gregory Redesign Part 1 — Foundations
**Slug:** gregory-redesign-part-1-foundations
**Status:** in-flight

## Context

Gregory is mid-redesign. The compiled per-page proposal lives at `docs/working/gregory-redesign-compiled.md` and decomposes into Part 1 (cross-cutting standards) and Part 2 (per-page changes). This spec executes **Part 1 only** — the standardization layer that every per-page change in Part 2 will reference.

Today, every detail page (`/clients/[id]`, `/calls/[id]`, `/ella/runs/[id]`) and list page (`/clients`, `/calls`, `/ella/runs`) reinvents its own chrome: each page hand-rolls the eyebrow + serif title pattern, decides where state pills go, decides whether/how to collapse diagnostic JSON dumps, decides how empty sections render. The design tokens (`geg-eyebrow`, `geg-display`, `geg-numeric`, `--color-geg-border-strong`, etc.) already exist in `app/globals.css` — what's missing is a shared set of layout primitives that uses them consistently.

This spec builds those primitives, documents the conventions that pages must follow when composing them, and lands one schema migration (`call_review_sentiment_tier`) that unblocks downstream sentiment-pill work in Part 2. **It does not touch any existing per-page layouts.** Per-page application happens in Part 2 specs.

Reference reads (do them in this order before writing any code):

1. `docs/working/gregory-redesign-compiled.md` — full context for what's being built and why. Part 1 (sections 1.1–1.10) is the scope of this spec.
2. `app/(authenticated)/clients/page.tsx` — canonical example of the current "page rolls its own header" pattern. New primitives must produce header markup that is visually identical to what this page currently renders so that adopting them in Part 2 is a pure refactor, not a redesign.
3. `app/globals.css` — design tokens (search for `geg-` prefix). New primitives consume these; do not invent new tokens.
4. `components/ui/` — existing shadcn/ui primitives. Reuse `Button`, `Badge`, `Separator`, etc. where applicable. Do not duplicate.
5. `docs/schema/calls.md` and `docs/schema/schema-v1.md` (search for `call_review`) — context for the sentiment-tier migration. **No `call_review` table or column exists today.** The compiled doc was written speculatively against future schema. This spec lands the column needed for sentiment-tier surfacing; Haiku-side population happens in a Part 2 spec.

**Acclimatization checkpoint:** before writing any code, confirm in 4–5 bullets in your first commit message or report draft: (a) which `geg-*` design tokens you'll consume, (b) which existing shadcn/ui primitives you'll reuse vs. wrap, (c) the current header pattern at `app/(authenticated)/clients/page.tsx` and your plan to match it byte-for-byte visually, (d) the chosen home for the sentiment-tier column (see § Migration below), (e) any unexpected drift between the compiled doc's Part 1 assumptions and what you find in the codebase. If (e) is non-trivial, surface to Drake before continuing.

## Decisions locked in by Director

These came out of Drake/Director conversation on 2026-05-12. They are not up for re-litigation; build to them.

1. **Slot orders accepted as drafted** in §1.1 (detail pages) and §1.2 (list pages) of the compiled doc.
2. **Documented convention, not enforced slotted component.** No `<GregoryDetail>` shell with named slots. Pages compose primitives in the documented order. Drift is policed by the conventions doc and code review, not by the type system.
3. **Empty-state tiers as drafted** in §1.3: Hide entirely / Stub / Show full structure. Section headers never appear without content underneath unless the empty state itself is actionable.
4. **Collapsed-by-default with per-section expand.** Every collapsed section (Configuration/Details slot, Diagnostics slot, anything else marked collapsible) is user-expandable on demand via a chevron affordance. State is per-section, not page-wide.
5. **Diagnostics collapsed by default for everyone**, including Drake. No role-based default. (Future iteration may add per-user preference; not in scope here.)
6. **Inline-editable contract as drafted** in §1.5: optimistic update with on-blur persistence, inline error tooltip on failure (not toast), no row-level Save button, computed fields don't get the affordance.
7. **Sentiment-tier field on `call_review` data.** Haiku generates it at call-review generation time, dashboard reads from it, `<SentimentPill>` renders from it. **Migration lands in this spec; Haiku population is a Part 2 concern.** See § Migration below for the column home.
8. **No anomaly-code dictionary** — `/ella/runs` is being reworked entirely in Part 2; the speculative A/A'/B/B'/C/D/E dictionary from §1.7 is abandoned.
9. **Header pattern as drafted** in §1.8: eyebrow taxonomy + serif title + state pills + right-aligned actions.
10. **Baseline NFRs as drafted** in §1.9: desktop-first but doesn't fall apart below 1024px, skeleton over spinner, per-section error handling, real `<h1>` semantics, keyboard nav on inline edits, ARIA on pills, redundant-encoding for color signaling, header backlinks, permalink-able sections.
11. **Choke-point primitives first, in this order:** `HeaderBand`, `EmptyStateAwareSection`, `DiagnosticsCollapse`, `InlineEditableActionItemRow`.

## What success looks like

Concrete acceptance criteria. All must be satisfied before flipping status to shipped.

### A. Primitives shipped

1. **`HeaderBand`** at `components/gregory/header-band.tsx` (create the `components/gregory/` folder if it doesn't exist). Props: `eyebrow` (string, e.g. `"CSM · CLIENTS"`), `title` (string or ReactNode for serif title content), `pills` (optional ReactNode for state pills slot), `actions` (optional ReactNode for right-aligned slot), `backlink` (optional `{ href: string; label: string }` for detail-page upward navigation). Renders an `<h1>` for the title (a11y requirement from §1.9). Uses existing `geg-eyebrow` and `geg-display` tokens. Border-bottom matches the existing pattern at `app/(authenticated)/clients/page.tsx`. Responsive baseline: doesn't fall apart below 1024px; single-column reflow below ~900px is acceptable.

2. **`EmptyStateAwareSection`** at `components/gregory/empty-state-aware-section.tsx`. Props: `title` (string, the section header), `mode` (`'hide' | 'stub' | 'show'`), `stubContent` (ReactNode, required when `mode='stub'`), `children` (ReactNode, rendered when `mode='show'`), optional `collapsible` (boolean, default false) and `defaultCollapsed` (boolean, default false). Behavior: `'hide'` returns null entirely (no section header, no content); `'stub'` renders the title plus `stubContent` only; `'show'` renders title + children. When `collapsible`, a chevron toggles the body open/closed; state is local. Per Decision 4, the chevron affordance is present on every collapsible section, page-wide.

3. **`DiagnosticsCollapse`** at `components/gregory/diagnostics-collapse.tsx`. Props: `children` (ReactNode, the diagnostic content). Renders a section with title "Diagnostics" that is collapsed by default for everyone (Decision 5), with a chevron to expand. When expanded, children render below. Intended placement: bottom of detail pages, never above the fold. The component itself doesn't enforce placement — that's a conventions-doc rule — but it should be visually distinct enough (muted border, smaller header, "diagnostics" eyebrow-style label) that misplacement is obvious in code review.

4. **`InlineEditableActionItemRow`** at `components/gregory/inline-editable-action-item-row.tsx`. Props: `actionItem` ({ id, description, status, owner }), `owners` (array of selectable owners), `onSave` (async callback receiving the changed fields), optional `onDelete`. Renders one row with: status toggle (open/done/cancelled), owner dropdown, description text (editable in place — click to edit, blur to save, Escape to cancel, Enter to save). Follows the inline-editable contract from Decision 6: optimistic update, on-blur persist, inline error tooltip with retry on failure (not toast), no row-level Save button, status field's "done" computed-completion timestamp is not editable (computed). Pattern-match the existing optimistic-save plumbing in `app/(authenticated)/clients/editable-cell.tsx` — reuse the hook/utility there if one exists; if not, factor a shared helper into `lib/inline-edit/` (Drake will accept either; flag in Surprises which you chose and why).

5. **`InlineEditableField`** at `components/gregory/inline-editable-field.tsx` — the generic primitive that the action-item row composes for its individual editable cells. Props: `value` (string or null), `onSave` (async callback), optional `type` (`'text' | 'select' | 'pill'`), optional `options` (for `'select'` / `'pill'`), optional `placeholder`, optional `disabled`. Same contract as the action-item row. Surfaces inline error tooltip on failure.

### B. Migration shipped

Land a Supabase migration that adds the field needed for Part 2 sentiment work. **Drake's SQL review is a hard stop before apply** (gate (a) — see § Hard stops below).

**Column home decision:** the compiled doc says "sentiment field on `call_review`," but no `call_review` table or column exists in production today. Two real options:

- **(i)** Add `sentiment_tier text` directly to `calls` with a CHECK constraint on `('green', 'yellow', 'red')` or null. Pro: simple, matches where the `summary` and `transcript` columns already live, no new table. Con: couples sentiment to the `calls` row rather than to the (future) call-review pipeline output, which may be regenerated independently of the call.
- **(ii)** Add `sentiment_tier text` to a new `call_reviews` table (FK to `calls`, one row per review pass) with the same CHECK. Pro: clean separation between raw call + review output; allows re-running reviews without touching `calls`. Con: introduces a table with one column for now, on the bet that more review fields will join it later.

**Director's lean: (i).** Until there's actually a multi-column review pipeline, a single column on `calls` is the lowest-overhead path. If/when the review pipeline grows to need its own table, that's a clean migration later. **Builder confirms (i) is fine in the first commit message OR raises (ii) with concrete reasoning. Don't silently pick (ii).**

Migration filename follows the existing convention: next sequential number, descriptive snake_case. Drake reviews the generated SQL before apply. Post-apply, dual-verify per § Operational patterns in CLAUDE.md.

### C. Conventions doc shipped

Write `docs/gregory-conventions.md`. Contents:

- **Detail-page slot order** (§1.1 of compiled doc), with one paragraph per slot describing what belongs there and what doesn't.
- **List-page slot order** (§1.2 of compiled doc), same treatment.
- **Empty-state rules** (§1.3): the three tiers, when each applies.
- **Diagnostics-collapse rule** (§1.4): always at the bottom of detail pages, collapsed-by-default for everyone, never interleaved.
- **Inline-editable contract** (§1.5): the full Decision 6 contract.
- **Header pattern** (§1.8): eyebrow taxonomy (table of `SURFACE · CONTEXT` for each surface — fill in `CSM · CLIENTS`, `CLIENT · DETAIL`, `CSM · CALLS`, `CALL · DETAIL`, `ELLA · AUDIT`, `ELLA · RUN`), serif-title treatment, pill placement.
- **Primitive index**: short table mapping each primitive's name to its file path and the slot it lives in.
- **Baseline NFRs** (§1.9): the six items, one short paragraph each.

This doc is what every Part 2 spec will reference. Keep it terse — Builder is reading it blind in a fresh session weeks from now. Prose, not philosophy.

### D. No per-page layout changes

This is foundation only. **Do not edit `app/(authenticated)/clients/page.tsx`, `app/(authenticated)/calls/page.tsx`, or any existing page layout to consume the new primitives.** Part 2 specs do that, one page at a time. If you find yourself wanting to migrate a page "while you're in there," stop — that's a Part 2 spec, not this one.

### E. Tests

- Unit tests for each primitive covering: render correctness, empty/stub/show modes for `EmptyStateAwareSection`, expand/collapse behavior for `DiagnosticsCollapse` and collapsible `EmptyStateAwareSection`, the optimistic-save + revert-on-failure path for `InlineEditableField` and `InlineEditableActionItemRow`.
- Use the existing test infrastructure (search `package.json` and any existing component test for the conventions — Jest + React Testing Library is the likely stack; match what's already there).
- Don't ship if tests fail.

## Hard stops

1. **Before applying the migration.** Generate the SQL file, surface it to Drake for review, wait for explicit approval, then apply via `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes` per the operational pattern in CLAUDE.md. Dual-verify post-apply (schema reality + ledger registration).
2. **If the (i) vs (ii) migration decision changes from Director's lean** — i.e. if Builder concludes (ii) is the right call for reasons that show up in the codebase — stop and surface before writing the migration SQL. Don't silently switch.
3. **If acclimatization point (e) surfaces non-trivial drift** between the compiled doc and the codebase — e.g. design tokens have been renamed, the shadcn primitives don't match what the doc assumes, the existing inline-edit pattern at `editable-cell.tsx` is fundamentally different from what the compiled doc imagines — stop and surface before continuing past the primitives' first commit.

## Think this through yourself — what could go wrong

- The `geg-*` design tokens in `globals.css` are extensive but undocumented in any conventions doc. If the new primitives consume a token that gets renamed in a future redesign pass, every primitive breaks. **Mitigation:** in the conventions doc's Primitive Index, list which tokens each primitive consumes so the rename impact is visible upfront.
- The existing `app/(authenticated)/clients/page.tsx` renders its header inline with hardcoded `style={{ fontSize: 52, lineHeight: '54px' }}` on the `geg-display` element. If `HeaderBand` doesn't reproduce this exactly, Part 2's "migrate clients page to HeaderBand" diff will be a visual regression rather than a pure refactor. **Mitigation:** match byte-for-byte. If the inline style is doing something the token doesn't capture, capture it in the primitive's CSS or a prop with a sensible default.
- `EmptyStateAwareSection` with `mode='hide'` returning null means a misconfigured page can silently drop sections. **Mitigation:** the conventions doc should be explicit that `mode` is chosen at composition time based on the data present, not toggled defensively. A page that renders `<EmptyStateAwareSection mode={data.length > 0 ? 'show' : 'hide'} ...>` is correct; a page that renders `