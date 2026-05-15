# Lifecycle of auto-created clients: auto-create on new patterns + merge UI + remove-tag + missing-Slack badges

**Slug:** auto-created-client-lifecycle
**Status:** in-flight

## Context

The May 18 title-convention enforcement just shipped (`docs/specs/classifier-enforce-new-title-convention.md`). Side effect Builder flagged in their report: post-cutoff client calls with unresolved participants get `primary_client_id=null` — **no auto-create happens on the new patterns.** Drake's intent (per chat) is the opposite: every "Coaching/Sales Call with [Scott|Lou|Nico]" post-cutoff that has an external participant who can't be resolved should auto-create that client (tagged `needs_review`) so every client and every call is accounted for. Existing onboarding flow seeds most clients but not all; the auto-create catches the gaps cleanly.

This spec wires four cohesive pieces of the "lifecycle of auto-created clients" story:

1. **Re-extend auto-create to the six new title patterns.** Existing `30mins_with_Scott` auto-create logic was retired post-cutoff; bring the equivalent back for the new patterns so the safety net stays.
2. **Re-surface the merge button on `/clients/[id]`.** The component code (`merge-client-button.tsx`) already exists in the repo. The button is just not rendered today. Wire it back into the page, gated on `needs_review` tag presence.
3. **New "Remove tag" button on `/clients/[id]`.** Beside the merge button. Only renders when `needs_review` is in `metadata.tags`. Clears just that one tag.
4. **Missing-Slack badges** computed read-time on `/clients/[id]` (near Send-to-Slack) and `/clients` (filterable column). Two distinct badges: "Missing Slack channel" and "Missing Slack user". Surface on every client missing either field, independent of `needs_review`.

The `needs_review` tag filter on `/clients` already exists per Drake. No work needed there.

## Files Builder reads first (acclimatization)

1. `app/(authenticated)/clients/[id]/merge-client-button.tsx` — the existing merge UI. Confirm what it does, what shape its target-picker takes, whether it still references the right server action. This is load-bearing for understanding what work remains versus what's already there.
2. `app/(authenticated)/clients/[id]/page.tsx` — the detail page. Find where the merge button used to live (likely commented out, removed, or never wired). The new code slots in alongside.
3. `app/(authenticated)/clients/[id]/actions.ts` — server actions for the detail page. The merge action probably already exists (since the component does). The new `removeNeedsReviewTag` server action lives here.
4. `app/(authenticated)/clients/page.tsx` + `clients-table.tsx` + `filter-bar.tsx` — the list page. Find where missing-Slack badges will surface (column on the table). Verify the `needs_review` filter exists.
5. `app/(authenticated)/clients/pills.tsx` — the existing pill primitive. Reuse for the new badges if the visual fits.
6. `ingestion/fathom/classifier.py` — specifically the `_classify_by_new_convention` function Builder added in the last spec. The new auto-create logic slots into this function's "no client resolved" branch.
7. `ingestion/fathom/pipeline.py` — specifically `_lookup_or_create_auto_client`. This is the function the new auto-create reuses; understand its existing behavior (reactivation of archived rows, metadata breadcrumbs, tag seeding).
8. `supabase/migrations/0015_merge_clients.sql` (or wherever the `merge_clients` RPC lives) — confirm the RPC signature so the merge button's server action calls it correctly.
9. `docs/schema/clients.md` — `metadata.tags`, `slack_user_id`, `slack_channel_id`. Confirm column names + the editable-field surface that lets us read these.

After reading, Builder confirms in 4-6 bullets:
- Whether `merge-client-button.tsx` still works as-is, or needs a rewrite given the redesigned skin.
- Where on `/clients/[id]` the two buttons (Merge + Remove tag) should live geographically.
- Whether `pills.tsx` is the right primitive for the missing-Slack badges, or whether they want their own visual (warn-tinted, since they're an actionable problem).
- Whether the `needs_review` filter on `/clients` is implemented as a tag filter generically, or as a specific named chip.

## Decisions baked in (do NOT re-litigate)

### Auto-create on new patterns

- **Trigger:** post-cutoff (`started_at >= 2026-05-18T00:00:00 America/New_York`) call where title matches one of the six new patterns AND the call has an external participant that doesn't resolve to a known client (by email or alternate-name).
- **Behavior:** emit `AutoCreateRequest` from the classifier with the unresolved participant's email + display name. The pipeline's existing `_lookup_or_create_auto_client` handles the rest — lookup-by-email-first, reactivate archived rows, insert new, tag `needs_review`, write metadata breadcrumb.
- **Reason string:** `"new title convention with unresolved participant"` (distinct from the Scott-1:1 reason so audit queries can tell them apart).
- **Confidence stays at 1.0 for the call classification.** The auto-create doesn't lower the call's confidence — the title is still authoritative for "this is a client call." The auto-created client's `needs_review` tag is the human-review signal, not the confidence.
- **Multiple unresolved external participants:** auto-create the FIRST unresolved external participant only. Rare but possible (a client invites a coworker we don't know about). The first external attendee in the participants list gets the auto-create; others are surfaced through the call-participants table for later manual review. Keep this simple in V1.
- **No retroactive auto-create.** This is forward-only. Calls already in the DB don't get re-classified or new clients created from them.

### Merge button on `/clients/[id]`

- **Visibility:** only renders when `needs_review` is in `metadata.tags`. Hidden for all other clients.
- **Existing component reuse:** Builder reads `merge-client-button.tsx` and decides whether to keep it as-is, restyle to fit the editorial skin, or rewrite. If the existing component works and matches the skin, ship it as-is. If it doesn't match the redesigned skin, rewrite — Drake stated preference for new UI given the redesign.
- **Target picker:** typeahead over `clients` rows, excluding clients with `needs_review` tag (you merge auto-creates INTO real clients, not into other auto-creates).
- **Server action:** if the existing action in `actions.ts` works, reuse it. The action fires the `merge_clients` RPC from migration 0015 (which already exists).
- **Post-merge:** redirect to the target client's `/clients/[id]` page. The source (auto-created) client gets archived as part of the RPC behavior.

### Remove-tag button on `/clients/[id]`

- **Visibility:** only renders when `needs_review` is in `metadata.tags`. Hidden for all other clients.
- **Position:** beside the Merge button (Drake's spec). Side-by-side. Order: Merge on the left, Remove tag on the right. Visual: both editorial-styled buttons matching the existing detail page chrome.
- **Confirmation:** modal "Mark [Client Name] as reviewed? This removes the needs_review tag but doesn't change anything else." Yes / Cancel.
- **Server action:** new `removeNeedsReviewTag(clientId: string)` in `actions.ts`. Reads current `metadata.tags`, filters out `needs_review`, writes back. Uses the admin Supabase client (server-only). Returns success/error.
- **Audit:** writes a row to `client_audit_log` (if that table exists; Builder checks the schema) OR adds a `metadata.needs_review_cleared_at` + `metadata.needs_review_cleared_by` timestamp. My lean: just the timestamp on metadata — single source of truth, no new table.
- **Side effects:** none beyond the tag removal. The client stays at `status='active'`, primary_csm_id unchanged, all assignments preserved.

### Missing-Slack badges

- **Read-time computed.** No new DB column, no cron, no stored tag. The page reads `slack_channel_id` and `slack_user_id`, renders the appropriate badge(s) when either is null.
- **Two distinct badges:**
  - `slack_channel_id IS NULL` → "Missing Slack channel" badge.
  - `slack_user_id IS NULL` → "Missing Slack user" badge.
  - Both null → both badges render side by side.
  - Both present → no badge renders.
- **Visual:** warn-tinted (uses `--color-geg-warn-*` tokens or whatever the existing warn pill primitive provides). Pinpoints actionable data hygiene.
- **Two locations:**
  - **`/clients/[id]` detail page**: badges render in the page chrome near the Send-to-Slack button (or wherever Slack identity is surfaced). Contextual — you see the badge when you'd hit the broken button.
  - **`/clients` list page**: a new column "Slack" in the table. Shows badge(s) for the row when applicable, empty cell otherwise. Filterable via the existing filter-bar pattern — a new filter chip "Missing Slack" surfaces clients with either or both badges.
- **Independent of `needs_review`.** Auto-created clients without Slack data show both badges (`needs_review` + missing-Slack). Legacy clients with broken Slack data show missing-Slack but NOT `needs_review`. Two distinct concerns, surfaced separately.

## Implementation

### 1. Classifier auto-create extension (Python)

In `ingestion/fathom/classifier.py`, update `_classify_by_new_convention` to emit `AutoCreateRequest` when an external participant doesn't resolve:

```python
def _classify_by_new_convention(
    record: FathomCallRecord,
    resolver: ClientResolver,
) -> ClassificationResult:
    """Post-cutoff path: title matched one of the six new canonical
    patterns. If an external participant resolves to a known client,
    classify as client with that client_id. If not, emit an
    AutoCreateRequest so the pipeline reifies a minimal clients row
    tagged needs_review — same shape as the legacy Scott-1:1 path.
    """
    external_emails = [
        pt.email for pt in record.participants if not _is_team_email(pt.email)
    ]
    title_norm = _normalize_for_title_match(record.title)

    # First try to resolve any external participant to a known client.
    for email in external_emails:
        cid, matched_via = _resolve_participant(
            resolver, record.participants, email
        )
        if cid is not None:
            return ClassificationResult(
                call_category="client",
                call_type=_new_convention_call_type(title_norm),
                classification_confidence=1.0,
                classification_method="title_pattern",
                primary_client_id=cid,
                reasoning=(
                    f"new title convention match; {email} matched existing "
                    f"client via {matched_via}"
                ),
            )

    # No external participant resolved. Auto-create the first unresolved
    # external participant if any exist. Pipeline does the lookup-by-
    # email-first-then-insert dance + tags needs_review.
    if external_emails:
        first_unresolved = external_emails[0]
        display = _find_display_name(record.participants, first_unresolved)
        return ClassificationResult(
            call_category="client",
            call_type=_new_convention_call_type(title_norm),
            classification_confidence=1.0,
            classification_method="title_pattern",
            primary_client_id=None,
            should_auto_create_client=AutoCreateRequest(
                email=first_unresolved,
                display_name=display,
                reason="new title convention with unresolved participant",
            ),
            reasoning=(
                f"new title convention match; {first_unresolved} unresolved — "
                "auto-create requested"
            ),
        )

    # No external participants at all — degenerate case (booking-link
    # title but only team members on the invite). Classify as client
    # with no primary, no auto-create. Surfaces as a data hygiene flag.
    return ClassificationResult(
        call_category="client",
        call_type=_new_convention_call_type(title_norm),
        classification_confidence=1.0,
        classification_method="title_pattern",
        primary_client_id=None,
        reasoning="new title convention match but no external participants",
    )


def _new_convention_call_type(title_norm: str) -> str:
    """Derive call_type from the new-convention title prefix."""
    if title_norm.startswith("coaching call"):
        return "coaching"
    if title_norm.startswith("sales call"):
        return "sales"
    return None
```

The pipeline-side auto-create already handles `AutoCreateRequest` cleanly (`_lookup_or_create_auto_client`); no changes needed there.

### 2. Merge button rewire on `/clients/[id]`

Builder reads `merge-client-button.tsx` first. Two paths:

**Path A — existing component still works.** Re-render it in `page.tsx` conditionally on `needs_review` tag presence. Likely a one-line change to the page (uncomment / re-add the button).

**Path B — existing component needs a rewrite to match the redesigned editorial skin.** Build a new `merge-client-button.tsx` (or rename the old one if it's archived as commented-out code). Use the editorial primitives — gold-accent button styling, modal pattern matching the rest of the detail page. The underlying server action and `merge_clients` RPC stay unchanged.

Builder reports which path was taken in their report.

### 3. Remove-tag button (new)

New component `app/(authenticated)/clients/[id]/remove-needs-review-button.tsx`:

```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { removeNeedsReviewTag } from './actions'

export function RemoveNeedsReviewButton({ clientId, clientName }: {
  clientId: string
  clientName: string
}) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onConfirm() {
    setSubmitting(true)
    setError(null)
    const result = await removeNeedsReviewTag(clientId)
    if (result.error) {
      setError(result.error)
      setSubmitting(false)
      return
    }
    router.refresh()
  }

  return (
    <>
      <button onClick={() => setConfirming(true)} className="...">
        Mark as reviewed
      </button>
      {confirming && (
        <Modal>
          {/* "Mark [clientName] as reviewed?" */}
          {/* Yes / Cancel buttons */}
        </Modal>
      )}
    </>
  )
}
```

New server action in `actions.ts`:

```typescript
'use server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'

export async function removeNeedsReviewTag(clientId: string) {
  const supabase = createAdminClient()
  
  // Read current tags
  const { data: client, error: readErr } = await supabase
    .from('clients')
    .select('metadata,full_name')
    .eq('id', clientId)
    .single()
  
  if (readErr || !client) {
    return { error: readErr?.message ?? 'Client not found' }
  }
  
  const currentTags: string[] = (client.metadata?.tags ?? [])
  if (!currentTags.includes('needs_review')) {
    return { error: 'Client does not have needs_review tag' }
  }
  
  const newTags = currentTags.filter(t => t !== 'needs_review')
  const newMetadata = {
    ...client.metadata,
    tags: newTags,
    needs_review_cleared_at: new Date().toISOString(),
  }
  
  const { error: writeErr } = await supabase
    .from('clients')
    .update({ metadata: newMetadata })
    .eq('id', clientId)
  
  if (writeErr) {
    return { error: writeErr.message }
  }
  
  revalidatePath(`/clients/${clientId}`)
  revalidatePath('/clients')
  return { success: true }
}
```

### 4. Render both buttons conditionally on `/clients/[id]/page.tsx`

```typescript
// Inside the page render, near the existing detail chrome:
{client.metadata?.tags?.includes('needs_review') && (
  <div className="flex gap-2">
    <MergeClientButton clientId={client.id} clientName={client.full_name} />
    <RemoveNeedsReviewButton clientId={client.id} clientName={client.full_name} />
  </div>
)}
```

Position: Builder picks the cleanest spot in the existing detail page layout. Likely near the top of the page chrome, alongside other client-level actions.

### 5. Missing-Slack badges

Two render locations:

**On `/clients/[id]`** (probably in the same area as the Send-to-Slack button):

```typescript
{!client.slack_channel_id && (
  <Pill variant="warn">Missing Slack channel</Pill>
)}
{!client.slack_user_id && (
  <Pill variant="warn">Missing Slack user</Pill>
)}
```

Use the existing `Pill` from `pills.tsx`, adding a `warn` variant if it doesn't have one (token: `--color-geg-warn-fill` / `--color-geg-warn-border` / `--color-geg-warn-text`).

**On `/clients` list page** — new column "Slack" in `clients-table.tsx`:

- Renders the same warn pills as above for rows missing either field.
- Empty cell when both fields are present.
- Column is sortable / filterable via existing patterns.

**Filter chip** in `filter-bar.tsx` — new "Missing Slack" filter:

- Toggling on filters to rows where `slack_channel_id IS NULL OR slack_user_id IS NULL`.
- Filter is independent of the existing `needs_review` filter — users can combine them ("needs review AND missing slack" = the worst-data-hygiene auto-creates).

### 6. Tests

**Python (classifier auto-create):**

- Post-cutoff "Coaching Call with Scott" with one external participant matching a known client → classified as client with that client_id, no auto-create.
- Post-cutoff "Coaching Call with Lou" with one external participant who is NOT in clients → emits AutoCreateRequest with that participant's email, reason matches "new title convention".
- Post-cutoff "Sales Call with Nico" with multiple unresolved externals → auto-creates the FIRST external only, others surface in participants.
- Post-cutoff title match with no external participants at all → classified as client, no auto-create, primary_client_id=null (degenerate but valid).
- Pre-cutoff calls with same titles → unchanged from current behavior (which is: would match the new title pattern but wouldn't take the new path).

**TypeScript:** no test infrastructure exists for the Next.js side. Builder validates via Playwright on the deploy preview if a script is worth adding, else manual Drake gate (c).

### 7. Doc updates

- `docs/schema/clients.md` — mention the `needs_review` tag's lifecycle (auto-assigned on auto-create, removable via dashboard button), the `metadata.needs_review_cleared_at` audit timestamp.
- `docs/runbooks/call_title_convention.md` — update to describe the auto-create extension (was retired in the last spec; brought back here on the new patterns).
- `docs/runbooks/auto_created_client_management.md` — new runbook covering the full lifecycle: auto-creation, the needs_review filter, the merge flow, the remove-tag flow, and what to do when a missing-Slack badge shows up.
- `docs/state.md` — entry covering all four pieces.

## What success looks like

1. **Classifier auto-create test suite passes.** New tests green.
2. **Post-2026-05-18 Fathom webhook delivers a "Coaching Call with Scott" + unknown participant** → new client row appears in `clients` with `needs_review` tag, metadata breadcrumb, the call's `primary_client_id` set to the new row's id.
3. **The needs_review filter on `/clients`** shows the new auto-created client.
4. **Clicking into the new client's `/clients/[id]` page** shows both buttons side by side: Merge + Mark as reviewed.
5. **Merge flow:** click Merge → typeahead for target real client → pick → confirm → redirect to target client's detail page → auto-created client is archived. Use the existing `merge_clients` RPC.
6. **Remove-tag flow:** click Mark as reviewed → confirm modal → tag removed → page re-renders without the buttons (the conditional gate hides them now that `needs_review` is gone).
7. **Missing-Slack badges:** any client (auto-created or otherwise) with null `slack_channel_id` or `slack_user_id` shows the appropriate warn pill on `/clients/[id]` and the list table.
8. **Missing-Slack filter:** toggling the filter chip on `/clients` narrows to clients with missing IDs.
9. **All tests pass.** `pytest tests/` green; lint clean; tsc clean.

## Hard stops

- **Don't write a new merge RPC.** `merge_clients` from migration 0015 already does this work.
- **Don't change the `needs_review` filter on `/clients` if it already works.** Per Drake.
- **Don't make `needs_review` a system-only tag that blocks user editing.** Today tags are freeform; this spec doesn't change that. A CSM could in principle re-add the tag manually if they want to flag a client for review post-hoc.
- **Don't auto-clear `needs_review` after merge.** The merge RPC archives the source client; the tag goes away with it. No additional logic needed.
- **Don't store the missing-Slack state.** Computed read-time only.
- **Don't add LLM calls anywhere in this spec.** No "smart match" merge target suggestions. The typeahead is plain text matching.
- **Don't bundle other auto-creates** (e.g., participant-match path) into this spec. Only the new title patterns get auto-create here. The legacy Scott-1:1 path stays retired post-cutoff.

## What could go wrong

- **The existing `merge-client-button.tsx` is broken or references removed code.** Builder confirms the component's current state during acclimatization. If broken, rewrite it cleanly using the editorial skin.
- **The existing `merge_clients` RPC has changed since 0015.** Builder reads the latest migration that touches it (if any later migrations exist). Confirms the RPC signature matches what the action expects.
- **A client gets auto-created twice for the same email** because the resolver wasn't updated between the first auto-create and the second classify in the same batch. Existing `_lookup_or_create_auto_client` already handles this (lookup-by-email-first). No new risk.
- **A CSM clicks "Mark as reviewed" by accident.** The confirmation modal mitigates. The tag can be manually re-added if needed via inline tags editing (assuming tags are editable — Builder verifies).
- **The `needs_review` tag isn't actually in `metadata.tags` for some auto-created rows** (drift between expected and actual schema). Builder runs a SELECT against production to confirm Nate Fuentes and other auto-created clients all have the tag in the expected location.
- **`merge_clients` RPC fails on clients with active call_action_items or other dependencies.** Builder reads the RPC source to confirm the cascade behavior. If the RPC fails on dependencies, surface the failure cleanly in the UI ("This client has X active references; cannot merge until cleared").

## Mandatory doc-update list

- `ingestion/fathom/classifier.py` — extended `_classify_by_new_convention` with auto-create logic + new `_new_convention_call_type` helper.
- `tests/ingestion/fathom/test_classifier.py` — new tests covering auto-create on new patterns.
- `app/(authenticated)/clients/[id]/page.tsx` — conditional render of Merge + Remove-tag buttons.
- `app/(authenticated)/clients/[id]/merge-client-button.tsx` — possibly modified per Path A or rewritten per Path B.
- `app/(authenticated)/clients/[id]/remove-needs-review-button.tsx` — new.
- `app/(authenticated)/clients/[id]/actions.ts` — new `removeNeedsReviewTag` server action.
- `app/(authenticated)/clients/clients-table.tsx` — new Slack column.
- `app/(authenticated)/clients/filter-bar.tsx` — new "Missing Slack" filter chip.
- `app/(authenticated)/clients/pills.tsx` — possibly new `warn` variant.
- `docs/schema/clients.md` — needs_review lifecycle notes.
- `docs/runbooks/call_title_convention.md` — auto-create extension note.
- `docs/runbooks/auto_created_client_management.md` — new.
- `docs/state.md` — entry.

## Commit shape

One classifier commit ("feat: extend auto-create to new title convention patterns"). One UI commit ("feat: re-surface merge button, add remove-tag, missing-Slack badges"). One docs commit. One report commit. Push at end.
