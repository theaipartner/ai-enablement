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

## Why this exists

Drake is pushing the team to use Zain's new booking links exclusively. The links generate one of the six canonical titles automatically. Making non-compliance technically visible — via classification dropping out — is the forcing function. A CSM who books outside the link, names a meeting ad-hoc, or keeps a legacy recurring under the old name will find their call doesn't show up on `/clients`, isn't retrieved by Ella, and renders without the Fathom checkmark on `/teams`. The friction is the lever.

Per spec `docs/specs/classifier-enforce-new-title-convention.md`. Spec context paragraph quotes the rationale (Nabeel's expectation that Drake make the new convention happen as part of growing into the Director role).

## What gets dropped post-cutoff

- Calls with old-style titles (`[Client] Session with X`, etc.) — even when a known client is on the invite.
- The legacy `30mins with Scott` 1:1 pattern — replaced by `Coaching Call with Scott`.
- Ad-hoc titles (`Quick sync with Andrew`, `Catchup`, `Pipeline review`).
- Recurring meetings with legacy titles that keep generating instances — the new instances all drop out until the recurring series is renamed or rebooked through the link.

Internal-title patterns (CSM Sync, Backend Team, NCF, etc.) keep working post-cutoff — those continue to classify as `internal`. The cutoff gate only governs `client` classification.

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

All new-convention matches will show `classification_method='title_pattern'` and `classification_confidence=1.0`.

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

## Spec + code pointers

- Spec: `docs/specs/classifier-enforce-new-title-convention.md`
- Code: `ingestion/fathom/classifier.py` — constants `NEW_CLIENT_TITLE_PATTERNS` + `_NEW_TITLE_CONVENTION_CUTOFF`; helpers `_matches_new_client_title_convention` + `_is_after_new_convention_cutoff` + `_classify_by_new_convention`.
- Tests: `tests/ingestion/fathom/test_classifier.py` — see test functions starting with `test_pre_cutoff_` / `test_post_cutoff_` / `test_cutoff_boundary_`.
