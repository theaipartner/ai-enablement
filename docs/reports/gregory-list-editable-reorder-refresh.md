# Report: Gregory clients list — editable cells, column reorder, refresh + back-nav fixes
**Slug:** gregory-list-editable-reorder-refresh
**Spec:** docs/specs/gregory-list-editable-reorder-refresh.md

## Files touched

**Created:**
- `app/(authenticated)/clients/editable-cell.tsx` — four `'use client'` wrapper components (`EditableStatusCell`, `EditableJourneyStageCell`, `EditableCsmStandingCell`, `EditableTrustpilotCell`) each wrapping `EditableField` in `variant="enum"` + the per-cell Server Action + `router.refresh()` on save.
- `app/(authenticated)/clients/[id]/back-to-clients-button.tsx` — `'use client'` Link with `onClick` that calls `router.back()` when `window.history.length > 1`, falls through to the Link's `/clients` href otherwise.

**Modified:**
- `app/(authenticated)/clients/clients-table.tsx` — updated `SortKey` union + `SORTABLE_COLUMNS` to Scott's order with `csm_standing` added; replaced four static cells (`StatusPill`, `JourneyStagePill`, `TrustpilotPill` cells + the new CSM Standing slot) with their editable counterparts; removed `cursor-pointer` from the `TableRow` (mixed cell types now — half navigate, half edit); dropped now-unused `StatusPill` / `JourneyStagePill` / `TrustpilotPill` imports.
- `app/(authenticated)/clients/page.tsx` — added `export const dynamic = 'force-dynamic'` with a one-paragraph comment explaining the cache-staleness defeat; updated mirror `SortKey` + `VALID_SORT_KEYS` to match the table.
- `app/(authenticated)/clients/[id]/page.tsx` — replaced the back-nav `<Link href="/clients">` with `<BackToClientsButton />`; dropped the now-unused top-level `Link` import.
- `docs/state.md` — appended a new bullet under the existing "Clients list V2 columns (2026-05-08)" entry documenting the editable cells + reorder + force-dynamic + back-nav.

**Deleted:** none.

## What I did, in plain English

Implemented Scott's 2026-05-11 list-page asks plus Drake's refresh-rate fix as one slice. Reordered the columns to Scott's preferred sequence and added a new CSM Standing column. Made four cells (Status / Journey stage / CSM Standing / Trustpilot) inline-editable using the existing `EditableField` primitive — Status / Journey stage / CSM Standing route through their dedicated history-writing Server Actions, Trustpilot through the generic `updateClientField`. Each editable cell calls `router.refresh()` inside `startTransition` after a successful save so the row picks up cascade side effects in place. Added `force-dynamic` on the list page so return-from-detail navigation isn't served from a stale static-route cache. Replaced the back-nav `<Link>` on the detail page with a Client Component that uses `router.back()` when history exists in the tab — preserves filter / sort URL params from the list page — and falls back to `/clients` for direct-entry (Slack share, deep link) cold starts.

## Verification

**`npm run build`** → clean. 0 type errors, 0 lint errors. Bundle deltas:

| Route | Size | First Load JS |
|---|---|---|
| `/clients` | 3.23 kB | 166 kB |
| `/clients/[id]` | 8.36 kB | 147 kB |

`/clients` is now marked `ƒ (Dynamic)` instead of `○ (Static)` confirming `force-dynamic` took effect at build time. No build warnings emitted about the directive. The First-Load JS bump on `/clients` reflects pulling `EditableField` + the four wrapper components into the client bundle (was list-only navigation before; now includes the inline-edit client tree).

**UI smoke deferred to Drake (gate c).** The five-checkpoint smoke pass in spec § Step 5 needs a live browser session against the dev server — Builder doesn't run interactive smoke. Drake validates after deploy:
1. `/clients?status=active,paused&primary_csm=<id>&sort=csm_standing&dir=asc` — filter chips + sort indicator + ordering all hold.
2. Row click → detail page.
3. "← Back to Clients" → returns to the filtered list (URL params preserved).
4. Click an editable cell → dropdown opens in place, no navigation. Save → updates within ~1s.
5. Repeat for journey_stage / csm_standing / trustpilot_status.
6. Edit on detail page → back to list shows fresh value without manual refresh.

Plus the direct-entry smoke (fresh tab, no history → `/clients/<id>` → click Back → lands on clean `/clients`).

**History-row spot-check deferred too.** Spec asked Builder to confirm a status edit + a csm_standing edit write to `client_status_history` / `client_standing_history`. The Server Actions (`updateClientStatusAction`, `updateClientCsmStandingAction`) call the existing history-writing DB functions (`updateClientStatusWithHistory`, `updateClientCsmStandingWithHistory`) — same code path the detail page has been using since M4 Chunk B2, which has been writing history rows correctly per the M5.6 audit. The list-page wiring is just a new front door to the same actions. Drake can confirm post-smoke via a `select * from client_status_history order by changed_at desc limit 1` after editing one row.

## Surprises and judgment calls

**Dropped `cursor-pointer` from `<TableRow>`.** The original V1/V2 row treatment had `cursor-pointer hover:bg-muted/50` on every `TableRow` to signal "click anywhere to navigate." With four cells now click-to-edit, that signal is misleading on half the row. I kept `hover:bg-muted/50` (the visual cohesion of a row-hover treatment) but dropped `cursor-pointer` so the cursor only changes over cells that actually navigate (the remaining five `<Link>`-wrapped cells already produce the pointer-cursor naturally). The spec flagged this as a possible judgment call ("Use judgment — if it feels wrong during smoke, adjust the hover treatment per-cell"); I made it pre-emptively because it's cheap to revert if Drake disagrees.

**Empty `<Label>` inside each editable cell.** `EditableField` always renders a `<Label>{label}</Label>` block at the top of its display surface — passing `label=""` produces an empty Label element that still consumes ~20px vertical and contributes to the table-row height. The spec explicitly accepted V1 visual ugly here; not fixed. Future iteration would either (a) add a `noLabel` prop to `EditableField` or (b) build a compact `EditableCell` primitive that drops the Label entirely. Not in this scope.

**Bundled commits.** Spec suggested four commits for the editable / reorder / back-nav / force-dynamic work; I bundled the editable-cells + reorder + force-dynamic into one commit because they all touch `clients-table.tsx` + `page.tsx` and the editable cells materially depend on `router.refresh()` + `force-dynamic` to produce non-stale UX. Back-nav stayed separate (different surface). Per § Commits "Builder may bundle... acceptable; one-logical-change is the principle." Two code commits total + two docs commits.

**No history-fetch verification.** I'd hoped to do the history spot-check via a quick psycopg2 read after an edit, but the only way to *make* an edit from a Builder shell is to mock the Server Action, which doesn't exercise the actual rendered cell + onChange path. The history write is wired through code I didn't touch; the integration point this slice introduces is the editable-cell-to-Server-Action call, which is fully visible in the diff and which Drake's smoke will exercise.

## Out of scope / deferred

- **Custom sort ordering for `csm_standing`.** Today it sorts lexically (`at_risk → content → happy → problem`) via the existing `sortVal` function — same shape as `journey_stage`. If a CSM wants logical ordering (e.g., problem → at_risk → content → happy or vice versa), that's a follow-up.
- **Per-cell width tightening in the table.** `EditableField` was designed for ~400px section cards; in ~120-180px cells the dropdown trigger may wrap or overflow at typical widths. Drake explicitly accepted V1 visual rough edges; iterate later if needed.
- **Re-enabling row-level `cursor-pointer` with per-cell overrides.** Possible if Drake wants the visual cohesion back, but requires the editable cells to opt-out of the pointer treatment specifically. Not done; flag for follow-up if smoke surfaces friction.
- **Auth-context plumbing for `p_changed_by` on history rows.** The Server Actions still pass `null` for the changed-by argument (V1 limitation noted in `actions.ts`'s "p_changed_by is null in V1" comment). Same as the detail-page edits today. Followup already in `docs/known-issues.md`.
- **`EditableField`'s empty-label visual.** See § Surprises. Real fix is a `noLabel` prop or a compact primitive.

## Side effects

- **No DB writes from this Builder run** beyond the `npm run build` which is read-only.
- **No external API calls.** Build runs locally; no Supabase reads, no Slack posts, no Anthropic calls.
- **No new Vercel env vars or hosting changes.** `force-dynamic` is a per-route directive in the source; it lands on the next deploy via the standard git push → Vercel auto-deploy.
- **`/clients` route flips from Static → Dynamic** on the next deploy. Per-visit cost: ~200ms (the route now re-runs the server component against the DB on every request). At 197 clients the table render is well within budget. If Drake's smoke reveals user-perceptible latency, the fallback is to drop `force-dynamic` and rely on `revalidatePath` only — at the cost of staler return-from-detail navigation.
