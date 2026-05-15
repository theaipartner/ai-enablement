# Report: Lifecycle of auto-created clients

**Slug:** auto-created-client-lifecycle
**Spec:** docs/specs/auto-created-client-lifecycle.md

## Files touched

**Created**
- `app/(authenticated)/clients/[id]/remove-needs-review-button.tsx` — new Client Component. Confirmation-dialog flow ("Mark [Client] as reviewed?") gated on the `needs_review` tag's presence; calls `removeNeedsReviewTagAction` on confirm; `router.refresh` re-renders the page with the button hidden after the tag clears.
- `docs/runbooks/auto_created_client_management.md` — new runbook covering the full lifecycle (auto-create sources, the merge + mark-as-reviewed flows, missing-Slack badges, audit SQL by source + by review state).

**Modified**
- `ingestion/fathom/classifier.py` — `_classify_by_new_convention` now emits `AutoCreateRequest` when no external participant resolves AND at least one external participant exists. Multi-external case: first wins. No-external degenerate case: client + null primary + no auto-create. Distinct `reason="new title convention with unresolved participant"` from the legacy Scott-1:1 path.
- `tests/ingestion/fathom/test_classifier.py` — prior spec's `test_post_cutoff_new_title_with_no_resolvable_client_still_classifies_as_client` flipped to assert auto-create IS emitted (renamed to `..._auto_creates`). +5 new tests: matched-client (no auto-create), multi-external (first wins), no-external (no auto-create), distinct-reason-from-Scott-1:1, pre-cutoff-falls-through-to-prior-cascade.
- `app/(authenticated)/clients/[id]/actions.ts` — new `removeNeedsReviewTagAction` server action: reads tags + metadata, filters `needs_review` from the `tags` column, stamps `metadata.needs_review_cleared_at` ISO timestamp, writes back, revalidates `/clients/[id]` + `/clients`. New `ClientRow` type import for the metadata cast pattern (matches existing `updateClientProfileField`).
- `app/(authenticated)/clients/[id]/page.tsx` — imports `MergeClientButton`, `RemoveNeedsReviewButton`, `MissingSlackChannelPill`, `MissingSlackUserPill`, `listMergeCandidates`. Reads `tags` + computes `needsReview`. Fetches `mergeCandidates` only when `needsReview` is true (saves a round trip otherwise). New action row between the header and the data grid renders when at least one signal is present (needs_review OR missing-channel OR missing-user). Buttons appear under the needs_review gate; pills appear independently.
- `app/(authenticated)/clients/pills.tsx` — new `MissingSlackChannelPill` + `MissingSlackUserPill` named exports wrapping `GegPill` with `warn` tier and fixed labels. Comments call out the read-time computation + independence from `needs_review`.
- `app/(authenticated)/clients/clients-table.tsx` — new `slack` SortKey (not wired to actual sorting; the page's sort whitelist ignores it). New "Slack" column in the COLUMNS array. New `<td>` rendering both warn pills when applicable, em-dash when both fields are present. Imports the two new pill components.
- `app/(authenticated)/clients/filter-bar.tsx` — new `MISSING_SLACK_OPTIONS` toggle constant. New `setMissingSlack(values)` writer. New `missingSlackSelected` reader added to the `hasAnyFilter` predicate so the Clear-filters button surfaces when only this filter is active. New `<MultiSelectDropdown mode="toggle">` rendered after the Needs review filter.
- `app/(authenticated)/clients/page.tsx` — `readFilters` returns `missing_slack: get('missing_slack') === '1'`.
- `lib/db/clients.ts` — `ClientsListFilters` gains `missing_slack?: boolean`. `ClientsListRow` gains `slack_channel_id: string | null`. `getClientsList` adds `slack_channels(slack_channel_id, is_archived, created_at)` to the nested select; per-row pipeline filters to non-archived, sorts by `created_at` desc, picks the head; strips the joined array post-projection. Post-projection JS-filter applies `missing_slack === true`.
- `docs/schema/clients.md` — `metadata` column row gains a known-keys note; new "needs_review lifecycle" section above § Uniqueness with audit SQL split by source.
- `docs/runbooks/call_title_convention.md` — new "Auto-create on new patterns (2026-05-15)" subsection explaining that the new-convention path emits auto-creates again (was retired in the cutoff spec; re-extended here). Points at the new lifecycle runbook.
- `docs/state.md` — new top-line entry under "Gregory editorial skin shipped" describing the full surface.

## What I did, in plain English

Wired four cohesive pieces of the auto-created-client lifecycle. The classifier change reopens the auto-create path for post-cutoff new-convention calls — every "Coaching Call with Scott / Lou / Nico" or "Sales Call with …" with an unresolved external attendee now produces a fresh `clients` row tagged `needs_review`, distinct from the legacy `30mins with Scott` path via a different `metadata.auto_create_reason` string. The pipeline's existing `_lookup_or_create_auto_client` does the email-lookup-then-reactivate-then-insert dance; no pipeline changes needed.

On the dashboard side, three UI surfaces light up. The existing `MergeClientButton` component + server action + `merge_clients` RPC chain were all already shipped from a prior cycle — they just weren't rendered. Path A applied cleanly: render the button on `/clients/[id]` conditionally on `needs_review` membership; fetch merge candidates only in that branch. Next to it, a new "Mark as reviewed" button clears the `needs_review` tag (and only that tag) via a small server action, stamping an audit timestamp on the client's metadata. Both buttons live in a new action row between the page header and the two-column data grid; the row's visibility is gated on needs_review OR the existence of either missing-Slack signal, so default clients don't get an empty band.

The missing-Slack badges are read-time only — two new warn-tier pills (`MissingSlackChannelPill`, `MissingSlackUserPill`) that fire whenever `slack_user_id` is null or no active `slack_channels` row exists for the client. They surface on `/clients/[id]` in the same action row, and on the `/clients` list as a new "Slack" column. A new "Missing Slack" filter chip narrows the list to clients where either field is null. The data layer change was non-trivial: `slack_channel_id` doesn't live on the `clients` table (it's on the joined `slack_channels` rows), so the list query gained a nested join + a JS-side projection that picks the most-recent non-archived channel per client. The `missing_slack` filter applies JS-side after that projection because PostgREST's `.or()` can't span a column-vs-join cleanly.

Tests: +5 classifier cases covering the four new branches in `_classify_by_new_convention` plus a pre-cutoff regression guard. The prior spec's "no auto-create" assertion was flipped to the new "auto-create IS emitted" behavior. Total: 575 pytest passing (was 570), `tsc --noEmit` clean, `npm run lint` clean.

## Verification

- **Pre-existing 41 classifier tests still pass + 5 new tests pass** — `pytest tests/ingestion/fathom/test_classifier.py` → 46 passed.
- **Full suite**: `pytest tests/` → 575 passed, 0 failed.
- **`npx tsc --noEmit`** → clean (one fix-up cycle needed: `ClientsListRow` didn't have `slack_channel_id` until I added the join + projection, and the metadata-Json cast in `removeNeedsReviewTagAction` needed the `as unknown as ClientRow['metadata']` pattern matching the existing `updateClientProfileField`).
- **`npm run lint`** → clean.
- **Data layer change verified by inspection** against `getClientById`'s identical "most recent non-archived" pick in the same file. The two paths share semantics.

Production verification is gate (c) — Drake opens `/clients/[id]` for a known auto-created client (e.g. Nate Fuentes if still in production), confirms both buttons render + the merge flow lands the source archived, opens the list page and confirms the "Slack" column + the "Missing Slack" filter behave as expected.

## Surprises and judgment calls

- **Path A worked cleanly for the merge button** — the existing component, server action, RPC, and `lib/db/merge.ts` all still work end-to-end. The merge_clients RPC validation already enforces "source must be tagged needs_review" so the dialog won't accept an inadvertent merge of a clean client. Zero rewrite cost.
- **Action row visibility includes the missing-Slack signals**, not just `needs_review`. Spec said "render the buttons when `needs_review` is present" but rendering an empty horizontal band below the header for a client that has only missing-Slack badges felt awkward. Merging the two signals into one optional action row keeps the visual rhythm clean while keeping the button gating tight (buttons are inside an inner `needsReview ?` conditional; only the badges appear when needs_review is absent but Slack is broken).
- **`slack_channel_id` isn't a `clients` column** — caught at typecheck time. Spec wrote the filter as `slack_user_id.is.null,slack_channel_id.is.null` against `clients`, which would have failed at runtime against PostgREST. Reworked to a JOIN + JS projection. The data-layer change is the biggest piece of this spec; flagging because future readers reading the spec literally would write a broken query.
- **`tags` is a top-level text[] column**, not `metadata.tags`. The spec said "remove from `metadata.tags`" in places but the pipeline writes `"tags": ["needs_review"]` at the top level. Server action edits the column. Comment in `removeNeedsReviewTagAction` notes the convention. If legacy `metadata.tags` exists on any row, this server action leaves it alone — but `getClientsList`'s needs_review filter and the merge_clients RPC both check the column, so dropping just the column is sufficient for the filter + button gating to clear.
- **No "Missing Slack" sort** — the table's `slack` SortKey exists in the type but doesn't appear in any sort whitelist or comparator. Sorting by warn-pill presence felt low-signal; the filter chip handles the narrowing case. Worth flagging because a future contributor adding pagination or sort might assume it works.
- **`MissingSlackChannelPill` + `MissingSlackUserPill` are two separate components**, not one parameterized pill. Spec called for two distinct labels; named components feel cleaner than `<MissingSlackPill kind="channel" />` for the call site. Both wrap the same `GegPill tier="warn"` primitive.
- **Action row rendered between header and data grid**, not inside the header itself. Header is already a flex layout with status/standing/health pills on the right; adding action buttons there crowds the visual and conflates "this client's current state" (pills) with "actions on this client" (buttons). Separating into rows is more readable.
- **Fetched merge candidates conditionally** — `listMergeCandidates` returns ~134 active clients on every detail page view today. Fetching on every page render for the 99% of clients that don't have `needs_review` is wasted work. The conditional fetch is one of those small optimizations that doesn't show up on a load-time profile today but compounds when the table grows.
- **Test rename felt necessary** — the prior spec asserted "no auto-create" as a positive property, which this spec reverses. Renaming `..._still_classifies_as_client` to `..._auto_creates` makes the test's intent match its behavior. Kept the test in place rather than deleting + adding to preserve git blame.

## Out of scope / deferred

- **No retroactive auto-create.** Forward-only per spec. Historical calls with `primary_client_id=null` stay where they are.
- **No LLM-driven merge target suggestion.** Spec explicitly forbid. The typeahead is plain text matching against `full_name` + `email`.
- **No "Missing Slack" badges feeding back into Ella's retrieval scope.** Spec was about surface visibility; Ella's filter on `is_retrievable_by_client_agents` already covers her safety side.
- **No auto-detection of duplicate auto-creates.** A re-ingested call with an unresolved participant won't double-insert (the pipeline's email lookup is idempotent), but a participant who appears in two completely different calls with two different unresolved emails will produce two auto-created rows. Manual review surfaces this; nothing automated catches it.
- **No bulk "Mark all as reviewed" action.** Per-client today. A future "review queue page" could add bulk affordances when volume justifies.

## Side effects

- **Three commits pushed to `main` this turn** plus the report commit after this writes: `bce5411` (classifier + tests), `a6b59ca` (UI), `2222a8a` (docs).
- **No DB changes.** Pure code + tests + doc spec. No migration. No data mutation. No env vars.
- **No real Slack posts, no DMs, no Google API calls.**
- **Vercel auto-deploys on push.** Post-deploy:
  - Next post-cutoff Fathom webhook delivery with an unresolved external participant will auto-create a `clients` row + the call's `primary_client_id` points at it.
  - Every `/clients/[id]` page render checks `tags` for `needs_review`. The buttons appear only when present.
  - Every `/clients` list render computes the active Slack channel + applies missing-Slack badges + filter.
- **First production interaction with the new buttons** is the live integration test. Drake's gate (c): open an existing auto-created client (or wait for a fresh one), confirm Merge dialog works + Mark-as-reviewed works + missing-Slack badges render on both list and detail.
