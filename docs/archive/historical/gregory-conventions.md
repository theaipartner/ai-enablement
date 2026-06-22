# Gregory dashboard conventions

How Gregory's pages compose. Conventions live here so primitives in `components/gregory/` stay small and pages don't reinvent chrome. Every Part 2 spec references this file.

**Reader:** Builder in a fresh session weeks from now, picking up a Part 2 spec. Keep it terse.

## Detail-page slot order

Every detail page (`/clients/[id]`, `/calls/[id]`) composes in this order, top to bottom. Slots can be skipped (use `EmptyStateAwareSection` with `mode='hide'`) but never reordered.

1. **HeaderBand** — eyebrow + serif title + state pills + right-aligned actions + optional backlink. One `<h1>`. The page's primary identity. Use the eyebrow taxonomy below.
2. **Glance row** — inline-editable toggles, dropdowns, or pills that answer "what's the current state?" Single horizontal row. Should fit above the fold on a 1024px viewport.
3. **Workflow content** — the actionable sections. Action items list, concerns, next-steps, anything the CSM clicks during a working session. Multiple `EmptyStateAwareSection`s allowed here; render in priority order (most actionable first).
4. **History / context** — what led to the current state. Recent calls list, status-change history, NPS history. Read-mostly. Use `EmptyStateAwareSection` with `mode='show'` when present; `mode='hide'` when there's no history yet (e.g. a brand-new client with zero calls).
5. **Configuration / details** — editable-but-rarely-edited fields. Identity fields, hosting info, brand assets. `EmptyStateAwareSection` with `collapsible=true` and `defaultCollapsed=true` so the page doesn't bloat for the 99% case of "I just want to see what's happening."
6. **DiagnosticsCollapse** — raw JSON metadata, internal IDs, audit-trail dumps. Always last. Collapsed for everyone (Decision 5), no role-based default.

## List-page slot order

Every list page (`/clients`, `/calls`) composes in this order.

1. **HeaderBand** — same primitive as detail pages. Eyebrow is the list eyebrow ("CSM · CLIENTS"); right-aligned `actions` slot typically carries the row count.
2. **Optional metric strip** — conditional. `/clients` may get the TodayDigest in Part 2; `/calls` likely doesn't need one. Not every page has this slot — render only when meaningful.
3. **FilterBar** — search + filter chips + date range (where applicable) + saved-views (where applicable). Existing `FilterBar` / `CallsFilterBar` live here; Part 2 may consolidate.
4. **Table** — sortable column headers, inline-editable cells where appropriate. Information density takes priority over editorial breathing room — Gregory's lists are 100+ rows.
5. **Pagination** — bottom of table. "Load 100 more" pattern when row counts justify it.

## Empty-state rules (Decision 3)

`EmptyStateAwareSection` exposes three modes. Pages choose at composition time based on data presence — never toggle defensively at runtime.

- **`mode='hide'`** — section returns null entirely. No header, no content. Use when the section's absence is the correct UX (e.g. no Diagnostics on a record without any internal IDs to dump).
- **`mode='stub'`** — section header renders + a single labeled placeholder underneath. Use when the absence of content would confuse readers more than a labeled stub. Example: a brand-new client's recent-calls section reads "No calls yet. Calls auto-ingest after Fathom syncs."
- **`mode='show'`** — section header + full content. The 99% case.

**Anti-pattern.** A page that renders `<EmptyStateAwareSection mode={data ? 'show' : 'hide'} ...>` is correct; a page that passes `mode='hide'` with non-empty `children` is a bug — `mode` is the page's stated intent, not a defensive guard. Flag in code review.

## Diagnostics-collapse rule (Decision 5)

`DiagnosticsCollapse` is the slot-6 container for raw / dev-facing content on detail pages. Rules:

- Always at the bottom of detail pages. Never interleaved.
- Collapsed by default for everyone, including Drake. No role-based default.
- Content is dev-facing — JSON metadata, internal IDs, raw payload dumps, anything that helps debug a record but doesn't serve the CSM working the page.
- One per page. Don't render multiple stacked `DiagnosticsCollapse` blocks.

## Inline-editable contract (Decision 6)

Every inline-editable cell uses `InlineEditableField` (or a primitive that composes it, like `InlineEditableActionItemRow`). The contract:

- **Optimistic update.** Display value flips immediately on commit; the save fires in the background.
- **Persist on blur** for text fields; **on-change** for selects.
- **No row-level Save button.** Click-into-edit, click-out commits.
- **Inline error tooltip on failure** — NOT a toast. The display element shows a small red indicator with the error message in `title` and `aria-describedby`.
- **Revert on failure.** The display value flips back to the last-known-good. The error stays visible until the user re-edits.
- **Escape cancels** the in-progress edit; **Enter commits** (text) / **on-change commits** (select).
- **Tab moves focus** between editable fields via browser default; no custom tab order needed.
- **Computed fields don't get the affordance.** Don't wrap a computed timestamp or auto-derived value in `InlineEditableField`.

**Coexistence with the existing `editable-cell.tsx`.** The pre-redesign inline-edit on `/clients` (the four editable cells: status, journey stage, csm_standing, trustpilot) routes through `components/client-detail/editable-field.tsx`, which implements an older state-machine contract (saving / saved / error status badge, not inline tooltip). That implementation stays until a Part 2 spec migrates the clients list to `InlineEditableField`. `InlineEditableField` is canonical going forward; new editable surfaces use this primitive, not the old one.

## Header pattern (Decision 9)

Every page uses `HeaderBand`. Composition rules:

- One `<h1>` per page, rendered by `HeaderBand`.
- Title is the entity name on detail pages (`{client.full_name}`, `{call.title ?? 'Untitled call'}`), the list copy on list pages (`All clients.`, `All calls.`).
- `eyebrow` follows the taxonomy below — never improvise.
- `pills` slot below the title carries state indicators (status, journey stage, needs-review, sentiment) on detail pages. List pages don't use this slot.
- `actions` slot on the right carries primary actions and counts. List pages typically use it for `{count} CLIENTS`. Detail pages may use it for primary buttons.
- `backlink` slot on detail pages carries upward navigation ("← BACK TO CLIENTS"). List pages don't use this slot.

### Eyebrow taxonomy

| Page                  | Eyebrow            |
|-----------------------|--------------------|
| `/clients`            | `CSM · CLIENTS`    |
| `/clients/[id]`       | `CLIENT · DETAIL`  |
| `/calls`              | `CSM · CALLS`      |
| `/calls/[id]`         | `CALL · DETAIL`    |

If a future page doesn't fit the taxonomy cleanly, add an entry here in the same spec that ships the page.

## Sentiment data flow (Decision 7)

Sentiment tier (`green` / `yellow` / `red`) for a call lives in `documents.metadata.sentiment_tier` on the `call_summary` row for that call. Populated by Haiku at call-summary generation time (Part 2 work). Consumed by `<SentimentPill>` on call-adjacent surfaces.

- For visuals only. Never filtered, sorted, or queried at scale.
- No new table, no new column, no migration (Decision 7).
- Null / missing tier → `SentimentPill` renders nothing. Pages handle loading state upstream (skeleton or absent slot).
- Color is redundantly encoded with a text label per § Baseline NFRs.

## Primitive index

Future renames of any `geg-*` token should grep this table to see what breaks.

| Primitive                      | File path                                                   | Slot                                     | Tokens consumed                                                                                                  |
|--------------------------------|-------------------------------------------------------------|------------------------------------------|------------------------------------------------------------------------------------------------------------------|
| `HeaderBand`                   | `components/gregory/header-band.tsx`                        | Detail/list slot 1                       | `--color-geg-border-strong`, `--color-geg-text-3`, `.geg-eyebrow`, `.geg-display`                                |
| `EmptyStateAwareSection`       | `components/gregory/empty-state-aware-section.tsx`          | Detail slots 2–5, list table sections    | `--color-geg-text-3`, `.geg-section-title`                                                                       |
| `DiagnosticsCollapse`          | `components/gregory/diagnostics-collapse.tsx`               | Detail slot 6                            | `--color-geg-border`, `--color-geg-text-3`, `.geg-eyebrow`                                                       |
| `InlineEditableField`          | `components/gregory/inline-editable-field.tsx`              | Detail slots 2 + 5; list editable cells  | `--color-geg-bg-elev`, `--color-geg-text`, `--color-geg-text-3`, `--color-geg-border-strong`, `--color-geg-neg`  |
| `InlineEditableActionItemRow`  | `components/gregory/inline-editable-action-item-row.tsx`    | Detail slot 3 (action-items list)        | `--color-geg-text-3`, `--color-geg-border`, plus all tokens consumed by `InlineEditableField`                    |
| `SentimentPill`                | `components/gregory/sentiment-pill.tsx`                     | Call-adjacent (list, detail, recent-calls) | `--color-geg-accent-dim`, `--color-geg-accent-strong`, `--color-geg-warn-dim`, `--color-geg-warn`, `--color-geg-neg-dim`, `--color-geg-neg` |

## Baseline NFRs (Decision 10)

These apply to every Gregory page. Part 2 specs may add page-specific requirements but never below the floor here.

- **Desktop-first.** Doesn't have to be pretty below 1024px but doesn't fall apart either. Single-column reflow below ~900px is acceptable.
- **Skeleton over spinner.** Loading states render skeleton outlines that match the eventual content shape. No centered spinner overlays.
- **Per-section error handling.** A failed data fetch in one section shows an inline error in that section's slot — never blanks the whole page.
- **Real `<h1>` semantics.** Exactly one `<h1>` per page, rendered via `HeaderBand`. Section headers are `<h2>`.
- **Keyboard nav on inline edits.** Tab moves focus between editable fields; Enter commits (text) / on-change commits (select); Escape reverts.
- **ARIA on pills.** Every pill carries an `aria-label` describing the state. Color must be redundantly encoded with a text label (color-blind users get the meaning either way).
- **Header backlinks.** Detail pages render the `HeaderBand` `backlink` slot for upward navigation. List pages don't need it.
- **Permalink-able sections.** A future spec may add `id` anchors to `EmptyStateAwareSection` so a section can be linked-to directly. Not required today; don't preemptively add it.
