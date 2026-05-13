# Report: Gregory Redesign Part 2 — Ella audit list page polish
**Slug:** gregory-redesign-part-2-ella-list-polish
**Spec:** docs/specs/gregory-redesign-part-2-ella-list-polish.md
**Branch:** `gregory-redesign-part-1-foundations` (stacked on Part 1 + prior Part 2)

## Files touched

**Modified — data layer**

- `lib/db/ella-runs.ts` — response-scope filter on raw runs in `getEllaRunsList` (excludes Haiku-decided-skip rows); new `output_text` field on `EllaRunsListRow` (prefers `output_summary`, falls back to `slack_response_text`, mention-rendered); Slack `<@U...>` mention rewriter inline in `getEllaRunsList` (one batched lookup against `clients` + `team_members`, replaces with `@First Last` on hit, leaves raw on miss); response-scope cost / count / error rollups in `getEllaSummaryStats`; new `skip_cost_today` field on `EllaSummaryStats`.

**Modified — list-page surfaces**

- `app/(authenticated)/ella/runs/summary-band.tsx` — Cost card hint extended with `{skip_today} skip cost today`.
- `app/(authenticated)/ella/runs/filter-bar.tsx` — outer container `bg-zinc-50/50` → `bg-white` (gregory-editorial CSS override flips both surfaces to the same elevated dark tier).
- `app/(authenticated)/ella/runs/runs-table.tsx` — Input column → Output column (reads `output_text`); outer `rounded-md border bg-white` wrapper removed; cell padding bumped via `CELL_PADDING = 'py-3 px-2'` applied to every `<TableHead>` + `<TableCell>`.

**Not touched**

- `app/(authenticated)/ella/runs/page.tsx` — pagination guard already gated correctly from the prior Part 2 spec (`rows.length >= limit && rows.length < total` is false when `total <= limit`); no edit required.
- `app/(authenticated)/ella/runs/[id]/page.tsx` — out of scope per spec.
- `app/(authenticated)/ella/runs/pills.tsx` — unchanged.
- `components/gregory/*` — unchanged (Part 1 primitives stay).
- Shadcn `components/ui/table.tsx` — not modified; the chrome strip lands at call site only.
- `docs/gregory-conventions.md`, `docs/agents/ella/ella.md`, `docs/state.md`, `CLAUDE.md`, `docs/known-issues.md`, `docs/future-ideas.md` — none needed updating; flagged in spec's mandatory-doc-update list as "possibly," but nothing this work surfaced warrants a doc change.

**Created**

- `docs/reports/gregory-redesign-part-2-ella-list-polish.md` — this file.

## Acclimatization checkpoint (per spec)

Folded into the first commit's body (`gregory: ella-runs data layer — response-scope filter + Output column + mentions + skip_cost`, SHA `1b601bb`):

- **(a) File map** — `lib/db/ella-runs.ts` + four UI files. No new components, no new tokens.
- **(b) Response-scope predicate** — in-JS filter on raw runs before projection: `status IN ('success','escalated','error')` AND `(haiku_decision !== 'skip')`. Reactive runs lack `haiku_decision` (the IS-NULL branch keeps them).
- **(c) Ella-outgoing-message join** — existing `fetchSlackResponseTexts` already returns `Map<runId, slack_text>`. Repurposed for the Output column source.
- **(d) Mention rendering** — scan all rows' output text once for `<@U...>`, dedup user IDs, batched lookup, helper rewrites at projection time. Resolved at the data layer so the table component stays dumb.
- **(e) Drift** — none non-trivial. Shadcn `TableRow` already has `border-b` in its defaults, so the per-row borders survive the outer-wrapper removal without modifying the shadcn primitive.

## Commits on `gregory-redesign-part-1-foundations`

Stacked on the prior Part 1 + Part 2 commits:

- `1b601bb` — `gregory: ella-runs data layer — response-scope filter + Output column + mentions + skip_cost`
- `3cbbd7b` — `gregory: ella-runs list polish — Output column, chrome strip, Cost hint, filter tint`
- (report commit follows)

PR #1 picks up both commits automatically.

## `npm run build` status

**Clean.** 9 routes total. Bundle sizes unchanged from the prior Part 2 ship (3.98 kB for `/ella/runs`; 983 B for `/ella/runs/[id]`).

## What I did, in plain English

Two coherent moves on the Ella list page, separated into two commits.

**1. Data layer changes (`1b601bb`).** The big one is the response-scope filter. Today's list shows every `agent_runs` row with `agent_name='ella'`, including passive-monitor evaluations where Haiku decided to stay silent. Those are observations, not responses — Drake's deploy-preview walk surfaced this as the dominant noise on the page (152 runs for the month; most are skip decisions on accountability-bot posts). The filter runs in-JS over raw runs before any projection: keep `status IN ('success', 'escalated', 'error')` AND `haiku_decision !== 'skip'`. Reactive @-mention runs have no `haiku_decision` in trigger_metadata, so the `!= 'skip'` check trivially passes for them (matches the spec's `IS NULL` branch semantics).

Same predicate drives the summary-band's count / cost / error rollups. New `skip_cost_today` is the inverse — the cost of today's Haiku skip evaluations — surfaced separately on the Cost card hint so it's visible but doesn't pollute the headline figure.

`output_text` is a new field on `EllaRunsListRow` for the Output column. Prefers non-empty `output_summary` from `agent_runs`, falls back to the `slack_messages` text via the existing `fetchSlackResponseTexts` helper, else null. Slack `<@U0XXXX>` mention syntax gets rewritten to `@First Last` at this point — one pass over all rows builds a deduped set of mentioned user IDs, one batched lookup against `clients` + `team_members`, then a regex replace during projection. Unresolvable IDs leave the raw `<@U...>` form (don't silently lose mentions on miss).

`getEllaRunsList`'s returned `total` is post-filter response-scope. That number drives the HeaderBand RUNS count + the "Load 100 more" render guard; grep confirmed those are the only consumers, both correctly reflect response-scope-only.

**2. UI polish (`3cbbd7b`).** Three surfaces, three small visual moves.

`summary-band.tsx`: Cost card hint adds `· {skip_cost_today} skip cost today`. Four inline values now where the other cards have three; spec accepts the asymmetry as deliberate ("the Cost card carries more information; that's fine").

`filter-bar.tsx`: outer container flipped from `bg-zinc-50/50` to `bg-white`. The summary-band cards also use `bg-white`; both fall through the `[data-theme="gregory-editorial"]` CSS override (`background-color: var(--color-geg-bg-elev)`) so they sit on the same elevated dark surface tier. Drake's original "reads pale / pasted-in" was the `/50` opacity modifier on `bg-zinc-50` — that escaped the override and rendered light-zinc at 50% opacity over the page bg.

`runs-table.tsx`: outer `<div className="rounded-md border bg-white">` wrapper removed; table now sits flush on the page. Shadcn `TableRow` already has `border-b` in its defaults, so per-row separation survives. Cell padding bumped via a `CELL_PADDING` constant applied to every `<TableHead>` + `<TableCell>` so row breathing room matches the metric cards above. Input column → Output column reading `row.output_text` (mention-rendered at the data layer; this component stays dumb).

## Verification

- `npm run build` clean.
- Type checks: `output_text` is a required field on `EllaRunsListRow` — TypeScript caught the missing field in `getEllaRunDetail`'s return when I first added it; fixed before commit.
- Response-scope predicate semantics:
  - Reactive @-mention success run: `status='success'`, no `haiku_decision` → **kept** ✓
  - Passive monitor responded substantive: `status='success'`, `haiku_decision='respond_substantive'` → **kept** ✓
  - Passive monitor skipped: `status='success'`, `haiku_decision='skip'` → **filtered out** ✓
  - Reactive error: `status='error'`, no `haiku_decision` → **kept** ✓
  - Escalated: `status='escalated'`, may or may not have decision → **kept** (escalated is always in scope) ✓
- Skip-cost computed only when `haiku_decision === 'skip'` literally; matches the spec's "Haiku-decided skip" definition.
- Mention rendering tested via the regex: `/<@(U[A-Z0-9]+)>/g` matches `<@U0123ABC>` (slack uppercase-and-digit user IDs); leaves URL syntax (`<https://...>`) and channel syntax (`<#C0...|name>`) and broadcast syntax (`<!here>`) alone — none of those start with `@` followed by `U` then uppercase-alphanumeric.
- Did NOT exercise the running UI in a browser (no display in this environment). Drake's gate (c) deploy-preview smoke is the actual confirmation.

## Surprises and judgment calls

- **EllaRunDetail's `output_text` is populated without mention rendering.** The mention name map is built inside `getEllaRunsList`, not `getEllaRunDetail`. The detail page reads `slack_response_text` raw for its own client-facing / handoff splitting; it doesn't read `output_text` directly. Populating `output_text` on the detail return is just a TypeScript completeness fix — the field exists because `EllaRunDetail` extends `EllaRunsListRow`. If a future page reads `output_text` from the detail, mention rendering would need to be folded into `getEllaRunDetail` too. Flagged here, not a bug today.
- **Response-scope predicate applies unconditionally** (no toggle). The spec's preferred path; the list exists to show responses, not observations. If you ever want a "show all runs including skips" view for debug, that's a separate page or a future toggle. I did NOT add a future-ideas entry for this — spec marked it "Possibly," and I didn't see a concrete pull. Easy to add if the use case lands.
- **The shadcn `TableRow` already had `border-b`, so the "per-row borders" half of Decision 6 was a no-op.** All I needed was the outer wrapper strip + the cell padding bump. The doubled-border failure mode the spec called out doesn't apply.
- **Cell padding via a `CELL_PADDING` constant rather than a className override on `TableRow`.** TableRow doesn't get per-row padding; padding sits on TableCell. Applied to every cell (and matching heads) to keep the row height consistent and avoid forgetting one.
- **Filter-bar tint solved by leaning on the existing CSS override.** `bg-white` + the override = `var(--color-geg-bg-elev)`. Spec offered "Builder reads the actual token from the cards' rendered output and applies it to the filter bar." I went one level up — both use `bg-white`, both get the same flip, so they're guaranteed to match (and stay matched if the token underlying `--color-geg-bg-elev` changes).
- **Skip-cost on the Cost card may read as four parallel values.** Spec flagged this risk; I kept the inline format ("X today · Y this week · Z this month · W skip cost today"). The "skip cost today" label is explicit. If post-deploy the visual reads ambiguous, the next polish pass can break it onto its own line or render it muted.
- **Slack mention rendering is regex-bounded to `<@U...>` only.** No handling for channel mentions (`<#C0...|name>`), broadcast mentions (`<!here>`, `<!channel>`), or URLs (`<https://...|text>`). Spec hard-stop #2 confirmed this scope. None of those syntaxes start with `@` so they fall through without modification.
- **`status_counts` in `EllaSummaryStats` is now response-scope.** The detail page may consume this in the future (it doesn't today); the rollup honestly reflects "what statuses did Ella's responses end in." Skip rows would have polluted this with `success` dominance; the gate is correct.

## Out of scope / deferred

- Detail page (`/ella/runs/[id]`) — next spec.
- Other Gregory surfaces (`/clients`, `/clients/[id]`, `/calls`, `/calls/[id]`) — Part 2 specs each.
- "Show all runs including skips" toggle — future spec if needed.
- Slack syntax beyond `<@U...>` mentions — future spec if a syntax appears commonly enough.
- Tests — deferred to `gregory-ts-test-infra` per Part 1 precedent.

## Side effects

**None outside the repo.** No external API calls beyond the git push, no Slack posts, no DB writes, no migrations, no env-var changes, no `vercel.json` / `next.config.mjs` / `package.json` changes, no new dependencies, no Anthropic / OpenAI calls. Two commits pushed to `origin/gregory-redesign-part-1-foundations` (1b601bb + 3cbbd7b); PR #1 picks them up automatically and Vercel will redeploy the preview.

## Drake's verification

After the PR preview redeploys:

1. `/ella/runs` row count — confirm it drops from ~152 to something well under 100 (Drake's stated expectation: 20-40). HeaderBand actions slot reads `{count} RUNS` matching that smaller number.
2. Open the Output column — confirm rows show Ella's actual output text, truncated to 80 chars, with `<@U...>` syntax rewritten to `@First Last` where the user is resolvable.
3. Summary band — Cost card reads today's spend big, hint line `${week} · ${month} · ${skip_today} skip cost today`. The skip-cost figure may surprise (it's been hidden); confirm it reads as a separate, labeled figure not as a fourth parallel value.
4. Filter bar — visually anchored to the cards above (same dark elevated surface). No more "pasted-in" pale look.
5. Table chrome — flush against the page background, per-row borders, comfortable row height matching the cards' breathing room. Outer rounded box gone.
6. Pagination — "Load 100 more" button does NOT render (total <= 100 expected post-filter). If it does render, that's a sign the response-scope filter didn't apply correctly.

If any of (1)-(6) read wrong, point me at the surface + issue and I'll iterate.
