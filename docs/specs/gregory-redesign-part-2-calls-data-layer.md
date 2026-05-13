# Gregory Redesign Part 2 — Calls data layer (pre-design)
**Slug:** gregory-redesign-part-2-calls-data-layer
**Status:** in-flight

## Context

The Calls pages (`/calls`, `/calls/[id]`) are being redesigned as part of Part 2. Drake is iterating on the visual design with Claude Design in parallel. This spec lands everything Code can build *without* the visual mocks — the data layer, server actions, sentiment classifier, and supporting types. A follow-up spec, written after Design returns mocks, will wire the UI on top of this foundation.

The split exists because Code execution against design tokens / pixel layouts has been unreliable in this branch. Shipping the non-visual pieces first means the follow-up spec is a UI-wiring exercise against an already-shipped data layer — narrower scope, less translation work, fewer chances to drift.

**Stacks on the existing `gregory-redesign-part-1-foundations` branch.** Same PR.

## What this spec does NOT do

- Does not change any existing page layout, JSX structure, or visual styling.
- Does not introduce the gold accent color.
- Does not remove or reorder columns on the list page.
- Does not restructure the detail page.
- Does not add the "Filter by CSM" UI control.
- Does not surface the new sentiment field anywhere visually.

Those are all the follow-up spec's job. **If you find yourself touching JSX in `app/(authenticated)/calls/`, stop — you've drifted out of scope.**

## What this spec DOES do

1. Adds the sentiment classifier — a Python script + ongoing pipeline hook that reads `documents.content` (the JSON-serialized `call_review`) for `call_review` documents, runs Haiku over the `sentiment_arc` field, classifies as `green` / `yellow` / `red`, and writes the result to `documents.metadata.sentiment_tier`.
2. Backfills sentiment over every existing `call_review` document.
3. Extends the calls data layer to surface CSM (the team member assigned to the primary client) on both list and detail.
4. Adds a `csm_id` filter to `CallsListFilters` and its SQL filter path. (UI control deferred to follow-up.)
5. Adds server actions for editing an action item's description text, deleting an action item (hard delete), and committing a batch of pending edits with a redirect target.
6. Adds the data layer for the "Confirm" button flow: a server action that takes a list of pending edits + deletes, applies them in a transaction, and returns a redirect target (the primary client's detail page URL).

## Reference reads (in this order)

1. `docs/gregory-conventions.md` — Part 1 conventions, especially the inline-editable contract (Decision 6: optimistic update, on-blur persist, inline error tooltip, no row-level Save button).
2. `app/(authenticated)/calls/page.tsx`, `calls-table.tsx`, `calls-filter-bar.tsx`, `[id]/page.tsx`, `classification-edit.tsx` — current call pages. **For context only.** Do not modify them.
3. `lib/db/calls.ts` — calls data layer. Extending this is most of the spec.
4. `docs/schema/clients.md` — find the column that names the CSM for each client. Likely `csm_team_member_id` or similar (see `lib/db/clients.ts` for parallels).
5. `docs/schema/documents.md` — `call_review` document shape. Sentiment lives in `metadata.sentiment_tier` (Decision 7 of Part 1, the documents-metadata path).
6. `agents/call_reviewer/` — Python pipeline that generates call reviews. Where the sentiment-classifier hook lives.
7. `shared/claude_client.py` — Haiku client. The sentiment classifier uses this.
8. `lib/db/merge.ts` — `listMergeCandidates` is the existing "all clients dropdown" data-fetch the call filter bar already uses; not relevant directly but worth knowing as a parallel.

**Acclimatization checkpoint:** before writing any code, confirm in 4–5 bullets in your first commit message: (a) the exact column name on `clients` that holds the CSM team member ID (verify by reading `lib/db/clients.ts` or `docs/schema/clients.md`), (b) the file path + class/function name where call reviews are generated today, (c) your plan for the Haiku classifier prompt (one short paragraph asking Haiku to classify a sentiment arc as `green`, `yellow`, or `red`), (d) the file map you intend to touch (Python + TypeScript), (e) any unexpected drift between this spec and what you find in the codebase. If (e) is non-trivial, surface to Drake before continuing past the first commit.

## Decisions locked in by Director

From Drake/Director conversation 2026-05-13. Build to these.

1. **Sentiment tier lives in `documents.metadata.sentiment_tier`** for `call_review` rows. Values: `'green' | 'yellow' | 'red'` (or absent for unclassified). No new column, no migration.

2. **Sentiment classifier uses Haiku (`claude-haiku-4-5-20251001`) with a soft prompt.** Drake's call: don't over-spec the classification rubric — Haiku is good enough at sentiment classification that a one-paragraph prompt produces consistent results. Sentiment is for visual display only, not for filtering at scale, so prompt-level consistency matters more than precise rubric calibration.

3. **CSM data is sourced from `clients.csm_team_member_id`** (or whatever the exact column name is — Builder verifies in acclimatization point a). The CSM on a call = the CSM assigned to the call's `primary_client`. Calls with no `primary_client_id` have no CSM (display as null/blank on the UI side; data layer returns null).

4. **`csm_id` filter on the list:** when set, return only calls whose `primary_client`'s `csm_team_member_id` matches. SQL filter joins through `clients`.

5. **Action item edits are server actions, not REST endpoints.** Pattern matches the existing `updateCallClassification` in `lib/db/calls.ts`. Each action returns a typed result `{ success: true } | { success: false, error: string }`.

6. **Hard delete for action items** per Drake's call. `delete from call_action_items where id = $1`. No soft delete, no audit row. The user-facing flow is: click X, gone. If undo becomes important later, it's a future spec.

7. **The Confirm flow is a single server action** that takes a list of pending edits + a list of pending deletes + a call ID, applies them all in sequence (no transaction wrapper — they're independent rows), and returns the URL to redirect to: `/clients/{primary_client_id}` for the call. If `primary_client_id` is null (shouldn't happen for client calls in the new UI, but defensive), return `/calls` as the fallback redirect.

8. **Sentiment classifier runs in two contexts:** (a) a one-time backfill script that iterates every existing `call_review` document, classifies each, updates metadata; (b) a hook in the Python call-review pipeline so new reviews get classified at generation time. Both call the same classifier function.

## What success looks like

### A. Sentiment classifier (Python)

Create `agents/call_reviewer/sentiment_classifier.py` (or equivalent path matching existing Python conventions in this repo):

- **Function:** `classify_sentiment_tier(sentiment_arc: str) -> str` — returns one of `'green'`, `'yellow'`, `'red'`.
- **Implementation:** calls `shared.claude_client.complete(...)` with `model='claude-haiku-4-5-20251001'`, `max_tokens=10` (small ceiling — output is one word), prompt below. Parses the response strictly: lowercase, strip, check against the three valid values; if anything else comes back, log a warning and return `'yellow'` as a safe middle default.
- **Prompt** (soft, per Decision 2):

  ```
  Classify the sentiment of this call summary as one of: green, yellow, or red.
  
  Green = the call went well, the client relationship is healthy, momentum is building.
  Yellow = mixed signals, some friction or concern surfaced but the relationship is intact.
  Red = the call went poorly, the client is frustrated, the relationship needs attention.
  
  Respond with only the word: green, yellow, or red.
  
  Sentiment arc:
  {sentiment_arc}
  ```

- **No `run_id` parameter required** — these calls are utility-scoped, not user-facing agent runs. Cost is rolled into the call-review pipeline's existing cost-attribution path if it cares, or accepts as untracked otherwise. Builder's call.

### B. Backfill script

Create `scripts/backfill_sentiment_tiers.py` (or equivalent):

- Query: select every `documents` row where `document_type='call_review'` AND `metadata->>'sentiment_tier' IS NULL`.
- For each row: parse `content` as JSON, extract `sentiment_arc` field, call `classify_sentiment_tier`, write the result to `metadata.sentiment_tier` (merge into existing metadata, don't overwrite).
- Update path: `documents.metadata = metadata || jsonb_build_object('sentiment_tier', <result>)` so other metadata keys are preserved.
- Logging: print one line per row (`call_id`, classification, latency). Print a summary at the end (total rows processed, tier counts).
- Idempotent: rerunning skips rows that already have `sentiment_tier` set. If Drake wants to reclassify, he can clear the field manually.
- **Drake runs this once after the spec ships.** Builder doesn't run it in CI. The script is committed to the repo for future re-runs if needed.

### C. Ongoing pipeline hook

In whatever file generates call reviews (Builder finds via acclimatization point b — likely `agents/call_reviewer/persistence.py` or `agents/call_reviewer/agent.py`):

- After the `call_review` JSON is constructed and before it's written to `documents`, call `classify_sentiment_tier(review['sentiment_arc'])` and inject `sentiment_tier: <result>` into the `metadata` field of the document being written.
- If the classifier call fails (network error, Haiku timeout, malformed response), log a warning and proceed without the field. The review still writes; sentiment is "for show," not load-bearing.

### D. CSM data layer extensions (`lib/db/calls.ts`)

**On `CallsListRow`:** add field `csm_team_member_name: string | null`.

**In `getCallsList`:** extend the nested select to include the CSM through the primary client. Two options:

- **(i)** Nest the team_members fetch under the existing `primary_client` join: `primary_client:clients!calls_primary_client_id_fkey(id, full_name, csm:team_members!clients_csm_team_member_id_fkey(full_name))`. Most idiomatic to PostgREST. Confirm the FK constraint name by reading the schema doc / migration files.
- **(ii)** Separate query post-hoc batching by CSM ID. More queries, simpler joins. Use only if (i) doesn't work cleanly.

Builder's call. Document choice in Surprises.

**On `CallDetail`:** add field `csm_team_member: { id: string; full_name: string } | null`.

**In `getCallById`:** fetch the CSM analogously. Can be a separate parallel fetch in the existing `Promise.all`, or nested under the primary client fetch — Builder's call.

### E. CSM filter (`lib/db/calls.ts`)

Add `csm_id?: string` to `CallsListFilters`.

In `getCallsList`, when `filters.csm_id` is set, filter the result rows to those whose `primary_client.csm_team_member_id` equals the filter. **The filter can happen in-JS post-fetch** (the existing code already filters search in-JS); doing it server-side via PostgREST requires nested filtering which gets ugly. In-JS is fine at current volume (560 calls).

Document the in-JS filter pattern in Surprises if it ends up being meaningfully slower than expected.

### F. Action item edits (server actions)

Create `app/(authenticated)/calls/[id]/action-item-actions.ts` (or wherever the existing server actions for this route live — match the existing pattern).

**Server action 1: `updateActionItemDescription`**

```typescript
async function updateActionItemDescription(
  itemId: string,
  newDescription: string,
): Promise<{ success: true } | { success: false; error: string }>
```

- `UPDATE call_action_items SET description = $1 WHERE id = $2`.
- Whitespace-trim the input. If trimmed input is empty, return `{ success: false, error: 'Description cannot be empty' }` — don't write.
- No history row (call_action_items don't have an audit log today).

**Server action 2: `deleteActionItem`**

```typescript
async function deleteActionItem(
  itemId: string,
): Promise<{ success: true } | { success: false; error: string }>
```

- `DELETE FROM call_action_items WHERE id = $1`. Hard delete per Decision 6.
- No history row.

**Server action 3: `commitPendingActionItemChanges`**

```typescript
async function commitPendingActionItemChanges(
  callId: string,
  edits: Array<{ itemId: string; newDescription: string }>,
  deletes: string[],
): Promise<{ success: true; redirectUrl: string } | { success: false; error: string; redirectUrl: null }>
```

- Applies each edit, then each delete, in sequence. If any step fails, stops and returns the first error. Subsequent steps are NOT rolled back — Builder doesn't wrap in a transaction (the rows are independent; partial-apply is acceptable behavior here).
- After all changes apply, fetches the call's `primary_client_id`. Returns `redirectUrl = '/clients/${primary_client_id}'`. If primary_client_id is null, returns `redirectUrl = '/calls'` as fallback.
- Callers (the eventual Confirm button) take the redirectUrl and call Next's `redirect()` — the server action doesn't redirect itself, it returns the target.

### G. Mandatory doc updates

- `docs/schema/documents.md` — add a note documenting the new `sentiment_tier` field in `call_review` metadata. One line under the `call_review` document_type section.
- `docs/agents/call_reviewer/` (whatever the agent doc is named) — short paragraph noting that call reviews now carry a sentiment tier classification at generation time. Reference the classifier function path.
- `docs/state.md` — does not need updating.
- `CLAUDE.md` — does not need updating.
- `docs/gregory-conventions.md` — does not need updating; the sentiment pill primitive ships in the follow-up UI spec, not here.

### H. PR + branch

Same branch (`gregory-redesign-part-1-foundations`), same PR. No PR title change needed; this is a contained data-layer ship in the existing PR.

## Hard stops

1. **Before running the backfill script.** Drake runs it manually after the spec ships. Builder doesn't run it in CI or as part of the spec execution.

2. **If the CSM column name on `clients` isn't what acclimatization point (a) finds.** If `csm_team_member_id` doesn't exist and there's a different name (e.g. `csm_id`, `assigned_csm`, `account_manager_id`), use the actual name. If there's no CSM column at all on `clients`, **stop and surface** — the entire CSM column + filter premise of this spec depends on it.

3. **If the Haiku classifier produces inconsistent output on a sample of 5 real `sentiment_arc` values.** Builder should pull 5 representative `call_review` documents from production and run them through the classifier manually as a sanity check before considering the work done. If 5 out of 5 produce reasonable green/yellow/red outputs, ship. If 2+ produce nonsense (empty strings, multi-word responses, refusals), surface and we tighten the prompt.

4. **If the existing call-review Python pipeline structure doesn't have a clean place to call the classifier** — e.g. the review JSON is constructed in three different files and there's no single chokepoint — surface before forcing the hook in. The classifier should land in one place, not three.

## Think this through yourself — what could go wrong

- **Haiku may refuse to classify edge cases.** A `sentiment_arc` that's empty, very short, or about a topic Haiku interprets as sensitive could trigger a refusal. The classifier's `'yellow'` fallback handles this — refusals get treated as middle-tier. **Mitigation:** the fallback exists. Log refusals separately so Drake can spot a pattern if many calls trigger it.

- **The pipeline hook adds latency to call-review generation.** Haiku at the small-tokens scale here is ~500ms-1s. Acceptable for a cron pipeline; would be unacceptable for a request-time path. Builder verifies the call-review pipeline isn't request-time before adding the hook.

- **The CSM join may surface unexpected null patterns.** If a meaningful number of clients lack a CSM assignment, the new column on the list will show null/empty for those rows. The current schema has CSM as optional per the schema doc. **Mitigation:** the column renders blank — not an error condition. Surface count of null-CSM client calls in Surprises so Drake knows the shape.

- **The `csm_id` filter in-JS may slow page renders** if the data layer post-fetch filter runs over a large result set. 560 calls is fine. If volume grows past ~5000 client calls, switch to server-side. **Mitigation:** documented in code with the same note that already exists for the search filter.

- **`commitPendingActionItemChanges` partial-apply behavior.** If edit #1 succeeds and edit #2 fails, the user lands back on the call page with edit #1 applied and edit #2 not. The Confirm button (in the follow-up UI spec) needs to handle this — it should re-fetch state and show what landed. **Mitigation:** not Builder's concern in this spec. The server action returns the first error and the UI spec handles the partial-success UX.

- **The `documents.metadata` jsonb merge syntax.** PostgREST doesn't have a clean idiomatic way to merge JSON; the cleanest path is reading the existing metadata, merging in JS, writing back. Builder uses whatever the existing pattern in the codebase is (search `metadata` writes elsewhere in `lib/db/` for parallels).

- **Backfill script idempotency.** If the script is interrupted mid-run, rerunning should pick up from where it left off (by virtue of the `IS NULL` filter). Confirm Builder's implementation does this; document in Surprises if there's an edge case (e.g. a row that had its sentiment_tier cleared accidentally — script reclassifies it).

## Out of scope for this spec (explicit)

- **All visual changes to `/calls` and `/calls/[id]`.** Reserved for the follow-up UI spec after Design returns mocks.
- The gold accent color.
- The `<SentimentPill>` UI primitive. Already in `components/gregory/` from Part 1.
- Removing the auth bypass — that's a Drake-side env-var toggle, not a code change.
- The Filter by CSM dropdown UI.
- The Confirm button UI.
- Inline-editable action item rendering (the data layer ships here; the UI ships in the follow-up).
- Removing Confidence / Retrievable columns or any other list-column changes.
- Migrating the calls list/detail to use Part 1 primitives (`<HeaderBand>`, `<EmptyStateAwareSection>`, etc.).
- Tests — deferred to `gregory-ts-test-infra`.
- Anything touching the Ella surfaces.
