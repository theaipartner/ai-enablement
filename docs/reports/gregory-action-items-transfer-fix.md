# Report: Gregory — action items transfer between /calls and /clients
**Slug:** gregory-action-items-transfer-fix
**Spec:** docs/specs/gregory-action-items-transfer-fix.md

## Files touched

**Modified:**

- `lib/db/clients.ts` — in `getClientById`, replaced `.eq('owner_client_id', id)` on the `call_action_items` query with a `calls!inner(primary_client_id)` embedded JOIN filtered by `.eq('calls.primary_client_id', id)`. The action-items result is then mapped to strip the joined `calls` field so the downstream `ActionItem` type stays clean.
- `docs/known-issues.md` — logged a follow-up entry for the parallel bug on `getClientsList`'s open_action_items_count column (same predicate, different code path — out of scope for this spec).

**Created:**

- `scripts/verify-action-items-transfer.ts` — read-only Playwright harness. Walks `/calls` → first call with action items → captures its items → navigates to that call's primary client at `/clients/[id]` → reads the Action items box → cross-checks every call item appears on the client page.

## What I did, in plain English

Hypothesis #2 from the spec was the bug. `getClientById`'s action-items query filtered by `.eq('owner_client_id', id)` — only items where the *client* is the assigned doer. Most action items extracted from coaching calls are owned by a CSM (`owner_team_member_id` set, `owner_client_id` null), so the predicate silently dropped them. The `/calls/[id]` page uses `.eq('call_id', id)` (no owner filter) and showed them all, which is why Drake's "I edited items, hit Confirm, landed on /clients, no items" symptom appeared.

Fix: change the predicate to an inner JOIN through calls + filter by the joined call's `primary_client_id`. Now `getClientById` returns every action item whose source call has the given client as its primary client, regardless of who's assigned to do the work. Drop the joined `calls` field post-query so the `ActionItem` shape passed to the page is unchanged.

The bug isn't a recent regression — git blame on the `.eq('owner_client_id', id)` line shows it existed pre-redesign. Drake's report tied the symptom to yesterday's work, but the predicate has been wrong for longer. The redesign just made the gap visible by surfacing the Action items box prominently on `/clients/[id]`.

The same predicate bug also affects `getClientsList`'s `open_action_items_count` column (`lib/db/clients.ts:183` embeds `call_action_items!call_action_items_owner_client_id_fkey(...)`). Strict-scope per spec Decision 1 (don't refactor beyond the bug) — logged in `docs/known-issues.md` for a follow-up spec.

The `revalidatePath` and Confirm-action paths (hypotheses #1, #3, #4 from the spec) were all correct. The Confirm action already calls `revalidatePath('/clients/${primaryClientId}')` and `revalidatePath('/calls/${callId}')`; the writes happen as advertised; status semantics are consistent (`'open'` everywhere). The bug was 100% in the read path.

## Verification

- **TypeScript** — `npx tsc --noEmit` clean.
- **ESLint** — `npx next lint` clean.
- **Playwright** — `scripts/verify-action-items-transfer.ts` against the preview URL. Two runs total: first hit the older build (deploy still in flight), second captured the fix.

### Final Playwright output

```
[verify] target call: Sunny Ghanathey - Lou - 1 on 1 → /clients/f1ff360c-...
[verify] call action items (3): [
  "Add Huzaifa as GHL admin; add Huzaifa as Google AI Studio collaborator via Cloud Console",
  "Send Sun Google AI Studio collaborator instructions",
  "Reply to Huzaifa in chat; coordinate A2P approval"
]
[verify] client action items (3): [same three, each with "↳ Sunny Ghanathey - Lou - 1 on 1 · 5/13" trail]
[verify] match summary: 3 matched, 0 missed
[verify] ALL call items appear on client page ✓
```

### Screenshots (in `scripts/.preview/`)

- `ai-transfer-call.png` — `/calls/[id]` Action items box on the left column showing 3 items.
- `ai-transfer-client.png` — `/clients/[id]` right-column Action items box showing the same 3 items, each with its source-call breadcrumb.

### Not verified by Playwright

- The Confirm-flow write path (clicking the Confirm button while edits are pending). Confirmed by tracing the code; not exercised in Playwright because it would write to the shared preview Supabase.
- The completion-checkbox regression check from spec § D. Same reason — clicking the checkbox would write `status='done'` to live data. The render path for `'open'` vs `'done'` is unchanged from yesterday (page filters `it.status === 'open'`), so the regression risk is zero from this commit's diff.

Drake's gate (c) covers both manual verifications on the preview: hit Confirm with an edit, then refresh the client page; click a completion checkbox, refresh, confirm the item stays hidden.

## Surprises and judgment calls

- **The bug isn't tied to yesterday's redesign.** Git history shows `.eq('owner_client_id', id)` predates the redesign. The redesign exposed it: the new Action items box on `/clients/[id]` made the missing data visible, where the pre-redesign view either masked it or surfaced the items via a different read path. The bug-was-pre-existing finding doesn't change the fix; calling it out so the timeline reads cleanly.

- **List-page count has the same bug.** `getClientsList` at `lib/db/clients.ts:183` embeds `call_action_items!call_action_items_owner_client_id_fkey(...)` — same logical predicate, different code path. Strict-scope per spec Decision 1; logged in `docs/known-issues.md` rather than fixed here. Drake can spec a follow-up if the under-counted column is biting CSMs.

- **Used `calls!inner(...)` PostgREST syntax for the first time in `lib/db/`.** There's no prior use in this codebase (grep returned zero hits). The syntax does what's needed — embedded JOIN with filter-via-prefix — but if PostgREST quirks surface later (e.g. some Supabase client versions returning the join data as an array instead of an object), the consumer is the inline `.map` that strips the `calls` field. The strip is permissive (`delete rest.calls`) — won't break if the shape changes.

- **The map-and-strip pattern.** I considered three approaches for handling the joined `calls` field that PostgREST attaches to each returned row: (a) cast away in TypeScript and trust downstream consumers don't notice, (b) destructure-then-rest with an unused alias, (c) shallow-copy + delete. Linting rejected (b) (`@typescript-eslint/no-unused-vars` on the `_calls` alias). (c) won — fewer typing gymnastics, runtime is fine.

- **Playwright cross-check via substring matching.** The client page renders each item as the description followed by the source-call line ("↳ <call title> · <date>"). Doing a strict equality check between the call's items and the client's would fail on the trailing call line. I used substring matching on the first 40 characters of each item — robust against the suffix, false positive only if two different items share the same first 40 chars (unlikely with the data shapes here, and the worse failure mode is "both items still need to be visible").

- **Confirm flow's write is correct.** Re-reading `commitPendingActionItemChanges`, I noticed the existing `revalidatePath` calls look right: literal paths with the dynamic UUIDs filled in. Worth flagging because hypothesis #1 in the spec specifically called out `revalidatePath` quirks with dynamic segments — they're a real risk class, just not the issue here.

## Out of scope / deferred

- `getClientsList`'s open_action_items_count column (logged in `docs/known-issues.md`).
- The Confirm-button write-flow regression test (gate (c) manual).
- The completion-checkbox status-flip regression test (gate (c) manual).
- Send-to-Slack server action (separate spec).
- Any change to `/calls/[id]` action items UI.
- Deduplication of identical action items across calls.

## Side effects

- **Pushed to `gregory-csm-visual-fixes` branch** (NOT main, per spec § Hard stop #1). Three commits before this report:
  - `63f8721` — spec cherry-picked from main.
  - `d02af2f` — the fix (lib/db/clients.ts predicate + strip).
  - `f4e58e2` — Playwright harness.
  - `62f6aae` — known-issues entry for list-page count.
- **No DB writes**, no Slack posts, no external API calls. Playwright was read-only.
- **Status flag left `in-flight`.** Same convention call as the previous spec on this branch — Drake merges to main manually; flip is yours during/after.
- **Local working-tree files preserved** from session start: HTMLs, lithium/, fix pics/, scripts/.preview/. Two new PNGs landed in scripts/.preview/.
