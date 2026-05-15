# Runbook: Auto-created client management

Operational guide for the full lifecycle of auto-created `clients` rows: how they're produced, how to merge them into real clients, how to mark them reviewed, and the data-hygiene badges (Missing Slack channel / Missing Slack user) that frequently surface alongside.

Related: `docs/runbooks/call_title_convention.md` (the May 18 title-cutoff rule that triggers most new auto-creates) and `docs/decisions/0002-title-convention-enforcement.md` (rationale for the cutoff). Schema: `docs/schema/clients.md` § needs_review lifecycle.

## What gets auto-created

Two classifier paths produce auto-create requests today:

1. **Pre-cutoff `30mins with Scott` pattern** — legacy. `metadata.auto_create_reason = "30mins_with_Scott pattern with unresolved participant"`.
2. **Post-cutoff new-convention patterns** — `Coaching Call with {Scott|Lou|Nico}` or `Sales Call with {Scott|Lou|Nico}` (case-insensitive prefix match). `metadata.auto_create_reason = "new title convention with unresolved participant"`.

Both produce rows tagged `needs_review` with breadcrumb fields in `metadata` (`auto_create_call_id`, `auto_create_email`, `auto_create_recorded_at`, etc.). When multiple unresolved external participants are on the same call, only the FIRST gets auto-created — others surface via `call_participants` for later manual review.

The pipeline's `_lookup_or_create_auto_client` is idempotent: it tries an email lookup first (including alternate_emails), reactivates archived rows if matched, and only inserts when no row exists. Re-ingesting the same call won't produce duplicates.

## Surfacing auto-creates on the dashboard

- **`/clients` list page**: existing "Needs review" filter chip narrows to rows where `tags @> ARRAY['needs_review']`. New "Missing Slack" filter chip narrows to rows with null `slack_user_id` OR null active `slack_channel_id` — auto-created rows usually start out missing both.
- **`/clients/[id]` detail page**: when `needs_review` is on the row's `tags`, an action row appears between the page header and the data grid with two buttons: **"Merge into…"** (left) and **"Mark as reviewed"** (right). Missing-Slack pills appear in the same row when applicable, even when `needs_review` is absent.

## Merging into an existing client

When the auto-created row represents a duplicate of an existing client (typo, casing variant, alternate email):

1. Open `/clients/[id]` for the auto-created client.
2. Click **Merge into…**. A dialog opens with a searchable typeahead over all active non-archived clients (the source is excluded).
3. Pick the target (the real client) and confirm.
4. The `merge_clients` RPC (migration 0015) runs in a single transaction:
   - Reattributes all calls + participants + transcript chunks to the target.
   - Syncs the source's email + display name into `target.metadata.alternate_emails` / `alternate_names` so future Fathom classification matches the target by either identity.
   - Archives the source row.
5. Browser redirects to the target's `/clients/[id]` page.

The RPC validates pre-merge: source must exist, target must exist + not be archived + not be the source itself, source must be tagged `needs_review`. Mismatches surface as inline errors in the dialog.

## Marking as reviewed (without merging)

When the auto-created row IS a new client (legitimately needs to exist on its own — not a merge candidate):

1. Open `/clients/[id]` for the auto-created client.
2. Edit any missing fields inline (Slack channel + user, country, journey stage, primary CSM, etc.) — same inline-edit surfaces every other client has.
3. Click **Mark as reviewed**.
4. Confirmation modal: "Mark [Client Name] as reviewed? This removes the `needs_review` tag but doesn't change anything else."
5. On confirm, the server action removes `needs_review` from the `tags` column and stamps `metadata.needs_review_cleared_at` with the current ISO timestamp.
6. Page re-renders; the action row disappears (the tag-gated conditional hides both buttons now that `needs_review` is gone).

If you accidentally cleared the tag, you can re-add it via the inline tags editor on `/clients/[id]` — the dashboard doesn't block manual re-tagging.

## Missing-Slack badges

Two distinct warn pills, computed read-time from `clients.slack_user_id` + the joined active `slack_channels` row:

- **"Missing Slack channel"** — no non-archived `slack_channels` row exists for this client.
- **"Missing Slack user"** — `clients.slack_user_id` is null.

Both render on `/clients/[id]` in the action row + on the `/clients` list table in the new "Slack" column. The "Missing Slack" filter chip on the list narrows to clients where either field is null.

Why the badges exist: Ella + Send-to-Slack + Slack-channel ingestion all depend on these fields. A client with missing Slack identity silently drops out of those flows. The badge surfaces the gap.

Resolution: edit the fields inline on `/clients/[id]` (Slack user_id) or invite the bot + Zain to the client's channel and let realtime ingestion populate `slack_channels` (Slack channel id).

## Audit queries

### Recent auto-creates by source

```sql
SELECT id, full_name, email, created_at,
       metadata->>'auto_create_reason' AS source,
       metadata->>'auto_create_call_id' AS source_call_id,
       'needs_review' = ANY(tags) AS still_needs_review
FROM clients
WHERE metadata ? 'auto_create_reason'
  AND archived_at IS NULL
ORDER BY created_at DESC
LIMIT 50;
```

### Open needs-review queue + Slack hygiene

```sql
SELECT c.id, c.full_name, c.email,
       c.slack_user_id IS NULL AS missing_slack_user,
       NOT EXISTS (
         SELECT 1 FROM slack_channels sc
         WHERE sc.client_id = c.id AND NOT sc.is_archived
       ) AS missing_slack_channel,
       c.created_at
FROM clients c
WHERE 'needs_review' = ANY(c.tags)
  AND c.archived_at IS NULL
ORDER BY c.created_at DESC;
```

### Reviewed-but-not-merged clients (cleared the tag, kept the row)

```sql
SELECT id, full_name, email,
       metadata->>'needs_review_cleared_at' AS cleared_at
FROM clients
WHERE metadata ? 'needs_review_cleared_at'
  AND NOT ('needs_review' = ANY(tags))
  AND archived_at IS NULL
ORDER BY (metadata->>'needs_review_cleared_at') DESC
LIMIT 50;
```

## Hard stops + design rationale

- **No retroactive auto-create.** Forward-only. Historical calls with `primary_client_id=null` stay where they are. The next sync that delivers a NEW call referencing the same email will trigger the auto-create on that future call.
- **`needs_review` is not system-only.** A CSM can manually add or remove the tag via inline tags editing. The dashboard buttons are conveniences, not enforcement.
- **No automatic re-merge.** If a CSM marks an auto-created row as reviewed but then realizes it should have been merged, the path is: re-add `needs_review` to the tag list → the merge button reappears → merge.
- **Missing-Slack state is NOT stored.** Read-time computation from the two source fields. Filling in either field via the dashboard inline editor causes the badge to disappear on the next render with no extra cleanup.

## Code + decision pointers

- Decision: `docs/decisions/0002-title-convention-enforcement.md` — auto-create is the safety net for the May 18 cutoff.
- Classifier: `ingestion/fathom/classifier.py` — `_classify_by_new_convention` emits `AutoCreateRequest`.
- Pipeline: `ingestion/fathom/pipeline.py` — `_lookup_or_create_auto_client` (idempotent insert).
- Merge: `lib/db/merge.ts:mergeClient` + migration `0015_merge_clients_function.sql`.
- Server action: `app/(authenticated)/clients/[id]/actions.ts:removeNeedsReviewTagAction`.
- UI: `app/(authenticated)/clients/[id]/page.tsx` (action-row conditional), `merge-client-button.tsx`, `remove-needs-review-button.tsx`, `pills.tsx` (MissingSlack* pills).
