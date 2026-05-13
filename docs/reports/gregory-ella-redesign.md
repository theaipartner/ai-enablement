# Report: Gregory — Ella audit visual redesign
**Slug:** gregory-ella-redesign
**Spec:** `Gregory Ella Redesign.html` (root-level mock from Design)

## Files touched

**Modified:**

- `app/(authenticated)/ella/runs/page.tsx` — list-page chrome restyled (editorial padding, HeaderBand count formatting, full-width metric+filter+table stack, Load-100-more button styled to match the rest of the editorial dark surface).
- `app/(authenticated)/ella/runs/summary-band.tsx` — rewritten from shadcn white cards to a 4-card gold-bordered translucent metric strip (`Runs · today`, `Cost · today`, `Errors · today`, `Surface`). Errors value paints `--color-geg-neg` when > 0. Serif tabular-num values; mono caps labels.
- `app/(authenticated)/ella/runs/filter-bar.tsx` — restyled to editorial dark. Date range as an inline mono widget with `→` arrow + two `<input type="date">` fields, then Channel (searchable multi-select) + Status (multi-select) dropdowns in matching chrome. Triggers filter explicitly excluded per Drake.
- `app/(authenticated)/ella/runs/pills.tsx` — dropped shadcn Badge; uses `GegPill` (`pos / warn / neg / muted / gold` tiers) for `RolePill`, `RunStatusPill`, and the new `TriggerTypePill` (gold, used on the detail page header). New `CellWhen` helper renders the two-line `When` cell (`rel` on top, `abs` time-of-day below).
- `app/(authenticated)/ella/runs/runs-table.tsx` — rewritten as a native `<table>` (inherits the theme-scoped gold-divider + row-hover rules from `app/globals.css`). Cell composition matches the mock exactly: When (2-line), Channel (#name + client_name muted), Who Ella responded to (name + role pill), Status pill, Output (2-line clamp), Tokens · Cost right-aligned with the tokens line above and the cost line below.
- `app/(authenticated)/ella/runs/[id]/page.tsx` — full detail-page rewrite. Hand-rolled editorial header (backlink + eyebrow + 36px serif title + pill row + right-aligned mono stats). 420 / 1fr two-column grid. LEFT: Context box + Haiku decision box (+ Escalation box when present). RIGHT: Triggering message + Ella's response, each in a `geg-gold-box` wrapper containing a `geg-slack-msg` body. Diagnostics collapse retained at the bottom.
- `app/(authenticated)/ella/runs/[id]/expandable-message.tsx` — rewritten as a Slack-styled message block with optional `author` + `authorIsElla` + `timeLabel` props. Same 500-char truncate + "Show more" / "Show less" contract; "see more" preserved per Drake's explicit ask. Toggle is mono caps gold in the editorial chrome.
- `app/globals.css` — added `.geg-slack-msg` paragraph + list + inline-mark CSS (p / strong / em / a / code / ul / li) so the `Mrkdwn` renderer's output matches the mock's `.slack-msg` treatment.
- `scripts/verify-ella-escalation-output.ts` — minor consolidation from prior spec (uncommitted leftover folded into this commit; no behavior change).

**Created:**

- `scripts/verify-ella-redesign.ts` — Playwright harness for the redesign verification. Captures the list page (full + above-the-fold crop) and the detail page (collapsed + after Show-more clicks).

## What I did, in plain English

Drake handed me `Gregory Ella Redesign.html` (a Design mock at repo root) and asked for the existing `/ella/runs` + `/ella/runs/[id]` to match it exactly. Pure design ship — no data or route changes. Triggers filter on the list page excluded per Drake's direction; "see more" preserved on both detail-page message sections per Drake's explicit ask.

The Ella pages had been the last surface still on the white shadcn chrome (Badge / Table / cards). Everything else (Calls + Clients) had already migrated to the editorial dark visual language. This pass brings Ella into line:

**List page** is now the four editorial chunks the Calls + Clients lists use:
- HeaderBand-style eyebrow + serif title + count
- 4-card gold-bordered translucent metric strip with serif tabular-num values
- Filter bar with inline date range + Channel + Status (no Triggers)
- Native `<table>` flush on the page with gold-bordered row dividers, two-line `When`, channel/client-name composite, role + status pills, two-line clamped output, and a right-aligned tokens-over-cost cell

**Detail page** is the same parallel as `/calls/[id]`:
- Mono caps gold backlink
- 36px serif title derived from run data (`Responded to Nico Sandoval in #Yogesh Dhaybar.`)
- Pill row: status + trigger type + model
- Right-aligned mono cost / tokens / ms
- 420 / 1fr two-column grid where the LEFT stack carries small dense content (Context + Haiku decision + Escalation when present) and the RIGHT stack carries the heavy content (Triggering message + Ella's response)
- Each message block is a `geg-gold-box` containing a `geg-slack-msg` shell with author + time top-row and Mrkdwn-rendered body
- 500-char truncate + "Show full message (N more chars) →" preserved on both messages; clicking it expands to full

No data-layer changes. No route changes. No new dependencies. The Mrkdwn renderer was already in place from the prior pre-redesign-fixes spec; this pass just wraps its output in the Slack-msg styling the mock specifies.

## Verification

- **TypeScript** — `npx tsc --noEmit` clean.
- **ESLint** — `npx next lint` clean.
- **Playwright** — `scripts/verify-ella-redesign.ts` against `gregory-csm-visual-fixes` preview URL. Four screenshots captured cleanly in one pass. The harness picks the first run whose messages are long enough to demonstrate the truncation contract (in this case `f2e7427f-...` — a slack_mention run with an 11,344-char triggering message and a 3,327-char response).

### Screenshots (committed to `scripts/.preview/`)

- `ella-redesign-list-cropped.png` — `/ella/runs` above the fold. Eyebrow `ELLA · AUDIT`, serif `Run history.` title, `55 RUNS` count, 4-card metric strip (`2 / $0.08 / 0 / Ella V2`), filter bar with date range + Channel + Status (no Triggers), table head + first ~6 rows.
- `ella-redesign-list.png` — full `/ella/runs` viewport snapshot.
- `ella-redesign-detail.png` — `/ella/runs/[id]` full page, collapsed state. Both messages truncated at 500 chars with `Show full message (N more chars) →` visible. Context box renders 5 dense data rows. Haiku decision box shows synthetic reactive content in italic muted (since the run is a slack_mention).
- `ella-redesign-detail-expanded.png` — same page after clicking both `Show full message` buttons. Messages fully expand, Mrkdwn rendering (bold, italic, mentions in gold, bullet lists) all visible.

### Visual checks against the mock

- Header: matches. Eyebrow / serif title / pill row / right-aligned stats all in the right positions and typography.
- Metric strip: matches. Gold borders, translucent fill, serif tabular values, mono labels, mono hint with this-week / this-month rollups.
- Filter bar: matches the editorial-dark treatment. Triggers filter excluded.
- Table: matches. Two-line When, channel + client_name muted underneath, role pill next to author, status pill, 2-line clamped output, tokens/cost stacked.
- Detail page 420 / 1fr grid: matches.
- Slack-msg blocks: dark translucent background, subtle white border, author row with name + time, mono caps "Show full message" toggle.
- Show-more toggles: present on both messages where content exceeds 500 chars; preserved per spec.

## Surprises and judgment calls

- **Date-input visible state.** The mock shows the date range with placeholder dates (`2026-05-06 → 2026-05-13`). My render shows the native browser placeholder `mm/dd/yyyy` because no filter is applied. Faithful to the actual UX of the empty-filter state; the populated state would match the mock when a user picks dates.

- **Detail-page header dropped `HeaderBand`.** The mock specifies a 36px serif title on the detail page (smaller than the 52px `HeaderBand` default), and the pill row composes Status + Trigger + Model rather than the generic pills slot. Hand-rolled inline so the header matches the mock pixel-shape — same pattern the `/clients/[id]` and `/calls/[id]` detail pages use.

- **Pill mapping for trigger types.** The mock lists pill labels (`@-mention`, `Bare @`, `Passive response`, `Passive opener`, `Passive escalate`). Added a `TriggerTypePill` to `pills.tsx` that maps the raw `trigger_type` string to the human label and uses the `gold` tier per the mock. The Calls-detail header parallel uses `TriggerTypePill` too.

- **Synthetic Haiku content.** The mock's example shows a passive run with real Haiku reasoning. The first run I caught with long enough messages happens to be a slack_mention (reactive), so the detail screenshot shows the synthetic Haiku content path — italic muted "Direct @-mention from Nico Sandoval". The renderer handles both shapes cleanly; both look on-brand.

- **`.geg-slack-msg` CSS additions.** The Mrkdwn renderer outputs raw HTML (`<p>`, `<strong>`, etc.) that previously rendered against Tailwind defaults. Added theme-scoped CSS so paragraph margins, list indents, bullet color, link styling, and inline code all match the mock's `.slack-msg` treatment. Keeps the renderer agnostic (no Tailwind classes baked into the React component) while pinning the visuals to the editorial language.

- **Wrapping vs. extending `ExpandableMessage`.** Two paths considered: (1) keep `ExpandableMessage` as a generic body-only component and wrap it in a separate Slack-msg shell per call site, or (2) fold the author row + Slack-msg shell into `ExpandableMessage` itself with optional props. Picked (2) since the detail page is the only consumer today and the coupling is tight (author row + body live inside the same `.slack-msg` container per the mock). If a future surface needs a body-only version, easy to factor back.

- **Mock's "Trigger metadata" subsection.** The mock doesn't surface the raw trigger_metadata JSON anywhere visible. The existing Diagnostics collapse at the bottom of the detail page kept that affordance — it's collapsed by default so doesn't intrude on the visual, but accessible for debugging. Stayed in.

- **No new dependencies.** No markdown library, no new shadcn primitives, no new icons. Everything inline-styled or via existing `geg-*` CSS classes.

- **Surrounding messages section** was already removed in the prior pre-redesign-fixes spec — confirmed not in the rendered output via Playwright.

## Out of scope / deferred

- Drake's gate (c) manual click-through on the deploy preview: hover the rows, click into a few runs, confirm the visual reads cleanly across run shapes (passive substantive, passive escalate, error, etc.). Playwright captures one shape; eyeballing the rest is gate (c).
- Re-running the prior verify harnesses (`verify-ella-escalation-output.ts`, `verify-ella-pre-redesign-fixes.ts`) against the new visuals. The data contract behind them is unchanged so behavior is the same; the screenshots from those runs are now stale visually but their findings still hold.
- The mock's annotation pills (right-margin design notes) — not in the shipped UI, those are mock-only.
- Numbered lists, tables, and other unsupported mrkdwn syntax — still out of scope per the prior renderer spec.
- Migrating any other Ella surface (`agents/ella/` lives in Python and is unaffected; only the dashboard pages were targeted).

## Side effects

- **Pushed to `gregory-csm-visual-fixes` branch** (NOT main). Two commits land the work:
  - `cbe5c41` — list-page redesign (summary band + filter bar + pills + table + page chrome).
  - `28ede3f` — detail-page redesign (rewritten page + Slack-styled ExpandableMessage + globals.css additions).
  - `6bd32e9` — Playwright harness.
  - This report's commit (next).
- **No DB writes, no Slack posts, no external API calls** from this run. Playwright was read-only (Show-more toggles are client-side state).
- **Status convention:** the design ship is on a feature branch, not main. Drake merges on his cadence; the report stays at the canonical path until then.
- **Local working-tree files preserved** from session start. Four new PNGs in `scripts/.preview/`.
