# Fulfillment conventions

The durable rules for working on the fulfillment side. Three sections:

- [Dashboard UI composition](#dashboard-ui-composition) — how Gregory pages compose.
- [Call titling](#call-titling) — how scheduled calls should be named.
- [Data hygiene](#data-hygiene) — what's allowed into Supabase from a source system.

The KB-ingestion metadata contract is large and code-referenced, so it lives separately in
[metadata-conventions.md](metadata-conventions.md).

---

## Dashboard UI composition

Conventions so primitives in `components/gregory/` stay small and pages don't reinvent chrome.

### Detail-page slot order
Every detail page (`/clients/[id]`, `/calls/[id]`) composes top-to-bottom in this order. Slots can be
skipped (`EmptyStateAwareSection mode='hide'`) but never reordered:

1. **HeaderBand** — eyebrow + serif title + state pills + right-aligned actions + optional backlink. One `<h1>`.
2. **Glance row** — inline-editable toggles/dropdowns/pills answering "what's the current state?" Single row, above the fold at 1024px.
3. **Workflow content** — the actionable sections (action items, concerns, next steps). Most actionable first.
4. **History / context** — what led to the current state (recent calls, status history, NPS history). Read-mostly.
5. **Configuration / details** — editable-but-rarely-edited fields. Collapsible, default-collapsed.
6. **DiagnosticsCollapse** — raw JSON / internal IDs / audit dumps. Always last, collapsed for everyone.

### List-page slot order
Every list page (`/clients`, `/calls`): **HeaderBand** → optional metric strip → **FilterBar** →
**Table** (sortable headers, inline-editable cells; density over whitespace — lists run 100+ rows) →
**Pagination** ("Load 100 more").

### Empty-state rules
`EmptyStateAwareSection` exposes three modes, chosen at composition time by data presence — never toggled
defensively at runtime:
- `mode='hide'` — section returns null. Use when absence is correct UX.
- `mode='stub'` — header + one labeled placeholder. Use when absence would confuse (e.g. "No calls yet. Calls auto-ingest after Fathom syncs.").
- `mode='show'` — header + full content. The common case.

Passing `mode='hide'` with non-empty children is a bug — `mode` is stated intent, not a guard.

### Inline-editable contract
Every editable cell uses `InlineEditableField` (or a primitive composing it):
- Optimistic update; save fires in background.
- Persist on blur (text) / on change (selects). No row-level Save button.
- On failure: revert to last-known-good + inline error tooltip (not a toast); error stays until re-edit.
- Escape cancels; Enter commits (text). Tab moves focus via browser default.
- Computed/derived fields don't get the affordance.

`InlineEditableField` is canonical for new surfaces. The older `components/client-detail/editable-field.tsx`
(the four editable cells on `/clients`: status / journey_stage / csm_standing / trustpilot) uses a prior
status-badge contract and stays until migrated.

### Header pattern
Every page uses `HeaderBand`: one `<h1>`; title is the entity name (detail) or list copy (list); `pills`
slot carries state on detail pages; `actions` slot carries primary actions/counts; `backlink` on detail
pages only. Eyebrow taxonomy:

| Page | Eyebrow |
|---|---|
| `/clients` | `CSM · CLIENTS` |
| `/clients/[id]` | `CLIENT · DETAIL` |
| `/calls` | `CSM · CALLS` |
| `/calls/[id]` | `CALL · DETAIL` |

Add an entry here in the same change that ships a new page.

### Sentiment pill
A call's sentiment tier (`green`/`yellow`/`red`) lives in `documents.metadata.sentiment_tier` on the
`call_summary` row, populated by Haiku at summary time. Consumed by `<SentimentPill>` for visuals only —
never filtered/sorted/queried at scale, no dedicated column. Null tier → renders nothing. Color is always
paired with a text label.

### Baseline NFRs
Desktop-first (no breakage below 1024px; single-column reflow below ~900px OK). Skeletons over spinners.
Per-section error handling (a failed fetch shows an inline error in its slot, never blanks the page). Exactly
one `<h1>` per page; section headers are `<h2>`. Keyboard nav on inline edits. ARIA labels on every pill, with
color redundantly encoded as text.

### Primitive index
`HeaderBand`, `EmptyStateAwareSection`, `DiagnosticsCollapse`, `InlineEditableField`,
`InlineEditableActionItemRow`, `SentimentPill` — all in `components/gregory/`. Grep there before renaming any
`--color-geg-*` / `geg-*` token.

---

## Call titling

For Calendly / Google Calendar events that feed Fathom recordings. Consistent titles let the team scan
calendars; the classifier categorizes mainly on participant emails + content, but clean titles keep the data
honest and enable future title-aware rules.

Three client-facing types (use a prefix):

- `[Client] <CSM First> x <Client First> <Client Last Initial>` — a CSM with an existing paying client. *(e.g. `[Client] Lou x Tina H`)*
- `[Discovery] <CSM First> x <Prospect First> <Prospect Last Initial>` — a pre-signature sales call. *(e.g. `[Discovery] Aman x John D`)*
- `[Client x Prospect] <Our Client First> x <CSM First>` — a CSM joining our client's call with *their* prospect. *(e.g. `[Client x Prospect] Tina x Lou`)*

**Internal calls take no prefix.** The absence is the signal: the classifier routes prefix-less calls to
`internal`/`unclassified` and the dashboard filters them out of the Calls view by default.

Edge cases: multiple CSMs → `+` for our side, `x` for our-vs-client (`[Client] Lou + Scott x Tina H`); unknown
prospect → bracket placeholder (`[Discovery] Aman x [Prospect]`), update post-call. Subtypes (renewal, etc.)
are deferred — all CSM-with-client calls are `[Client]` today.

---

## Data hygiene

Rules for what we let into Supabase from any source system.

**Verify field ownership before ingesting.** Before a pipeline writes a column from an external source,
confirm the source is authoritative for that field. If the real value lives elsewhere (a person's head, a
different tool, a derived calc), don't import the stale copy. A missing field is a known gap; a stale one is a
confident lie that every downstream consumer treats as truth.

**For spreadsheets, import the owner's working view — don't re-derive it in code.** The logic of "who counts"
already exists in the owner's saved filter, maintained daily. In order: (1) ask which saved view they use;
(2) have them export that view, ingest from the export; (3) never reimplement the filter in Python — that
creates a second source of truth that drifts; (4) ask which columns are stale and skip them.

**Active++ is canonical for clients.** The sheet owner's `Active++` saved view defines "who is a client." The
`clients` table holds Active++ plus two other categories: auto-created `needs_review` rows (from call ingest,
with a breadcrumb to the triggering call — a reviewer confirms or merges) and soft-archived rows
(`archived_at is not null`, history preserved, hidden from agents). Any discrepancy between Active++ and
"non-archived, non-needs_review rows in `clients`" is a bug: either the sheet drifted (fix it, re-run
`scripts/seed_clients.py`) or something inserted a row out of band (track it down).

**Historical data without ownership is noise.** If nobody on the team can vouch for a batch's source and
accuracy, don't import it — soft-archive, drop, or leave it out. Real history accumulates forward, under
current ownership, with context.

**Compressed:** for each field — *who owns this, and is this the system they update?* If "nobody reliably" or
"a different tool," skip it. For spreadsheets, import the owner's view. Document every exclusion in the
pipeline's runbook or docstring so the next person knows it's missing on purpose.
