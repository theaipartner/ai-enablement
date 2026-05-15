# Runbook: New call title convention (cutoff Mon May 18 2026 EST)

Operational guide for the post-2026-05-18 enforcement of canonical call titles. Covers what the rule is, why it exists, how to recover from a miscategorized call, and what to tell a CSM whose call didn't show up where they expected.

## The rule

Calls with `started_at` at or after **2026-05-18T00:00:00 America/New_York** only auto-classify as `call_category='client'` when their title matches one of six canonical patterns (case-insensitive prefix match):

- `Coaching Call with Scott`
- `Coaching Call with Lou`
- `Coaching Call with Nico`
- `Sales Call with Scott`
- `Sales Call with Lou`
- `Sales Call with Nico`

Trailing context after the pattern is tolerated — `Coaching Call with Scott - Andrew Hsu` still matches. Prefixes like `FW:` or `[CANCELED]` do NOT match — they break the prefix check.

Pre-cutoff calls use the prior cascade unchanged. No retroactive reclassification.

### v2: name-prefixed titles (2026-05-15)

Zain iterated the booking link to prefix the client's name:

- `[Client Name] - Coaching Call with {Scott|Lou|Nico}`
- `[Client Name] - Sales Call with {Scott|Lou|Nico}`

e.g. `Andrew Hsu - Coaching Call with Scott`. **Both v1 and v2 stay valid indefinitely — there is no second cutoff.** A booking link mid-migration may emit either; both classify as `client` post-2026-05-18.

Match is case-insensitive, leading/trailing whitespace trimmed, padded separators tolerated, trailing context after the CSM name tolerated (`Andrew Hsu - Coaching Call with Scott - May 22 follow up` matches). The name capture is non-greedy and anchors to the FIRST ` - (Coaching|Sales) Call with`, so a drifted `FW: Andrew Hsu - Coaching Call with Scott` captures the name as `FW: Andrew Hsu` — that name just fails to resolve and falls back to email (the booking link never emits an `FW:` prefix, so this is correct degradation, not a supported input).

**Name prefix is the PRIMARY client-resolution signal for v2.** When the prefix resolves via `ClientResolver.lookup_by_name` (case-insensitive, consults `metadata.alternate_names`), it sets `primary_client_id` directly — no dependency on the participant's email being mapped. Resolution order for a v2 title:

1. Name prefix → `lookup_by_name`. Hit → `primary_client_id` set, `matched_via='title_name_prefix'`.
2. Miss → fall back to participant-email resolution (the v1 mechanism).
3. Neither → `AutoCreateRequest` for the first unresolved external (same safety net as v1).

v2 matches surface `classification_method='title_pattern_v2'`; v1 stays `'title_pattern'`. `call_type` (`coaching`/`sales`) comes from the v2 regex capture.

**Collision caveat:** `lookup_by_name` indexes one `client_id` per normalized `full_name`. Two non-archived clients sharing a name → only one is name-resolvable; the other falls back to email. At 2026-05-15 there were **0** duplicate non-archived `full_name` groups, so no client currently collides. Audit: `SELECT lower(trim(full_name)), count(*) FROM clients WHERE archived_at IS NULL GROUP BY 1 HAVING count(*) > 1;`

## Why this exists

Drake is pushing the team to use Zain's new booking links exclusively. The links generate one of the six canonical titles automatically. Making non-compliance technically visible — via classification dropping out — is the forcing function. A CSM who books outside the link, names a meeting ad-hoc, or keeps a legacy recurring under the old name will find their call doesn't show up on `/clients`, isn't retrieved by Ella, and renders without the Fathom checkmark on `/teams`. The friction is the lever.

Rationale captured in `docs/decisions/0002-title-convention-enforcement.md` (ADR) — including Nabeel's expectation that Drake make the new convention happen as part of growing into the Director role, plus the safety-net design (auto-create + merge UI + manual override).

## What gets dropped post-cutoff

- Calls with old-style titles (`[Client] Session with X`, etc.) — even when a known client is on the invite.
- The legacy `30mins with Scott` 1:1 pattern — replaced by `Coaching Call with Scott`.
- Ad-hoc titles (`Quick sync with Andrew`, `Catchup`, `Pipeline review`).
- Recurring meetings with legacy titles that keep generating instances — the new instances all drop out until the recurring series is renamed or rebooked through the link.

Internal-title patterns (CSM Sync, Backend Team, NCF, etc.) keep working post-cutoff — those continue to classify as `internal`. The cutoff gate only governs `client` classification.

## Auto-create on new patterns (2026-05-15)

When a post-cutoff call matches one of the six canonical title patterns AND has an external participant we can't resolve to an existing client, the classifier emits an `AutoCreateRequest` and the pipeline reifies a minimal `clients` row tagged `needs_review`. Closes the gap left by the cutoff (where unresolved-participant calls would have landed as `client` with `primary_client_id=null` forever) so every post-cutoff client call gets a client row attached.

Auto-create reason string: `"new title convention with unresolved participant"` (distinct from the legacy `30mins_with_Scott` reason). Surfaces in `metadata.auto_create_reason` for split-by-source audit queries.

Cleanup flow for auto-created rows lives at `docs/runbooks/auto_created_client_management.md` — covers the `/clients` needs-review filter, the merge button, the remove-tag button, and the missing-Slack badges that frequently co-occur with fresh auto-creates.

## Recovery: manual override

When a call SHOULD have been classified as `client` but the classifier dropped it (ad-hoc title for a legitimate client call, emergency reschedule outside the link, etc.), the fix is the manual override on the Calls detail page.

1. Open `/calls/[id]` for the affected call.
2. The classification fields (category / type / primary client) are editable inline.
3. Set `call_category` to `client` + select the client. Save.
4. Server action calls `update_call_classification` RPC; the row updates atomically.

This is the documented escape hatch — the cutoff gate doesn't touch manual reclassification. Use sparingly; the friction is supposed to teach the team the new convention, not be papered over.

## CSM-facing communication

When a CSM asks "why didn't my call show up on the client's detail page?":

1. **Check the title.** Does it start with one of the six canonical patterns? If not, that's the cause.
2. **Check `started_at`.** Is the call from 2026-05-18 or later? Pre-cutoff calls use the old cascade and should still classify normally.
3. **If the title is a legitimate exception**, walk them through the manual override on `/calls/[id]`.
4. **Send them to use the booking link next time.** Zain's links produce the canonical title automatically — no risk of drift.

## Audit queries

### Find recent post-cutoff calls that DIDN'T classify as client

```sql
SELECT id, title, started_at, call_category, classification_method, classification_confidence
FROM calls
WHERE started_at >= '2026-05-18 04:00:00+00'  -- 2026-05-18 00:00 EST = 04:00 UTC
  AND call_category != 'client'
ORDER BY started_at DESC
LIMIT 50;
```

Skimmed weekly to spot patterns: which CSMs are still using old titles, which booking links produce variants that don't match.

### Find post-cutoff calls that DID classify as client

```sql
SELECT id, title, started_at, classification_method, classification_confidence,
       primary_client_id
FROM calls
WHERE started_at >= '2026-05-18 04:00:00+00'
  AND call_category = 'client'
ORDER BY started_at DESC
LIMIT 50;
```

All new-convention matches show `classification_confidence=1.0`. `classification_method` splits the two conventions: v1 (`Coaching Call with Scott`) → `'title_pattern'`; v2 (`Andrew Hsu - Coaching Call with Scott`) → `'title_pattern_v2'`. To track v2 adoption specifically: `... AND classification_method = 'title_pattern_v2'`.

### Find legacy recurring meetings still firing

```sql
SELECT title, COUNT(*) as occurrences, MIN(started_at), MAX(started_at)
FROM calls
WHERE started_at >= '2026-05-18 04:00:00+00'
  AND call_category != 'client'
  AND lower(title) NOT LIKE 'coaching call%'
  AND lower(title) NOT LIKE 'sales call%'
  AND lower(title) NOT LIKE 'csm sync%'
GROUP BY title
HAVING COUNT(*) > 1
ORDER BY occurrences DESC;
```

Repeated non-canonical titles → recurring series that need renaming.

## Decision + code pointers

- ADR: `docs/decisions/0002-title-convention-enforcement.md` (why this rule exists; the management-lever framing).
- Code: `ingestion/fathom/classifier.py` — constants `NEW_CLIENT_TITLE_PATTERNS` + `_NEW_TITLE_CONVENTION_CUTOFF`; helpers `_matches_new_client_title_convention` + `_is_after_new_convention_cutoff` + `_classify_by_new_convention`.
- Tests: `tests/ingestion/fathom/test_classifier.py` — see test functions starting with `test_pre_cutoff_` / `test_post_cutoff_` / `test_cutoff_boundary_`.
