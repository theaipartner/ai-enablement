# Gregory — Ella escalation DM body in Output column (followup to pre-redesign fixes)
**Slug:** gregory-ella-escalation-output-body
**Status:** in-flight

## Context

Followup to `gregory-ella-pre-redesign-fixes.md`. Fix #1 from that spec (escalation rows showing Ella's actual DM in the list-view Output column) hit hard stop #3 because the DM body is constructed in-memory in `agents/ella/passive_dispatch.py:_fire_escalation_dm` and isn't persisted anywhere queryable. The DM gets sent (real `chat.postMessage` call to the CSM's Slack user ID), but nothing in the database carries the message text.

This spec persists the body to the existing audit row, then extends the data layer + UI to surface it in the Output column. Forward-only — historical escalation rows continue to show the placeholder until somebody backfills, which isn't in scope.

Working branch: `gregory-csm-visual-fixes` (same as parent spec). Preview URL: `https://ai-enablement-git-gregory-csm-visual-fixes-drakeynes-projects.vercel.app`. Auth bypassed on Preview.

## Reference reads (in this order)

1. `agents/ella/passive_dispatch.py` — `_fire_escalation_dm` constructs the DM body around line 220 and inserts an audit row at `_insert_dm_audit` (called at the top of the function, line ~225). The audit row's `payload` already carries `slack_channel_id`, `triggering_message_ts`, `channel_client_id`, `haiku_reasoning`. Adding `body` to that dict is the entire write-side change.
2. `lib/db/ella-runs.ts` — `getEllaRunsList`. The Output column derivation lives in here. Already has the `queued (...)` placeholder-skip pattern; this spec extends with `escalated via DM` placeholder-skip + a fresh join against `webhook_deliveries`.
3. `app/(authenticated)/ella/runs/page.tsx` and `app/(authenticated)/ella/runs/runs-table.tsx` — list-view rendering. May not need changes if the data-layer field is named consistently with what the table already reads.
4. `docs/schema/webhook_deliveries.md` (if it exists) — the table being joined. Confirm `webhook_id` is the row key shape and `payload` is `jsonb`.
5. `docs/schema/agent_runs.md` — for `output_summary`'s shape, confirms `escalated via DM; csm=<name>; dm_ok=<bool>` is what the row currently carries.

**Acclimatization checkpoint:** before writing any code, confirm in 4–5 bullets in your first commit message: (a) the exact line in `_fire_escalation_dm` where `audit_payload` is constructed (so the body addition lands in the right dict), (b) the join key strategy — `webhook_deliveries` doesn't have an `agent_run_id` column today; need to join on `(slack_channel_id, triggering_message_ts)` from the payload JSON. Confirm those fields are both in `payload`, (c) whether the existing `getEllaRunsList` projection has any pattern for joining to a JSON-payload-keyed table (probably not — this is the first such join), (d) the file map you intend to touch, (e) any unexpected drift between this spec and what you find.

## Decisions locked in by Director

From Drake/Director conversation 2026-05-14.

1. **Forward-only.** New escalations write the body to `webhook_deliveries.payload.body`. Historical rows stay without — Output column continues to show the `escalated via DM` placeholder for old escalations until/unless somebody backfills (out of scope).

2. **Single line of Python.** The `_fire_escalation_dm` function constructs `audit_payload` as a dict, then calls `_insert_dm_audit`. Add `"body": body` to the dict (the `body` local variable already holds the constructed text). No new function, no signature change, no migration. The `payload` column is `jsonb` and accepts arbitrary keys.

3. **Data-layer join via JSON-key match.** The Output column projection in `getEllaRunsList` extends the placeholder-skip logic: when `output_summary` matches `/^escalated via DM/i`, fall through to a `webhook_deliveries` lookup matching `payload->>'slack_channel_id' = ?` AND `payload->>'triggering_message_ts' = ?`. If a match exists and its `payload->>'body'` is non-null, that's the Output text. If no match (historical rows, race with audit write, etc.), render `—` muted.

4. **Render through the existing mention/emoji pipeline.** Consistency with non-escalation rows. The body contains a Slack permalink (`<https://...|...>` format) and possibly mentions — the existing list-view rendering already handles both.

5. **Playwright verification REQUIRED.** Same hard requirement as the parent spec. Builder verifies on the deploy preview before flipping shipped. Screenshots: list view showing an escalation row's Output column with the new body content (not the placeholder).

## What success looks like

### A. Python — persist the body

In `agents/ella/passive_dispatch.py:_fire_escalation_dm`, the `audit_payload` dict construction (around line 225) gets one new key:

```python
audit_payload = {
    "slack_channel_id": payload.slack_channel_id,
    "triggering_message_ts": payload.triggering_message_ts,
    "channel_client_id": payload.channel_client_id,
    "haiku_reasoning": decision.reasoning,
    "body": body,  # NEW — the constructed DM text
}
```

`body` is already constructed a few lines above (the multi-line f-string with the eyes emoji + permalink + reasoning). Just reference the same local. The audit row is inserted via `_insert_dm_audit(db, delivery_id, audit_payload, status="received")` immediately after — no change there.

Inline comment explaining the linkage to the dashboard read path:

```python
# `body` is persisted so the dashboard's /ella/runs list can surface
# Ella's actual escalation message in the Output column (see
# lib/db/ella-runs.ts getEllaRunsList, the escalation placeholder-skip
# fallback path). Forward-only — historical rows without this key
# continue to show the placeholder.
"body": body,
```

### B. TypeScript — extend the placeholder-skip logic

In `lib/db/ella-runs.ts`, the existing placeholder-skip logic in the Output column projection (which handles `queued (` today) extends to also recognize `escalated via DM`:

```typescript
const QUEUED_PLACEHOLDER_PATTERN = /^queued \(/
const ESCALATION_PLACEHOLDER_PATTERN = /^escalated via DM/i

const isPlaceholder = (s: string | null) =>
  s != null && (
    QUEUED_PLACEHOLDER_PATTERN.test(s.trim()) ||
    ESCALATION_PLACEHOLDER_PATTERN.test(s.trim())
  )
```

When a row matches escalation, the fallback fetches from `webhook_deliveries`. Builder's call on whether this is a per-row fetch (N+1 in the worst case) or a batched lookup for all escalation rows in the result set (single query, hash-join in JS). Batched is preferred at any meaningful row count; the patterns in this file lean batched. Match those.

The lookup query:

```typescript
// pseudo
const escalationRows = runs.filter(r =>
  r.output_summary && ESCALATION_PLACEHOLDER_PATTERN.test(r.output_summary)
)
const lookupPairs = escalationRows.map(r => ({
  channel_id: r.slack_channel_id,
  ts: r.trigger_metadata?.triggering_message_ts,
}))
// Batched fetch of webhook_deliveries rows matching these payload keys
// then build a Map keyed on (channel_id + ts) -> body
```

Supabase doesn't have a great native way to filter on JSON-key composites at scale. Builder picks the cleanest approach within the existing codebase patterns: one Supabase `.in('payload->>slack_channel_id', [...]).in('payload->>triggering_message_ts', [...])` filter that overfetches then filters in JS, OR a series of `.or(...)` clauses if the count is small. Document the choice in Surprises.

The new field on `EllaRunsListRow`: `escalation_body: string | null`. Populated only for escalation rows where a matching audit row was found.

### C. TypeScript — Output column rendering

In whichever file currently renders the Output cell for the list (`runs-table.tsx` or equivalent), the cell value derivation becomes:

```typescript
const outputText =
  row.escalation_body  // NEW — when present, this wins
    ?? row.output_text  // existing — from queued fallback
    ?? null

// render outputText through existing mention/emoji pipeline
```

The rest of the cell render (truncation, mention rendering, etc.) stays unchanged.

### D. Playwright verification

Required. Extend `scripts/verify-ella-pre-redesign-fixes.ts` or add `scripts/verify-ella-escalation-output.ts`:

1. Navigate to `/ella/runs`.
2. Find an escalation row in the list (run with status `success` and `output_summary` starting with `escalated via DM`). If no escalation rows exist on the preview yet (because the fix is forward-only and the preview's database might not have recent escalations), surface in Surprises and document the gap. **Builder should attempt to find ANY escalation row, even an old one, and screenshot its Output column** — that screenshot demonstrates the placeholder fallback path (the `—` muted render for rows without a body).
3. If a fresh-enough escalation exists with a body, screenshot it showing the actual DM content rendered in the Output column.
4. The report explicitly notes which case the screenshot captured (with-body or fallback).

Screenshots inline in the report.

## Hard stops

1. **Do not push to `main`.** Push commits to `gregory-csm-visual-fixes`.

2. **Do not flip Status to shipped without Playwright screenshots demonstrating the Output column rendering.** Even if no with-body escalation exists yet (forward-only means newly-fired escalations only carry the body), the screenshot of the fallback path is still required.

3. **If the `webhook_deliveries` JSON-key batched fetch turns out to be wildly slow or returns ambiguous matches** (e.g. the same `slack_channel_id + triggering_message_ts` pair appears in multiple audit rows for legitimate reasons), stop and surface. The join must be deterministic — one escalation row maps to exactly one audit row.

4. **If the `body` variable in `_fire_escalation_dm` doesn't exist as a local at the point where `audit_payload` is constructed**, surface — the spec assumes its existence based on reading the code. If it's named differently or constructed later in the function, adjust accordingly.

## Think this through yourself — what could go wrong

- **The audit row is inserted BEFORE the Slack send, with status='received'.** Builder confirms this in acclimatization. The body is constant once constructed — it doesn't change between the insert and the actual `chat.postMessage`. So the audit row's `body` always reflects what was sent, even if the send fails. (Failed sends still leave the audit row with the body; dashboard can still display it.)

- **Realtime race.** A new escalation fires, the audit row writes with `body`, the user lands on `/ella/runs` half a second later. The dashboard query runs and finds the audit row. The race window is tiny but real. **Mitigation:** no special handling needed; Supabase reads are eventually consistent but transactions complete fast enough that this is sub-second.

- **Stale audit rows.** If a CSM clicks an old escalation row, the placeholder shows. New escalations fired post-deploy show the body. The transition isn't sharp; it's "rows from before this fix don't have a body." **Mitigation:** documented in spec § Decision 1. Backfill is a separate concern.

- **JSON key lookup performance.** Supabase queries that filter on `payload->>'key'` aren't always index-backed. At thousands of escalation rows, this could slow down. Production escalation count is low (probably under 100 ever). **Mitigation:** if perf is observed as a problem, a real schema change (promoting `(slack_channel_id, triggering_message_ts)` to columns on `webhook_deliveries` for escalation rows) is the proper fix. Not in scope here.

- **The body contains a Slack permalink that may not be clickable from the dashboard.** The `<https://...|label>` syntax renders correctly through the existing mention pipeline, but the user clicking the link in the dashboard opens Slack. That's fine — the link is informative even if the user is on the dashboard, not in Slack.

- **The audit-row write inside a try/except.** `_insert_dm_audit` wraps insert in try/except — failures log a warning and continue. Worst case: the DM sends but the audit row doesn't write, so the dashboard never sees the body. **Mitigation:** monitor the warning logs in production; if `dm audit insert failed` shows up, that's the signal to investigate. Not adding alerting in this spec.

## Mandatory doc-update list

- `docs/state.md` — no update needed.
- `docs/known-issues.md` — possibly. If Builder notices the JSON-key filter performance as a known limit, log it. Otherwise no entry.
- `CLAUDE.md` — no update needed.
- `docs/agents/ella/ella.md` — possibly. If the escalation DM body persistence is worth a one-line note in Ella's behavior doc (now that the dashboard can read it back), add. Builder's call.

## Out of scope for this spec (explicit)

- Backfilling historical escalation rows with reconstructed bodies.
- A schema migration to promote `(slack_channel_id, triggering_message_ts)` to indexed columns on `webhook_deliveries`.
- Any change to the DM send behavior or message format.
- Surfacing the escalation body on the detail page (Output column is list-view only; detail page already shows different content).
- Any non-Ella surface.
- Tests beyond Playwright screenshots — deferred.
