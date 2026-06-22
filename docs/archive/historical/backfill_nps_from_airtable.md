# Runbook: Backfill `clients.nps_standing` from Airtable NPS Survery

One-shot script to pull historical NPS Survey segment classifications from Airtable into Gregory. Path 1 receiver auto-fires for new submissions; this script fills in the historical gap so Scott's Monday onboarding sees populated `nps_standing` data instead of empty.

Script: `scripts/backfill_nps_from_airtable.py`. First run: 2026-05-03.

## When to run

- **One-shot.** Run once after the receiver goes live, then archive mentally. The receiver's automation handles future submissions.
- Re-run only if Airtable's NPS Survery table picks up a backfill of historical rows that aren't already in Gregory, OR if the receiver was down during a window of new submissions and Airtable's webhook didn't retry.
- If Airtable's table or field names change, edit the constants at the top of the script and re-run. The constants block lists the discovered IDs from the M5.4 metadata API probe.

## Modes

- **Dry-run (default).** Prints what WOULD be sent — no HTTP requests, no DB writes. Use this first.

  ```bash
  .venv/bin/python scripts/backfill_nps_from_airtable.py
  ```

- **Apply.** Fires real POSTs to the production receiver. Same code path as Airtable's automation — same `webhook_deliveries` audit trail, same override-sticky semantics.

  ```bash
  .venv/bin/python scripts/backfill_nps_from_airtable.py --apply
  ```

- **Limit (smoke test).** Processes at most N clients after dedup. Run before full apply to verify the contract end-to-end without committing to the full ~60–80 row sweep.

  ```bash
  .venv/bin/python scripts/backfill_nps_from_airtable.py --apply --limit 3
  ```

- **Override receiver URL.** For local-receiver testing or pointing at a preview deploy.

  ```bash
  .venv/bin/python scripts/backfill_nps_from_airtable.py --apply \
    --receiver-url http://127.0.0.1:8000/api/airtable_nps_webhook
  ```

## Required env (loaded from `.env.local`)

| Var | Purpose |
|---|---|
| `AIRTABLE_API_KEY` | Read access to the CSM base. Personal access token with read scope on `appSn7Oiit9dFEWb6`. |
| `AIRTABLE_NPS_WEBHOOK_SECRET` | Auth header for the receiver. Same value Airtable's automation sends. Required only with `--apply`. |
| `RECEIVER_URL` | Optional override. Default: production. |

## Report sections — what they mean

The script prints a per-client outcome line, then a summary. Bucket meanings:

| Bucket | Meaning |
|---|---|
| `total_survery_rows` | Raw count of rows in NPS Survery (Airtable side). |
| `distinct_clients` | Count after deduping by linked NPS Clients record (latest Survey Date wins). |
| `skipped_no_link` | Survery row had zero linked NPS Clients records — orphaned survey. Manual review at the Survery row level. |
| `skipped_ambiguous_link` | Survery row had >1 linked NPS Clients records — script can't tell which client gets the segment. The summary lists each row id; investigate and resolve in Airtable, then re-run. |
| `skipped_no_segment` | Survery row's Segment Classification was empty. This formula evaluates to non-empty only when key fields are filled — a blank means the survey didn't classify. Skipping matches the receiver's automation gate. |
| `skipped_no_email` | Linked NPS Clients row had no Email field set. Airtable-side data gap; fix in Airtable then re-run. |
| `sent_success` | Receiver returned 200. `nps_standing` was written; `csm_standing` may have been auto-derived (subject to override-sticky). The summary breaks `auto_derive_applied=true` vs `false` counts — see receiver docs for the inference's known false-positive case. |
| `sent_404_client_not_found` | Receiver couldn't resolve the email to any active Gregory client. The most useful signal in the report — see "Failure modes" below. |
| `sent_other_error` | Anything else (5xx from receiver, 4xx from validation, etc.). Investigate per-row. |

## Failure modes

### Many `sent_404_client_not_found` errors

Most likely cause: **email mismatch between Airtable and Gregory**. Sources of mismatch:

- Airtable's NPS Clients holds the email Scott's team typed at sign-up; Gregory's `clients.email` was seeded from the master sheet (also Scott's team, but a different export). Mismatches happen when the work email vs personal email got entered differently.
- Whitespace, case, or trailing-period oddities. The receiver's RPC normalizes (case-insensitive, whitespace-strip), so these usually resolve cleanly.
- The Airtable email isn't the primary in Gregory but IS in `clients.metadata.alternate_emails`. Receiver checks the fallback automatically.

The 404 list IS the value. It tells Scott which Airtable rows don't match any Gregory record — useful signal, not a script bug. Triage:

1. For each 404, look up the client name in Gregory dashboard's clients list.
2. If they exist with a different email: add the Airtable email to `clients.metadata.alternate_emails` (via merge_clients RPC if there's a needs_review duplicate to clean up, or directly via dashboard if surfaced).
3. If they don't exist in Gregory at all: the client may have been archived or never imported. Decide case-by-case.
4. Re-run the script. The previously-404 rows will now succeed.

### Rate limit hit

Airtable: 5 req/sec per base, but the script only reads (~2 reads total: clients then survery). Vercel: cold starts can stack on burst. The script's `INTER_REQUEST_SLEEP_SECONDS = 0.2` keeps us at ~5 req/sec to the receiver, well below Vercel's serverless concurrency limits.

If a 429 surfaces from the receiver: increase `INTER_REQUEST_SLEEP_SECONDS` at the top of the script, re-run. Idempotency means re-running is safe.

### Receiver down

If the receiver returns 5xx for every request: check Vercel deploy status, check `AIRTABLE_NPS_WEBHOOK_SECRET` env var is set in Production scope. The script's `sent_other_error` bucket captures these — body preview helps diagnose.

## Cleanup — revert a single client

If the backfill wrote `nps_standing` to a client that shouldn't have received it (manual review surfaced the wrong target), revert via direct SQL:

```sql
-- Clear nps_standing only.
UPDATE clients SET nps_standing = NULL
WHERE id = '<client-uuid>';

-- Also revert csm_standing if the auto-derive fired and you want it back to its prior value.
-- The 0018 RPC's null-clear path skips the history insert (history table can't represent null) —
-- the audit row from the auto-derive remains as record-of-what-happened.
SELECT update_client_csm_standing_with_history(
  '<client-uuid>'::uuid, NULL, NULL, 'backfill rollback'
);
```

For revert at scale (multiple clients), build a list of client_ids first, then batch the UPDATE. Don't blanket-clear `nps_standing` across all rows — you'd lose data the receiver's automation has since written.

## Discovered constants (don't change without re-probing the schema)

```python
BASE_ID = "appSn7Oiit9dFEWb6"
NPS_SURVERY_TABLE = "tbl5KW3o3jhdxvASz"   # sic: "Survery" matches Airtable
NPS_CLIENTS_TABLE = "tbllKMffVeoO1jmef"
```

Field names (exact, case-sensitive):
- NPS Survery: `'NPS Clients'`, `'Survey Date'`, `'Segment Classification'`
- NPS Clients: `'Name'`, `'Email'`

If any of these change in Airtable, the script will fail noisily. Re-probe via `https://api.airtable.com/v0/meta/bases/<BASE_ID>/tables` and update.
