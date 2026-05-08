# Runbook — Path 3 inbound onboarding form receiver

Operational guide for `api/airtable_onboarding_webhook.py` — the POST endpoint Make.com hits when Zain's onboarding flow fires (Slack channel created → client invited → form submitted in Airtable).

**Endpoint:** `https://ai-enablement-sigma.vercel.app/api/airtable_onboarding_webhook`
**Method:** POST (GET returns 200 friendly hint for uptime probes)
**Auth:** `X-Webhook-Secret` header against `AIRTABLE_ONBOARDING_WEBHOOK_SECRET` env var
**Cadence:** ad-hoc — once per new-client signup (Make.com automation)
**Architecture:** see `docs/agents/gregory.md` § "Airtable onboarding integration"

---

## Quick health check

```bash
curl -s https://ai-enablement-sigma.vercel.app/api/airtable_onboarding_webhook | jq
```

Expected: `{"status": "ok", "endpoint": "airtable_onboarding_webhook", "accepts": "POST"}`. The friendly GET requires no auth — useful for uptime monitors and "is the function deployed?" checks.

To verify the auth path works without invoking the RPC, send a POST with a wrong secret — should return 401 `{"error": "unauthorized"}`.

---

## Rotate the shared secret

Same shape as Path 2 outbound's secret rotation. The secret is shared between Vercel (server side) and Make.com (caller side). Rotation must update both, or Make.com's deliveries will 401 until updated.

1. **Mint a new secret locally.**
   ```bash
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```

2. **Update Vercel first** (NOT Make.com — Make.com keeps using the old secret until step 4). Project → Settings → Environment Variables → `AIRTABLE_ONBOARDING_WEBHOOK_SECRET` → Edit → paste new value → Save → Production scope only. Trigger a redeploy.

3. **Wait for the redeploy to land.** POST with the OLD secret should now 401; POST with the NEW secret should 200 (or whatever validation result the payload produces).

4. **Update Make.com.** Drake or Zain edits the onboarding scenario's HTTP module → Headers → `X-Webhook-Secret` → paste new value → save scenario.

5. **Update `.env.local`** for harness runs: `AIRTABLE_ONBOARDING_WEBHOOK_SECRET=<new value>`. NOT committed.

**Window of disruption:** between step 2 and step 4, any onboarding form submission will 401 and Zain's automation will surface the error. New-client onboardings are rare-to-rare-ish so this is usually a near-zero-impact rotation; time it for a quiet window if possible.

---

## Payload shape (Make.com → receiver)

```json
{
  "full_name":        "Jane Doe",
  "email":            "jane@example.com",
  "country":          "USA",
  "date_joined":      "2026-05-05",
  "phone":            "+1 555-123-4567",
  "slack_user_id":    "U01ABC123",
  "slack_channel_id": "C01ABC456"
}
```

**Required (4):** `full_name`, `email`, `country`, `date_joined`. Non-null, string-typed, non-empty after strip. `date_joined` accepts ISO date (`"2026-05-05"`) or full ISO datetime (`"2026-05-05T14:30:00Z"`); both parse to a `date` for storage in `clients.start_date`.

**Optional (3):** `phone`, `slack_user_id`, `slack_channel_id`. Each may be omitted from the payload OR sent as `null`. If PRESENT in the payload, the value must be a non-empty string after strip — sending `""` is a 400 `wrong_type` (we surface the operator error rather than silently coerce). The receiver passes `null` to the RPC for any optional field that's absent / null in the payload.

Country isn't validated against a vocab — Zain owns the contract. Today's expected values are `'USA'` / `'AUS'`, but anything else passes through as-is. (See followup in `docs/known-issues.md` about `/clients` filter drift if Zain ever sends `'United States'`.)

---

## Re-fire to add slack IDs

The optional-fields contract supports a two-pass onboarding flow. Zain often fires the form for a new client BEFORE the Slack channel is provisioned — the client lands in Gregory immediately, then Zain re-fires the same form later when the IDs are in hand. The system handles this without duplicate clients or reconciliation work.

**First pass — no slack IDs:**

```json
{
  "full_name": "Jane Doe",
  "email": "jane@example.com",
  "country": "USA",
  "date_joined": "2026-05-05"
}
```

Result: `action='created'`. Client lands with `slack_user_id IS NULL` and no `slack_channels` row. `tags=['needs_review']`, `status='active'`, `csm_standing='content'` per the standard create branch.

**Second pass — same email, slack IDs populated:**

```json
{
  "full_name": "Jane Doe",
  "email": "jane@example.com",
  "country": "USA",
  "date_joined": "2026-05-05",
  "slack_user_id": "U01ABC123",
  "slack_channel_id": "C01ABC456"
}
```

Result: `action='updated'`. Email match hits the active branch:

- `clients.slack_user_id` backfills via `coalesce` (was `NULL`, becomes `U01ABC123`).
- `slack_channels` resolution runs Branch C (no global match for the channel id) → fresh INSERT linked to this client with `name=full_name`, `is_archived=false`, `metadata.created_via='onboarding_webhook'`.
- `phone` backfills the same way if it was `NULL` first time around.
- Status / csm_standing stay where they are (idempotent transitions).

**Partial re-fires** (e.g. slack_user_id but no slack_channel_id) work the same way: only the populated fields are backfilled. No `slack_channels` row is created when channel id is omitted.

**Re-firing with slack IDs that conflict with existing values** still returns 409 — the optional fields don't relax the anti-overwrite semantics. If the existing client already has `slack_user_id='U01XYZ'` and the re-fire sends `'U01ABC'`, that's a `slack_user_id_conflict` 409. Same for `slack_channel_id_*` paths. See "Debug a Slack ID conflict" below.

---

## Response shapes

| Status | Body | When |
|---|---|---|
| 200 | `{"status": "ok", "delivery_id": "...", "client_id": "...", "action": "created\|updated\|reactivated"}` | success |
| 400 | `{"error": "invalid_json"}` | body not parseable JSON |
| 400 | `{"error": "payload_not_object"}` | body is JSON but not an object |
| 400 | `{"error": "missing_field", "detail": "<field> is required"}` | required field missing or empty after strip |
| 400 | `{"error": "wrong_type", "detail": "..."}` | type mismatch (any field non-string, or `date_joined` unparseable) |
| 401 | `{"error": "unauthorized"}` | missing or wrong `X-Webhook-Secret` |
| 409 | `{"error": "slack_user_id_conflict", "detail": "existing=X new=Y..."}` | existing client has slack_user_id, payload sent a different one |
| 409 | `{"error": "slack_channel_id_conflict_for_client", "detail": "..."}` | existing client has an active slack_channels row for a different channel |
| 409 | `{"error": "slack_channel_id_owned_by_different_client", "detail": "..."}` | the payload's slack_channel_id is already linked to a different client |
| 500 | `{"error": "misconfigured"}` | env var unset |
| 500 | `{"error": "rpc_failed"}` | RPC raised an exception that wasn't a known conflict |
| 500 | `{"error": "internal_error"}` | unhandled exception in handler |

The `action` field on 200 distinguishes the three branches:

| `action` | Meaning |
|---|---|
| `created` | Email matched no existing row (active or archived); fresh INSERT |
| `updated` | Email matched an active client (primary or via `metadata.alternate_emails`); fields backfilled where null, status/csm_standing/tags refreshed |
| `reactivated` | Email matched a soft-archived client; `archived_at` cleared, then same field updates as `updated` |

All three result in `tags` containing `'needs_review'` so the row surfaces in the dashboard's Needs Review filter.

---

## Debug a missing client

If Zain reports "I submitted the onboarding form for Jane Doe but she's not in Gregory":

1. **Check the Make.com scenario history** for the run timestamp. Confirm the HTTP module fired and what response code came back.

2. **Find the webhook_deliveries row.** Every authed request writes one (auth failures don't). Search by source + recent timestamp:

   ```sql
   SELECT webhook_id, processing_status, processing_error,
          payload->>'email', received_at, processed_at
   FROM webhook_deliveries
   WHERE source = 'airtable_onboarding_webhook'
     AND received_at > now() - interval '1 day'
   ORDER BY received_at DESC
   LIMIT 20;
   ```

   Match by email or recent timestamp. Possible states:

   - `processing_status='processed'` with no `processing_error` → success. Client should exist; check `clients` by the payload email.
   - `processing_status='failed'` → check `processing_error`. Common: Slack ID conflict (409), RPC raised (500). The error text contains the structured exception substring.
   - `processing_status='malformed'` → 400 validation rejected the payload. `processing_error` says which field.
   - **No row at all** → Make.com never reached us, OR the request 401'd (auth failures write no row). Check Vercel function logs for `airtable_onboarding_webhook: unauthorized`.

3. **If processed but client missing,** the email column may have been stored lowercased — search case-insensitively:

   ```sql
   SELECT id, email, full_name, status, archived_at, tags
   FROM clients
   WHERE lower(trim(email)) = lower(trim('jane@example.com'));
   ```

   Also check `metadata->'alternate_emails'`:

   ```sql
   SELECT id, email, full_name, archived_at,
          metadata->'alternate_emails' AS alternates
   FROM clients
   WHERE EXISTS (
     SELECT 1 FROM jsonb_array_elements_text(
       coalesce(metadata->'alternate_emails', '[]'::jsonb)
     ) alt
     WHERE lower(trim(alt)) = lower(trim('jane@example.com'))
   );
   ```

   If found via alternate_emails with a different primary email, `action` was `updated` (not `created`) — the existing canonical row got the form's payload merged in.

4. **If `action='reactivated'`,** the client existed in an archived state (e.g. churned then re-signed). Verify no surprises by checking when they were originally archived:

   ```sql
   SELECT changed_at FROM client_status_history
   WHERE client_id = '<uuid>' AND status = 'churned'
   ORDER BY changed_at DESC LIMIT 1;
   ```

   The reactivation didn't delete history — the archived → active transition is one row in `client_status_history` (idempotent if the client was already at `status='active'` pre-archive, but most archive flows put a `churned` history row first).

---

## Debug a Slack ID conflict

If Zain reports "I got a 409":

1. **Determine which conflict.** The response body's `error` field tells you:
   - `slack_user_id_conflict`: existing client.slack_user_id ≠ payload's
   - `slack_channel_id_conflict_for_client`: existing client has an active slack_channels row for a different channel id
   - `slack_channel_id_owned_by_different_client`: the payload's channel id is linked to a different client elsewhere in the table

2. **Confirm via SQL.** Pull the existing client and the colliding row:

   ```sql
   -- For slack_user_id conflict
   SELECT id, email, full_name, slack_user_id, archived_at
   FROM clients
   WHERE lower(trim(email)) = lower(trim('<payload email>'));
   ```

   ```sql
   -- For slack_channel_id conflicts
   SELECT slack_channel_id, client_id, is_archived, name
   FROM slack_channels
   WHERE slack_channel_id = '<payload slack_channel_id>';
   ```

3. **Resolve.** Common causes + fixes:

   - **Zain re-issued a Slack id by mistake** (typo in Make.com, or Make.com sent a stale value): correct the form submission and re-fire. Make.com automation can usually replay the latest run.
   - **The existing client genuinely shouldn't have that slack_user_id** (orphan from old Slack workspace, manual data error): clear `clients.slack_user_id = NULL` for the affected client via the dashboard or direct SQL, then ask Make.com to retry.
   - **The slack_channel_id is owned by a different client** (the channel was previously linked to someone else who churned, or to a now-merged duplicate): this is rarer; investigate the orphan row in `slack_channels` and either reattach (set `client_id = NULL`) or delete the stale link before retrying.

4. **None of these silently overwrite anything.** Per spec: established Slack identities are sticky. The 409 is the safety net.

---

## Re-running the local harness

Always safe to run — uses self-seeded per-run fixtures, no reliance on production fixture clients. Spins up the receiver in a background thread; reads/writes cloud DB for verification + cleanup.

```bash
.venv/bin/python scripts/test_airtable_onboarding_webhook_locally.py
```

Expected: all checks pass (count grows over time as new tests land — current target is the count printed at the end of the run). The harness creates and hard-deletes its synthetic fixture in cleanup; soft-archives any happy-path created clients. The 5b/5c/5d optional-field tests depend on migration 0026 being applied; pre-0026 they fail with a `phone is required` RPC raise.

---

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `HTTP 401` from Make.com | Secret out of sync after rotation | Sync Make.com to the new secret |
| `HTTP 500 misconfigured` | `AIRTABLE_ONBOARDING_WEBHOOK_SECRET` not set in Vercel | Set env var, redeploy |
| `HTTP 400 missing_field` | Make.com mapping dropped one of the 4 required fields (full_name / email / country / date_joined) | Check Zain's Airtable → Make.com field mapping. Phone / slack_user_id / slack_channel_id are optional and don't trigger this. |
| `HTTP 400 wrong_type` (`<field> must be non-empty when present`) | Make.com mapped an optional field to `""` instead of omitting it | Update the Make.com mapping to omit the field when the source cell is blank, OR set null explicitly |
| `HTTP 400 wrong_type` (`date_joined: ...`) | Date isn't ISO date or ISO datetime | Check the Airtable date format export setting |
| `HTTP 409 slack_user_id_conflict` | Established client has a different slack_user_id | See "Debug a Slack ID conflict" above |
| `HTTP 409 slack_channel_id_*` | Channel id already linked elsewhere or to a different client | See "Debug a Slack ID conflict" above |
| `HTTP 500 rpc_failed` | Schema regression or RPC bug | Check Vercel function logs for the traceback; check `webhook_deliveries.processing_error` |
| Client created but missing fields | Branch was `updated` or `reactivated`, existing-non-null wins | Backfill semantics by design — manually edit the missing field via the dashboard |
| `tags` contains `needs_review` repeatedly | Should never happen — RPC dedupes via DISTINCT-on-unnest | Check `clients.tags` directly; if duplicates land, file a bug |

---

## Schema + audit references

- Migration: `supabase/migrations/0025_create_or_update_client_from_onboarding.sql`
- Receiver: `api/airtable_onboarding_webhook.py`
- Harness: `scripts/test_airtable_onboarding_webhook_locally.py`
- Build log entry: `docs/agents/gregory.md` § Airtable onboarding integration (V1 — M5.9)

The RPC's note strings are deliberately distinct from other Gregory Bot writes — grep `client_status_history.note` and `client_standing_history.note` for `'onboarding form initial seed'` (create branch) or `'onboarding form submission'` (update / reactivate branch) to find audit rows attributable to this flow.
