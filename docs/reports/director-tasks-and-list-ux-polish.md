# Report: Director task page + Slack column conditional rendering + sticky list filters

**Slug:** director-tasks-and-list-ux-polish
**Spec:** docs/specs/director-tasks-and-list-ux-polish.md

## Files touched

**Created**
- `supabase/migrations/0036_director_tasks.sql` — new table with FK CASCADE to team_members + per-user `(team_member_id, created_at DESC)` index.
- `app/(authenticated)/tasks/layout.tsx` — creator-tier gate (mirrors Ella sub-layout). Preview-bypass branch preserved.
- `app/(authenticated)/tasks/page.tsx` — Server Component fetches current user's tasks + composes `HeaderBand` + `TaskList`.
- `app/(authenticated)/tasks/actions.ts` — three Server Actions (`addTaskAction` / `toggleTaskDoneAction` / `deleteTaskAction`) all self-checking creator-tier + task ownership.
- `app/(authenticated)/tasks/task-list.tsx` — Client Component with add input + open / done sections + per-row delete. Optimistic UI via `useTransition` + `router.refresh()`.
- `app/(authenticated)/calls/[id]/back-to-calls-button.tsx` — new Client Component mirroring the Clients Back button (extracted from the inline Link in calls/[id]/page.tsx). Reads `from` searchParam + validates it starts with `/calls` + falls back to bare `/calls`.
- `docs/schema/director_tasks.md` — schema doc.
- `docs/runbooks/director_tasks.md` — operational guide + manual-SQL recovery patterns.

**Modified**
- `app/(authenticated)/clients/[id]/back-to-clients-button.tsx` — converted from a plain Server Component Link to a Client Component reading `useSearchParams`. Validates `from` starts with `/clients` (and not `//`) to prevent open-redirect. Falls back to bare `/clients`.
- `app/(authenticated)/clients/clients-table.tsx` — new `showSlackColumn: boolean` prop. Filters `COLUMNS` + wraps the slack `<td>` in a conditional gate so the table renders the pre-Slack-column visual when neither relevant filter is active. Row links append `?from=<encoded list path+query>` so the detail page's Back can restore the same filtered view.
- `app/(authenticated)/clients/page.tsx` — threads `showSlackColumn={filters.needs_review || filters.missing_slack}` down to the table.
- `app/(authenticated)/clients/filter-bar.tsx` — Clear button renamed "Clear filters". Now preserves the `q` (search) param in addition to `sort`/`dir`. Spec § Piece 3: "search is a different concern from filters."
- `app/(authenticated)/calls/calls-filter-bar.tsx` — new "Clear filters" button (previously absent on Calls). Visible when client OR csm filter is set; clears both while preserving `q`/`sort`/`dir`.
- `app/(authenticated)/calls/calls-table.tsx` — row links append `?from=<encoded list path+query>` matching the Clients pattern.
- `app/(authenticated)/calls/[id]/page.tsx` — replaced the inline Back link with `<BackToCallsButton />`. Kept the `Link` import since the page still uses it for the participant link.
- `components/top-nav.tsx` — new "Tasks" NAV_ITEM with `requiredTier: 'creator'`. `isActive` prefix-matches `/tasks`.
- `lib/supabase/types.ts` — `director_tasks` Row/Insert/Update interfaces + the FK Relationships entry.
- `docs/state.md` — new top-line entry under "Gregory editorial skin shipped"; migration count bumped 35 → 36; latest-migration paragraph updated.

## What I did, in plain English

Three small UX pieces shipped together because they share the same risk profile and timing.

The Director task page at `/tasks` is the meaningful new surface — a single-user creator-gated personal task list. Migration 0036 adds the `director_tasks` table; the sub-layout gates the route to creator-tier (mirrors the Ella admin gate); three server actions handle add/toggle/delete with both creator-tier and task-ownership checks; a Client Component renders the add input + a list split into open and done sections with strike-through styling on completed items. TopNav gains a "Tasks" entry visible only to Drake. The page intentionally has zero edit-in-place affordance and no recurring/categorization features — delete and re-add is the V1 path per spec.

The conditional Slack column on `/clients` reverts the table to its pre-Slack-column visual layout when neither the `needs_review` nor `missing_slack` filter is active. The column reappears when either is on; the filter chips themselves stay always-visible. Detail page `/clients/[id]` continues to show missing-Slack pills unconditionally because that's a different concern (you're on a client's page; you always want to know about Slack hygiene).

Sticky filters work via a `?from=<encoded list path+query>` parameter the list page row links append to each detail-page link. The detail page's Back button reads `from`, validates it starts with the correct list prefix (defense against open-redirect), and falls back to the bare list if anything's off. Both Clients and Calls got this treatment — Calls also got a Clear-filters button that wasn't there before (mirror of the Clients pattern). Existing Clients "Clear" button was renamed to "Clear filters" and now preserves the search query alongside sort/dir — search is a different concern from filters per the spec.

## Verification

- **Migration applied + dual-verified** post-apply: table present (`to_regclass` returned `director_tasks`), all 6 columns with the right defaults, 2 indexes (`director_tasks_pkey` + `director_tasks_team_member_created_idx`), FK constraint with `ON DELETE CASCADE`, ledger has `0036`, public table count 25 → 26 as expected.
- **`pytest tests/`** → 575 passed, 0 failed. Unchanged from pre-spec; the only Python touched was the migration file (not under tests/) and the spec is otherwise pure-TS.
- **`npx tsc --noEmit`** → clean.
- **`npm run lint`** → "No ESLint warnings or errors."
- **No live DB writes from this session** beyond the schema migration. The page won't insert/update/delete rows until Drake (or a creator-tier preview user) actually opens it and types.

Production validation is gate (c) — Drake visits `/tasks` post-deploy, confirms (a) other tiers redirect away, (b) add/toggle/delete works, (c) the conditional Slack column behaves correctly on `/clients` (toggling Needs review or Missing Slack filter shows/hides it), (d) clicking into a client with filters applied then clicking Back lands on the same filtered view, (e) same flow on `/calls`, (f) Clear filters button works on both lists and preserves the search query.

## Surprises and judgment calls

- **Spec said "preserve sort/dir" on the Clients clear** but the existing code already did that; what was missing was preserving the search query. I read the spec lean ("preserve search since search is a different concern from filters") as the actual directive and extended the existing `clearAll` to keep `q` alongside `sort/dir`. The Clear-filters button is visible when `hasAnyFilter` is true (which includes `searchValue.length > 0`), so after clearing, the button can remain visible because of a leftover search — clicking it again is idempotent. Acceptable in V1.
- **Calls filter-bar's `hasAnyFilter` was derived ad-hoc** (just `activeClientId !== '' || activeCsmId !== ''`) — the Clients version has the same concept but spread across many `*Selected.length > 0` checks. Simpler on Calls because there are only two filters today.
- **Back button validation rejects `//` prefix** in addition to checking startsWith. `//evil.com/path` would pass `startsWith('/clients')` if I only checked the prefix. Both Back buttons now reject anything starting with `//` as a defense.
- **The IIFE around `rows.map`** in both tables is the cleanest way to compute `fromParam` once per render without pulling extra prop drilling. Alternative was to compute it outside the JSX and pass into the map; that mostly trades a closing `})()}` for cleaner JSX. Kept the IIFE for surface-locality.
- **`BackToClientsButton` became a Client Component**, where it used to be a Server Component. Spec offered both options; the Client Component path is simpler — reads `useSearchParams` directly without prop drilling. Same for the new Back-to-Calls.
- **Calls detail page kept the `Link` import** even though the inline Back-to-Calls link was replaced. The page still uses `Link` for the participant link further down. Worth flagging because the diff might look like an unfinished cleanup.
- **No `updated_at` column on `director_tasks`** — spec didn't ask for one. The page renders open by `created_at` and done by `done_at`; no third-axis lifecycle column needed. If a future "last edited" view ships, add the column then.
- **Spec called out "edit-in-place for task titles" as Out of Scope** — V1 is delete + re-add. Worth knowing because the first usability complaint will probably be about this.
- **Task UI uses raw inputs + buttons**, not the existing `Button` / `Input` from `@/components/ui/`. The shadcn `Input` doesn't fit the editorial chrome perfectly here and the inline shape (single input → press Enter to submit) feels lighter without a wrapping form Button. Spec didn't pin which primitives to use.
- **The conditional Slack column comments out (filters out) the COLUMNS array entry** rather than dropping the COLUMNS definition. Keeps the column metadata available if a future spec wants to reactivate it without touching the source. Minor footprint cost (~0 — JS engines optimize this away).

## Out of scope / deferred

- **Recurring tasks, categorization, due dates, assignment-to-others, in-place edit** — all explicit V2 per spec. Future task ergonomics work.
- **Per-user task pages for other tiers** — the schema supports it (keyed by team_member_id), the layout doesn't. Future spec.
- **Slack-column conditional on the detail page** — spec said don't. Detail page always renders the missing-Slack badges when applicable.
- **Cross-session filter persistence** — spec said don't (no localStorage). URL params only.
- **Sort/filter persistence on `/teams`, `/ella/runs`, `/tasks`** — the sticky-filter pattern only applied to `/clients` and `/calls`. Other lists are smaller-scope or don't benefit; if Drake wants the pattern extended, future tweak.

## Side effects

- **Three commits pushed to `main` this turn** plus the report commit after this writes: `e2d15b5` (migration), `d2e8226` (tasks feature), `bdc7b73` (list UX), `9cec7a6` (docs).
- **Cloud database mutated**: migration 0036 applied; `director_tasks` table now exists permanently. No rows seeded; first row lands when Drake adds a task via the dashboard.
- **No real Slack posts, no DMs, no external API calls.**
- **Vercel auto-deploys on push.** Post-deploy:
  - Drake visiting `/tasks` for the first time sees an empty list with the add input.
  - `/clients` table reverts to the 9-column visual unless a Slack-related filter is active.
  - All `/clients/[id]` and `/calls/[id]` row links now carry `?from=…` query strings — bookmarks to historical detail-page URLs without the param still work (Back falls back to bare list).
  - "Clear filters" button on `/calls` is new; on `/clients` it preserves search behavior.

## What's needed for production validation (gate (c))

1. Drake logs in as creator and visits `/tasks` — sees an empty list + add input.
2. Adds three tasks → appears in open-by-created-at-desc order.
3. Toggles one done → strikes through + moves to done section.
4. Deletes one → vanishes.
5. Logs out, logs in as a non-creator (Nabeel or Scott) — TopNav has no "Tasks" link, direct visit redirects to `/clients?error=insufficient_access`.
6. On `/clients`, apply the Needs review filter → Slack column appears. Remove it → column disappears.
7. On `/clients` with filters active, click into a client → click Back → lands on the same filtered view.
8. On `/calls` with a client filter active, click into a call → click Back → lands on the same filtered view.
9. Click "Clear filters" on both lists with search active → search input keeps its value while filter chips empty out.
