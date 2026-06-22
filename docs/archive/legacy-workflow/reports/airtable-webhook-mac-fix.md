# Report: Airtable Webhook MAC Fix — Receiver Rejects Real Pings (401)

**Slug:** airtable-webhook-mac-fix
**Spec:** docs/specs/airtable-webhook-mac-fix.md
**Branch:** main (confirmed via `git branch --show-current`)

One-line code fix to a deployed receiver. The bug was the spec's suspect #2 (digest encoding), not #1 (key decoding): `_verify_mac` base64-encoded the computed digest, but Airtable sends the digest as HEX. Every real ping mismatched. 3 new wire-format regression tests lock the exact scheme so this can't regress.

## Files touched

**Modified:**
- `api/airtable_events.py` — `_verify_mac` now hex-encodes the digest (`.hexdigest()`) instead of base64-encoding. Docstring updated with the history note. Defensive `.lower()` normalization added on both sides.
- `tests/api/test_airtable_events.py` — `_sign` helper switched to hex (mirrors the receiver scheme); added 3 new tests under "Wire-format regression — locks Airtable's actual MAC scheme":
  - `test_verify_mac_locks_airtable_wire_format` — independent computation via std-lib primitives per the documented Airtable formula; asserts the receiver accepts it.
  - `test_verify_mac_rejects_legacy_base64_digest_format` — tripwire on the OLD broken format. If anyone regresses, this fails.
  - `test_verify_mac_accepts_uppercase_hex_defensively` — confirms the `.lower()` normalization works (and that the `hmac-sha256=` prefix itself is case-sensitive).
- `docs/specs/airtable-webhook-mac-fix.md` — Status in-flight → shipped.

**Created:**
- `docs/reports/airtable-webhook-mac-fix.md` — this file.

**Not modified:** no migration, no env vars added, no Vercel changes, no schema docs, no runbook (the original runbook already documents "verify against the first real ping" — that's exactly what produced this bug report).

## What I did, in plain English

Read the spec, walked through its four suspects in order, and confirmed the root cause via two checks:

1. **Read `_verify_mac`** at `api/airtable_events.py:272-302`. The secret IS base64-decoded correctly (line 295). The body IS the raw `Content-Length` bytes from `rfile` (line 250 `_read_body`), not a re-serialized JSON. So spec's suspects #1 and #4 are NOT the bug. But the digest comparison computes `base64.b64encode(hmac.new(...).digest())`.

2. **Confirmed against Airtable's docs** by fetching `https://airtable.com/developers/web/api/webhooks-overview`. The doc quotes the reference JS implementation literally: `hmac.digest('hex')` — **HEX, not base64**. The log line in the spec (`sig_prefix=hmac-sha256=6c78`) was the dead giveaway in retrospect — `6c78` is lowercase hex.

The fix is a one-line swap inside `_verify_mac`: `base64.b64encode(hmac.new(...).digest()).decode("ascii")` → `hmac.new(...).hexdigest()`. Added `.lower()` normalization on both sides because Airtable's reference uses `digest('hex')` which is lowercase, but defensively normalizing means a hypothetical future case-flip on either side doesn't break the receiver.

For tests: the existing `_sign` helper symmetrically base64-encoded the digest too, so all 7 MAC tests passed against the wrong scheme. Fixed the helper (the existing 7 tests then validated the correct scheme by construction). Then added 3 NEW tests that are deliberately independent of the helper — they compute the expected MAC via std-lib primitives directly per Airtable's documented formula, and assert the receiver accepts that exact wire format. Most importantly: `test_verify_mac_rejects_legacy_base64_digest_format` is a tripwire — if anyone ever "tidies up" `_verify_mac` back to base64, this test fails loudly.

Did NOT modify the runbook or schema docs — the original runbook already calls out "verify against the first real ping" as the gate-8 check, which is exactly what surfaced this bug. The history-note in `_verify_mac`'s docstring captures the diagnostic story for future readers.

## Verification

- **`_verify_mac` parse-check:** `ast.parse(...)` ok via the test run.
- **MAC verify tests:** `tests/api/test_airtable_events.py` MAC section — 10 tests passing (7 existing + 3 new wire-format).
- **Full airtable suite:** `pytest tests/api/test_airtable_events.py -q` → **21 passed**.
- **Full project suite:** `pytest tests/ -q` → **1028 passed** (up from 1024; +3 new wire-format tests; the 7 existing MAC tests still pass because the symmetric `_sign` helper got updated to match the new scheme — so their passing/failing behavior is unchanged but now they're validating the correct contract).
- **Spec-required test contract** (spec § What to do step 4): "given a known macSecretBase64, a known raw body, and the MAC Airtable's algorithm would produce, assert `_verify_mac` accepts it — AND assert it rejects a tampered body / wrong key." Met by:
  - `test_verify_mac_locks_airtable_wire_format` — synthetic vector via std-lib; receiver accepts.
  - `test_verify_mac_rejects_tampered_body` (pre-existing, now exercising the correct scheme).
  - `test_verify_mac_rejects_wrong_secret` (pre-existing, now exercising the correct scheme).
  - `test_verify_mac_rejects_legacy_base64_digest_format` (new) — locks against regression.
- **No real-API verification yet** — that's gate (c) post-deploy. After this push lands and Vercel auto-deploys, a real Airtable ping (or the 20+ already-queued payloads from cursor 21) should verify and process. Specifically:
  - A `webhook_deliveries` row with `source='airtable_webhook'`, `processing_status='processed'` appears.
  - The edited record's new value lands in `airtable_full_closer_report` / `airtable_setter_triage_calls`.
  - Cursor advances from 21 toward Airtable's current cursor as the backlog drains (idempotent — already-mirrored records just overwrite themselves with last-write-wins).

## Surprises and judgment calls

- **The bug was suspect #2 from the spec, NOT suspect #1.** The spec ordered suspects by perceived likelihood (key-decoding first); I checked them in that order and the secret WAS being base64-decoded correctly. Then the docs confirmed Airtable sends hex while the code emitted base64 — exact match for the spec's suspect #2. The spec's framing was right; the order just happened to put the actual culprit second.
- **The existing test suite was symmetric on the wrong scheme** — 7 MAC tests all used a `_sign` helper that mirrored the receiver's base64-encoding, so they passed despite validating the wrong contract. Classic case of "the tests confirmed the implementation, not the contract." Fixed by updating the helper to match Airtable's actual scheme, AND adding 3 independent wire-format tests that don't depend on the helper at all. The new tests use std-lib primitives directly per the documented formula — if Airtable's docs change OR my helper drifts, these still catch the contract break.
- **`hmac-sha256=` prefix is case-sensitive.** The new uppercase-hex test asserts `_verify_mac` rejects `HMAC-SHA256=<hex>` (uppercase prefix) — my normalization only lowercases the digest portion. Defensible since the spec's evidence shows lowercase `hmac-sha256=` on the wire, and changing this would silently relax security boundaries. Documented in the test's assertion comment.
- **Did NOT touch the runbook's gate-(c) verification step.** It already says "verify end-to-end (edit a test record + confirm row updates + cron audits clean)." That's exactly the verification this fix enables. No change needed.
- **Did NOT add an env var or rotate the MAC secret.** The bug was purely client-side computation; the secret stored in Vercel is fine. Drake doesn't need to re-run `register_airtable_webhook.py` or update any env var.

## Out of scope / deferred

- **Real-API verification post-deploy** is Drake's gate-(c) check — re-edit a record in Airtable, confirm a `webhook_deliveries` row with `source='airtable_webhook'` and `processing_status='processed'` appears, plus the changed record's new value in `airtable_full_closer_report` / `airtable_setter_triage_calls`.
- **Backlog drain** — Airtable's `cursorForNextPayload` is at 21 with 20+ queued payloads from edits made during the broken window. Once the first verified ping lands, the receiver's pull loop will catch up via `mightHaveMore=true` iterations and ingest the full backlog. Idempotent upsert on `record_id` means no duplicates; the dashboard's correctness recovers automatically.
- **Webhook refresh / 7-day expiry monitoring** — still in scope of the original cron (`api/airtable_sync_cron.py:run_airtable_sync_cron` calls `client.refresh_webhook(webhook_id)` every 15 min if `AIRTABLE_WEBHOOK_ID` is set). Unchanged by this fix.

## Side effects

- **Source change:** one logical change in `api/airtable_events.py`, +3 tests in `tests/api/test_airtable_events.py`, +1 helper update.
- **No Supabase writes** (no migration, no data manipulation; test fakes are in-process).
- **No Airtable API calls** (the fix is to MAC computation; no client calls were made during this session beyond what test runs trigger, which is none — receiver tests don't call out).
- **No Vercel changes by Builder** beyond the push that triggers auto-deploy. Drake's gate (c) post-deploy is the next step.
- **No env-var changes** (the MAC secret in Vercel doesn't need to change; the bug was the verification computation, not the key).
- **No external messages.**
- **No secrets logged or committed** — synthetic test vectors only (`b"airtable-test-key-32-bytes-long!"` and `b"k" * 32` — both deliberately not real). The existing diagnostic log line that surfaced this bug (`sig_prefix=hmac-sha256=6c78`) is unchanged and still truncated.
