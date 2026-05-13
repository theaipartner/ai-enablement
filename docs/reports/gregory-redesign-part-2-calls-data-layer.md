# Report (PARTIAL): Gregory Redesign Part 2 — Calls data layer (pre-design)
**Slug:** gregory-redesign-part-2-calls-data-layer
**Spec:** docs/specs/gregory-redesign-part-2-calls-data-layer.md
**Status:** halted — spec § Hard stops point 2 fired: no CSM column on `clients`; CSM is a join-table relationship via `client_team_assignments`.

## Files touched

None. Halted at acclimatization before any code change.

## What I did, in plain English

Walked the spec's acclimatization checklist against the live codebase. Read `lib/db/calls.ts` (the data layer this spec extends), `lib/db/clients.ts` (the parallel CSM-bearing data layer), `docs/schema/clients.md` (column-level schema), `agents/call_reviewer/persistence.py` + `reviewer.py` (the call-review write path), and `shared/claude_client.py` (the Haiku client signature). Confirmed four of the five acclimatization bullets cleanly. The fifth — drift between spec and codebase — surfaced a non-trivial mismatch on the CSM data model that fires spec § Hard stops point 2, so I'm stopping per the protocol.

## Verification

None. No code changed.

## Surprises and judgment calls

### Major drift — CSM data model

The spec assumes `clients.csm_team_member_id` (or similar FK column) holds the CSM-on-a-client relationship. **That column does not exist.** `docs/schema/clients.md` lines 11–30 enumerate every column on `clients`; there is no CSM FK. The CSM relationship lives in the **`client_team_assignments` join table** with `role='primary_csm'` and `unassigned_at IS NULL`.

The existing precedent for resolving this is in `lib/db/clients.ts:240-302`. `getClientsList`'s nested select pulls `client_team_assignments` alongside the client row, then derives `primary_csm_id` / `primary_csm_name` in JS by finding `assignments.find(a => a.role === 'primary_csm' && a.unassigned_at === null)`.

The spec's three CSM-related success criteria (§ D CSM data layer extensions, § E CSM filter) all assume the FK-column model. Specifically:

- § D option (i)'s nested select `csm:team_members!clients_csm_team_member_id_fkey(full_name)` won't work — the FK constraint name doesn't exist.
- § E's "filter the result rows to those whose `primary_client.csm_team_member_id` equals the filter" needs to be reworded around `client_team_assignments`.

Per spec § Hard stops point 2 ("If there's no CSM column at all on `clients`, **stop and surface** — the entire CSM column + filter premise of this spec depends on it"), this is the explicit halt trigger.

### Minor drift — call_reviewer doc location

Spec § G says "update `docs/agents/call_reviewer/` (whatever the agent doc is named)." That directory doesn't exist. `docs/agents/` contains `ella/` and `gregory.md` — call_reviewer has no dedicated doc surface today. Resolution needs Drake's call: extend `gregory.md`, create a new `docs/agents/call_reviewer.md`, or skip the doc update on the basis that there's nowhere natural to put it.

### Confirmed cleanly (acclimatization (a)–(d), modulo (a))

- **(b) Call-review generation chokepoint:** `agents/call_reviewer/persistence.py:upsert_call_review` is the single place the `documents.metadata` dict is constructed (lines 74–81). Two production callers — `scripts/backfill_call_reviews.py:174` and `ingestion/fathom/pipeline.py:1062` — both route through it. Hooking the sentiment classifier inside `upsert_call_review` before `validate_document_metadata` is the clean single-chokepoint injection the spec asks for; satisfies spec § C and dodges § Hard stops point 4.
- **(c) Classifier plan:** use the spec's prompt verbatim. Call via `shared.claude_client.complete(system="", messages=[{"role":"user","content":prompt}], model="claude-haiku-4-5-20251001", max_tokens=10)`, parse `.text`, lowercase + strip, match against `{green, yellow, red}`, fall back to `yellow` on miss. No `run_id` (utility scope per spec § A). The 5-sample sanity check from § Hard stops point 3 runs before declaring the work done.
- **(d) File map (pending CSM resolution):**
  - `agents/call_reviewer/sentiment_classifier.py` — new
  - `agents/call_reviewer/persistence.py` — modified (hook + metadata injection)
  - `scripts/backfill_sentiment_tiers.py` — new
  - `lib/db/calls.ts` — modified (CSM fields + filter, action items not here — see § F path)
  - `app/(authenticated)/calls/[id]/action-item-actions.ts` — new (three server actions per § F)
  - `docs/schema/documents.md` — modified (sentiment_tier note)
  - `docs/agents/...` — pending Drake's call per the minor drift above

## Out of scope / deferred

The entire spec body remains untouched. On unblock, work proceeds top-to-bottom: classifier → backfill script → pipeline hook → CSM data layer + filter (using whichever model Drake picks) → action-item server actions → doc updates.

## Side effects

None. No commits, no DB writes, no API calls, no shared-system touches. Read-only acclimatization.

## What's needed to unblock

Drake's call on the CSM data model. Three reasonable paths:

- **Option A — Mirror `getClientsList`'s join-table pattern (recommended).** Extend the `getCallsList` nested select to also fetch the primary client's `client_team_assignments(role, unassigned_at, team_members(id, full_name))`, derive `csm_team_member_name` in JS the same way `lib/db/clients.ts:240-302` does. `getCallById` gets a parallel fetch under the existing `Promise.all`. `csm_id` filter runs in-JS post-fetch (matches the existing search filter pattern). Pros: zero schema change, mirrors a battle-tested pattern, doesn't gum up future CSM-history work. Cons: spec § D option (i)'s nested-FK syntax doesn't apply; effectively D option (ii)-shaped via a different join.

- **Option B — Add a denormalized `clients.primary_csm_team_member_id` column (migration).** Updated by the same RPCs that mutate `client_team_assignments` (`change_primary_csm`, per `lib/db/clients.ts:646`). The spec's nested-FK syntax then works as written. Pros: matches the spec literally. Cons: introduces a denormalization that has to stay in sync with the assignments table forever; requires a migration in this spec which the spec doesn't currently scope; SQL-review gate (Drake) fires on the migration.

- **Option C — Defer CSM bits, ship sentiment + action-item-actions only.** Drop § D, § E from this spec; sentiment classifier + backfill + pipeline hook + the three action-item server actions still ship. CSM lands in a follow-up spec once the data model is settled. Pros: ships the uncontroversial half today. Cons: the follow-up UI spec (after Design returns mocks) likely wants both CSM-on-list and CSM-filter; deferring forces a second round trip.

My lean: **Option A.** The join-table model is the right long-term shape (matches the historical-CSM-assignments use case that motivated `client_team_assignments` originally), `lib/db/clients.ts` already proves the pattern works at the current volume, and the in-JS `csm_id` filter aligns with the spec's stated tolerance for in-JS filtering at 560 calls. No schema change, no migration, no SQL-review gate hit, no follow-up spec needed.

Secondary unblock: pick a target doc for the call_reviewer addition per § G — extend `gregory.md`, create `docs/agents/call_reviewer.md`, or skip. (Low stakes; can be answered in the same message as the CSM call.)
