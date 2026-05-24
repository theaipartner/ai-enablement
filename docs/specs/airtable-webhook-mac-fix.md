# Airtable Webhook MAC Fix — Receiver Rejects Real Pings (401)
**Slug:** airtable-webhook-mac-fix
**Status:** in-flight
**Target branch:** main

## Context

Execute on `main` (worktree-b is gone). `git branch --show-current` to confirm. This is a focused bug fix to a SHIPPED, DEPLOYED receiver — not a rebuild.

The Airtable ingestion (`airtable-ingestion`) is live except the webhook path. Migration applied, backfill ran, cron works, webhook is registered + healthy on Airtable's side. The ONLY failure is the receiver rejecting real Airtable pings at MAC verification.

## The evidence (real, from production Vercel logs)

The webhook IS firing and reaching the receiver. Confirmed via `register_airtable_webhook.py --list`:
- `isHookEnabled: True`, `areNotificationsEnabled: True`
- `notificationUrl` correct (`https://ai-enablement-sigma.vercel.app/api/airtable_events`)
- **`cursorForNextPayload: 21`** — Airtable has generated 20+ payloads from real edits and advanced the cursor, so pings are firing and payloads exist server-side.

But every ping is rejected. Vercel log for `api/airtable_events`:
```
[WARNING] airtable_webhook: MAC verification failed sig_prefix=hmac-sha256=6c78
127.0.0.1 - - [24/May/2026 21:39:16] "POST /api/airtable_events HTTP/1.1" 401 -
```

So: the receiver computes a MAC, compares it to the header Airtable sent, they don't match → 401 → bails BEFORE writing any `webhook_deliveries` audit row (which is why the audit table shows zero `airtable_webhook` rows despite 20+ payloads). The header FORMAT assumption looks right (the `hmac-sha256=` prefix is present and the code parsed it). The MAC VALUE computation is what's wrong.

## The likely root cause (verify against Airtable's current docs)

Airtable's webhook MAC scheme (per the Web API webhook docs): the `macSecretBase64` returned at webhook creation is a **base64-encoded** secret. To verify a ping, you must:
1. **base64-DECODE `macSecretBase64` into raw key bytes** — NOT use the base64 string directly as the HMAC key. This is the #1 suspected bug — if `_verify_mac` uses the stored string as the key without decoding, every MAC mismatches.
2. Compute `HMAC-SHA256(key=decoded_bytes, msg=RAW_REQUEST_BODY_BYTES)`.
3. The expected header is `X-Airtable-Content-MAC: hmac-sha256=<hex>` — **confirm hex vs base64 for the digest encoding** against current docs. The log shows the code emitting `hmac-sha256=6c78...` which looks like HEX (6c78 = lowercase hex). Confirm Airtable sends hex (likely) — if Airtable actually sends base64, that's a second mismatch. Check the actual inbound header value against what the code computes.
4. Compute over the **raw request body bytes exactly as received** — not a re-serialized / re-parsed JSON. If the handler does `json.loads` then `json.dumps` and HMACs that, whitespace/key-order differences break the MAC. Must HMAC the untouched raw body.

## What to do

1. Read `api/airtable_events.py` `_verify_mac` (and how it reads the request body + the secret env var).
2. Diagnose against the four points above. The base64-decode-the-key issue (#1) is the prime suspect; the raw-body issue (#4) is the second. Confirm the exact scheme against Airtable's current webhook MAC docs — don't guess; the receiver already proved the high-level format (prefix present), so this is about the precise key-decoding + digest-encoding + body-bytes.
3. Fix `_verify_mac`. Likely small (base64-decode the key; ensure raw-body HMAC; match hex/base64 digest to what Airtable sends).
4. **Add a test** that reproduces the real scheme: given a known `macSecretBase64`, a known raw body, and the MAC Airtable's algorithm would produce, assert `_verify_mac` accepts it — AND assert it rejects a tampered body / wrong key. This locks the scheme so it can't regress. Use a synthetic secret/body in the fixture (no real secret committed).
5. Run `.venv/bin/python -m pytest tests/api/test_airtable_events.py -q` — all pass.

## Verify live (the real proof)

This bug is only fully confirmed fixed against a REAL ping, same as the original spec's step 8. After the fix is deployed (Drake pushes → Vercel redeploys):
- The webhook cursor is already at 21 with 20+ queued payloads — Airtable may re-deliver, OR Drake makes a fresh edit. Either way, a real ping should now verify.
- Confirm a `webhook_deliveries` row with `source='airtable_webhook'`, `processing_status='processed'` appears, AND the edited record's new value lands in `airtable_full_closer_report` / `airtable_setter_triage_calls`.
- Note: the 20+ already-queued payloads — once verification passes, the pull loop will fetch from `cursorForNextPayload` and may ingest the whole backlog of edits at once. That's fine (idempotent upsert on `record_id`), and actually good — it catches every edit made during the broken window.

## Gates / hard stops

- This is a code fix + redeploy. No migration, no new env vars, no Airtable writes. Deploy is via Drake's push to main → Vercel (gate (c) post-deploy verification).
- Do NOT echo the real MAC secret into logs/tests/report. The diagnostic log line showing `sig_prefix=hmac-sha256=6c78` is fine (truncated, not the secret) — keep that truncation; never log the full computed MAC or the key.
- If the scheme turns out NOT to be the base64-key issue, report what the actual mismatch is before assuming — but the cursor-advancing + format-parsed + value-mismatched evidence strongly points at key-decoding or body-bytes.

## What success looks like

- `_verify_mac` correctly verifies real Airtable MACs (base64-decoded key, raw-body HMAC, correct digest encoding).
- A regression test locks the exact scheme with a synthetic fixture.
- `tests/api/test_airtable_events.py` passes.
- After redeploy: a real Airtable edit produces a `processed` `airtable_webhook` audit row + the row data lands in the mirror table. The 20+ backlog payloads drain idempotently.
- Report at `docs/reports/airtable-webhook-mac-fix.md` documenting the actual root cause found (vs suspected), the fix, and the live-verification result. Confirm executed branch.

## Think this through

The header digest encoding (hex vs base64) being the mismatch INSTEAD of / IN ADDITION to the key-decoding — inspect a real inbound `X-Airtable-Content-MAC` value and compare byte-for-byte against what the code computes for the same body+key. The body already being consumed/re-serialized by the framework before `_verify_mac` sees it (ensure access to raw bytes). A trailing newline or encoding difference in the body. The MAC secret in Vercel not matching the one from registration (have Drake confirm the `AIRTABLE_WEBHOOK_MAC_SECRET` in Vercel is exactly the `macSecretBase64` the register script printed — a copy-paste truncation would also cause this; rule it out early since it's the cheapest check). Surface the real cause honestly.
