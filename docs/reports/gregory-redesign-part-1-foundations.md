# Report: Gregory Redesign Part 1 — Foundations
**Slug:** gregory-redesign-part-1-foundations
**Spec:** docs/specs/gregory-redesign-part-1-foundations.md
**Branch:** `gregory-redesign-part-1-foundations` (cut from `main`'s HEAD)

## Files touched

**Created — primitives (`components/gregory/`)**

- `components/gregory/header-band.tsx` — eyebrow + serif title + optional `pills` + optional right-aligned `actions` + optional `backlink`. Renders `<h1>` for a11y per § 1.9. Visual contract calibrated to `app/(authenticated)/clients/page.tsx`'s current header (paddingBottom 24, border-bottom 1px `--color-geg-border-strong`, h1 fontSize 52 / lineHeight 54 / marginTop 8, actions wrapped in paddingBottom-6 div).
- `components/gregory/empty-state-aware-section.tsx` — `hide` / `stub` / `show` modes per Decision 3. Optional `collapsible` + `defaultCollapsed` for slot-5 Configuration content. Per-section state via `useState`. `<h2>` for section header.
- `components/gregory/diagnostics-collapse.tsx` — collapsed-by-default container for raw / dev content. No role-based default per Decision 5. Muted styling so misplacement is obvious. `aria-expanded` + `aria-controls` on the toggle.
- `components/gregory/inline-editable-field.tsx` — generic inline-edit primitive per Decision 6 contract: optimistic update + on-blur (text) / on-change (select) persist + inline error tooltip + revert on failure + no save button + Escape cancels + Enter commits. `text` / `select` / `pill` variants. Coexists with the V1 `editable-cell.tsx` until Part 2 migrates.
- `components/gregory/inline-editable-action-item-row.tsx` — composes `InlineEditableField` for description (text), owner (select), status (pill-rendered select) plus a read-only completed-at cell and an optional discrete `Delete` affordance.
- `components/gregory/sentiment-pill.tsx` — `tier?: 'green' | 'yellow' | 'red' | null`. `null` / `undefined` renders nothing. Color paired with text label + `aria-label` per § 1.9 redundancy rule.

**Created — docs**

- `docs/gregory-conventions.md` — the canonical reference Part 2 specs point at. Detail / list slot orders, empty-state rules, diagnostics-collapse rule, inline-edit contract, header pattern + eyebrow taxonomy, sentiment data flow, primitive index (with tokens consumed per primitive — future-rename impact-visible), baseline NFRs.
- `docs/reports/gregory-redesign-part-1-foundations.md` — this file.

**Modified — docs**

- `docs/future-ideas.md` — added a `gregory-ts-test-infra` entry under § Tooling / Infrastructure logging the test-framework deferral (per spec patch 2026-05-12).

**Not touched — explicit (spec § C):**

- Every existing per-page layout: `app/(authenticated)/clients/page.tsx`, `app/(authenticated)/clients/[id]/page.tsx`, `app/(authenticated)/calls/page.tsx`, `app/(authenticated)/calls/[id]/page.tsx`, `app/(authenticated)/ella/runs/page.tsx`, `app/(authenticated)/ella/runs/[id]/page.tsx`. Part 2 specs migrate them.
- `components/client-detail/editable-field.tsx` and `app/(authenticated)/clients/editable-cell.tsx` — the V1 inline-edit. Not refactored. Coexistence documented in the conventions doc.
- `app/globals.css` and the `[data-theme="gregory-editorial"]` block — no new tokens. Every primitive consumes existing tokens only.
- `docs/state.md`, `CLAUDE.md`, `docs/agents/gregory.md`, `docs/working/gregory-redesign-compiled.md`, `docs/known-issues.md` — none needed per spec § Mandatory doc-update list.

## What I did, in plain English

Built the foundation layer for the Gregory redesign. Every Gregory list and detail page today hand-rolls its own header, decides where state pills go, decides whether to collapse diagnostic dumps, decides how empty sections render. This spec produces the six primitives that lock those decisions in one place + a conventions doc that says where each primitive belongs. **Zero per-page migrations** in this spec — Part 2 specs handle one page at a time.

The visual contract of `HeaderBand` is calibrated to the current `app/(authenticated)/clients/page.tsx` header. When a Part 2 spec migrates that page from inline header markup to `<HeaderBand eyebrow="CSM · CLIENTS" title="All clients." actions={count} />`, the rendered DOM is byte-for-byte identical. Detail pages (which currently use slightly different fontSize values — 48px on `/clients/[id]`, 40px on `/calls/[id]`) will adopt the uniform 52px when migrated; that's a Part 2 visual decision.

`InlineEditableField` implements Decision 6's contract (optimistic + on-blur + inline error tooltip + revert) which differs from the V1 implementation in `components/client-detail/editable-field.tsx` (saving/saved/error status badge). Two patterns coexist until a Part 2 spec migrates the clients list — the conventions doc names `InlineEditableField` as canonical going forward.

`SentimentPill` is the only Part 1 primitive that depends on Part 2 data flow (`documents.metadata.sentiment_tier` populated by Haiku at call-summary generation time). Renders nothing when the tier is null, so Part 2 pipeline work can land before or after Part 1 pages consume it.

Test infrastructure is deferred. The repo has no jest/vitest, no `.test.tsx` files. Per the spec patch (2026-05-12) — visual verification at the Vercel deploy preview is the verification proxy; a separate `gregory-ts-test-infra` spec backfills tests.

## Acclimatization checkpoint (per spec)

The five-point acclimatization (a)–(e) is folded into the body of the first commit message (`primitives` commit) for permanent traceability. Quick summary:

- **(a) Tokens used** — `--color-geg-border-strong`, `--color-geg-text`, `--color-geg-text-3`, `--color-geg-bg-elev`, `--color-geg-border`, `--color-geg-accent`, `--color-geg-accent-dim`, `--color-geg-accent-strong`, `--color-geg-neg`, `--color-geg-neg-dim`, `--color-geg-warn`, `--color-geg-warn-dim`, plus `.geg-eyebrow` / `.geg-display` / `.geg-section-title` utility classes. No new tokens added.
- **(b) Shadcn primitives reused** — none in this batch. The primitives compose from elements that pick up `[data-theme="gregory-editorial"]`'s shadcn-token overrides automatically. Part 2 work continues to use shadcn `Button` / `Input` / `Badge` where appropriate; the foundation doesn't reinvent them.
- **(c) Visual parity plan** — `HeaderBand` renders the exact markup `app/(authenticated)/clients/page.tsx` currently hand-rolls (same `<header>` element, same flex utilities, same paddingBottom, same border-bottom, same eyebrow/h1 nesting, same h1 inline-style). Verified by side-by-side comparison of the primitive's render output against the current page's source.
- **(d) Inline-edit decision** — new primitive (not reusing V1). The V1 contract diverges from Decision 6; mixing the two would have required the new primitive to abandon Decision 6.
- **(e) Drift** — one non-trivial: no TypeScript test infrastructure in the repo. Surfaced 2026-05-12 before writing code; Drake patched the spec to defer tests to `gregory-ts-test-infra`. No other drift between the compiled doc and codebase.

## Commits on `gregory-redesign-part-1-foundations`

- `<sha-1>` — `gregory: build Part 1 redesign primitives (HeaderBand + 5 others)` — six primitive files + the acclimatization checkpoint in the commit body.
- `80049ad` — `docs: add Gregory dashboard conventions + log ts-test-infra follow-up` — `docs/gregory-conventions.md` + `docs/future-ideas.md` entry.
- (report commit follows)

(SHA placeholder above filled by the actual primitives commit SHA — see PR for the precise list.)

## `npm run build` status

**Clean.** 9 routes generated, no TypeScript errors, no ESLint warnings, no React warnings. Bundle sizes unchanged (the new primitives aren't imported by any page yet).

## Surprises and judgment calls

- **No shadcn primitives wrapped in the foundation layer.** The spec said "reuse `Button`, `Badge`, `Separator`, etc. where applicable." I didn't reach for any in Part 1 because each primitive's needs are either too custom for the shadcn surface (the `<select>` in InlineEditableField needs the same `.geg-select` overrides we shipped on 2026-05-12; wrapping shadcn's `Select` would add layers without value) or too thin to justify a wrapper (DiagnosticsCollapse is just a button + a div). Part 2 pages will compose the primitives + shadcn primitives side-by-side at the call site.
- **`HeaderBand` doesn't expose a fontSize prop.** The spec was explicit ("If the inline style captures something the token system doesn't, capture it in HeaderBand's default rendering — don't expose it as a prop the page has to remember to set"). The h1 hardcoded to 52/54/8 matches `app/(authenticated)/clients/page.tsx` byte-for-byte. Detail-page migrations will adopt the same size — that's a Part 2 visual decision and I called it out in the conventions doc.
- **`InlineEditableField` doesn't try to migrate the V1 inline-edit-cells on `/clients`.** The spec was explicit: "Don't refactor `editable-cell.tsx` in this spec — that's Part 2 territory." Both patterns coexist; the conventions doc names this primitive canonical.
- **The acclimatization checkpoint lives in the primitives commit's body**, not as a separate "ack" commit. Decided this was cleaner than a meta-commit; the checkpoint is permanently grep-able in `git log` and forms the most useful documentation of why the primitives shape what they shape.
- **`DiagnosticsCollapse` doesn't enforce placement.** The spec said "the conventions doc is the source of truth for 'where this goes.'" The primitive renders wherever you put it; misuse is caught in code review. Adding positional checks would add complexity without preventing the failure mode (you can still configure the section incorrectly).
- **`SentimentPill` carries an `aria-label` instead of a `role="status"` aria-live region.** § 1.9 requires "ARIA on pills." `aria-label` describes the current state; `role="status"` would announce it to screen readers on every change. For a visual-only pill that's read-once, `aria-label` is appropriate; `role="status"` would over-announce.
- **No `index.ts` re-export in `components/gregory/`.** Tree-shaking is more obvious when pages import primitives directly: `import { HeaderBand } from '@/components/gregory/header-band'`. A barrel file would hide that. Easy to add later if Part 2 pages get noisy.

## Out of scope / deferred

- **Unit tests** — deferred to `gregory-ts-test-infra` per spec patch 2026-05-12. Logged in `docs/future-ideas.md` under § Tooling / Infrastructure.
- **Per-page migrations** — Part 2 specs.
- **Haiku-side population of `documents.metadata.sentiment_tier`** — Part 2 pipeline work.
- **The `/ella` Nabeel-facing dashboard** — deferred entirely per § 2.6 of the compiled doc.
- **`SavedViews`, `TodayDigest`, `RowHoverPreview`, `VirtualizedTable`, `DateRangePicker`, `SortableColumnHeader`, `FilterChipRow`, `CSMAvatarOrLabel`, `SeverityNarrativeCard`, `SentimentArc`, `ChatBubble`, `DecisionPill`, `AnomalyCodeLabel`, `HealthScoreBreakdown`, `NeedsReviewIndicator`, `QuoteToTimestampLink`** — per § 1.10 of the compiled doc, page-specific primitives that land with Part 2 specs.
- **Any schema migration** — none in Part 1 per Decision 7.

## Side effects

**None outside the repo.** No external API calls, no Slack posts, no DB writes, no migrations, no env-var changes, no `vercel.json` / `next.config.mjs` / `package.json` changes, no new dependencies. The branch is pushed to `origin/gregory-redesign-part-1-foundations`; a PR is opened against `main` per spec § E with the body summarizing this report.

`lithium/` and `lithium.zip` (the Promethean design-handoff bundle from earlier today) remain untracked at the repo root — not added to any commit.

## Drake's verification

The PR is the verification surface. Vercel auto-deploys feature-branch previews; the preview URL surfaces on the PR page once the build completes. Drake walks the preview to confirm:

- No existing Gregory surface visibly changed — every page renders identically to the post-merge production state (since no page imports any of the new primitives yet). If a surface DID change, something leaked and needs investigation.
- The PR's diff shows only `components/gregory/*`, `docs/gregory-conventions.md`, `docs/future-ideas.md`, and the report — no `app/` files modified.
- `npm run build` in CI (if wired) passes; locally already verified clean.

Approval / merge is Drake's call. Part 2 specs reference `docs/gregory-conventions.md` and migrate pages one at a time.

PR title: `Gregory redesign Part 1 — foundations`. Body links this report and the spec. List of files touched grouped by category.
