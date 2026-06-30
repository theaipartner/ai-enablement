# Runbook: Typeform Ingestion

How to operate the Typeform mirror: backfill, webhook activation, the 8-step go-live order, and the recurring tasks (re-registering when a new funnel form ships).

## What this mirrors

Two tables, both populated by `ingestion/typeform/`:
- `typeform_forms` — form definitions (~31 rows).
- `typeform_responses` — per-submission lead stream.

## Three ingest paths (all converge on the same idempotent upsert)

| Path | Trigger | What it does |
|------|---------|--------------|
| **Webhook (primary)** | Typeform `form_response` delivery → `/api/typeform_events` | HMAC-verified per-submission upsert. Real-time. |
| **Cron backstop** | `*/15 * * * *` → `/api/typeform_sync_cron` | Refreshes form definitions + re-walks the last 6h of responses (`since=now-6h`). Catches webhook misses. |
| **Backfill** | `scripts/backfill_typeform.py --apply` | Walks every form's full history via cursor pagination. |

All three use the same parser (`ingestion/typeform/parser.py`) and same idempotent `UPSERT ON CONFLICT (response_id)` — double-writes are no-ops.

## 8-step activation runbook

The interdependent order of operations to bring Typeform ingestion live. Each step assumes the previous one landed clean.

### Step 1: Apply migration `0048`

```bash
# Sequence against any other pending migration apply first —
# this hits the shared cloud DB. Coordinate timing.
DB_PW=$(.venv/bin/python -c "
from pathlib import Path
for ln in Path('.env.local').read_text().splitlines():
    if ln.startswith('SUPABASE_DB_PASSWORD='):
        print(ln.partition('=')[2].strip().strip('\"').strip(\"'\"))
        break
")
supabase db push --linked --dns-resolver https --password "$DB_PW" --yes
```

Dual-verify (per `docs/runbooks/apply_migrations.md`):
- `SELECT to_regclass('public.typeform_forms')` — non-null.
- `SELECT to_regclass('public.typeform_responses')` — non-null.
- `SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '0048'` — exactly 1 row.

### Step 2: Merge + deploy the receiver

The git push that lands this work auto-deploys via the Vercel GitHub integration (post-2026-05-08 cache fix; reliable). Watch the Vercel dashboard.

### Step 3: Confirm receiver URL is reachable

```bash
curl -i https://ai-enablement-sigma.vercel.app/api/typeform_events
# Expect HTTP 200 with body {"status":"ok","endpoint":"typeform_events","accepts":"POST"}
```

### Step 4: Add `TYPEFORM_WEBHOOK_SECRET` to Vercel

```bash
# Generate (e.g.):
openssl rand -hex 32
```

Add the value to Vercel env vars (Project → Settings → Environment Variables → `TYPEFORM_WEBHOOK_SECRET`), then redeploy to pick it up. Confirm by curl'ing the receiver — it should now respond `500 {"error":"misconfigured"}` ONLY if the var is missing; once set, signature mismatches surface as `401 signature_invalid` and missing-signature requests surface as `401`.

Also confirm `TYPEFORM_API_KEY` is in Vercel (for the cron + the receiver's lazy form-sync). It's already in `.env.local`; add it to Vercel.

### Step 5: Backfill — smoke then apply

```bash
# Smoke first — one form, one page, idempotent. Run from main checkout.
.venv/bin/python scripts/backfill_typeform.py --smoke

# Then apply — all forms, all history. Per the CLAUDE.md
# "real-API smoke test before --apply" rule.
.venv/bin/python scripts/backfill_typeform.py --apply
```

Volume estimate (from discovery): ~14k responses across 8 active+dormant funnels; with page_size=1000 cursor pagination + ~31 form-definition pulls, the full backfill should complete in a few minutes.

### Step 6: Register webhooks on active forms

```bash
# Export the same secret you set in Vercel.
export TYPEFORM_WEBHOOK_SECRET=$(openssl rand -hex 32)   # or read from Vercel UI

# Dry-run first.
.venv/bin/python scripts/register_typeform_webhooks.py \
    --dry-run --url https://ai-enablement-sigma.vercel.app/api/typeform_events

# Apply.
.venv/bin/python scripts/register_typeform_webhooks.py \
    --apply --url https://ai-enablement-sigma.vercel.app/api/typeform_events
```

Active-form selection rule: forms with a submission within the last 30 days. NOT a hardcoded id list — at discovery time that's `PWSNd0h2` (Setter), `SFedWelr` (Closer), `N57lwMmA` (Organic), and any others inside the window. Dead forms (`w0atrvMi`, `QmTC4Tx2`, `poifwp1H`, etc.) are excluded — they have no traffic so they don't need real-time pings; the cron backstop still mirrors their (zero) new responses.

The script is idempotent on `(form_id, tag='ai-enablement-prod')` — safe to re-run.

### Step 7: Verify end-to-end (post-deploy on real surfaces)

Submit a test response on the Setter Funnel (or any active form), then within seconds check:

```sql
-- Should show a new row for the form you just submitted to.
SELECT response_id, form_id, submitted_at, ingested_at
FROM typeform_responses
WHERE form_id = 'PWSNd0h2'                -- substitute the test form
ORDER BY ingested_at DESC
LIMIT 5;

-- And a corresponding audit row.
SELECT webhook_id, source, processing_status, processed_at, processing_error
FROM webhook_deliveries
WHERE source = 'typeform_response_webhook'
ORDER BY received_at DESC
LIMIT 10;
```

Look for: response row present + `processing_status='processed'` on the audit row + `processing_error IS NULL`.

If a signature failure shows up (`signature_invalid` in Vercel logs), the secret in Vercel ≠ the secret the registration script used. Re-run the registration with the matching secret.

### Step 8: Confirm cron backstop fires + audits clean

```sql
-- Wait ~16 min after the apply, then:
SELECT webhook_id, processing_status, payload, processed_at
FROM webhook_deliveries
WHERE source = 'typeform_sync_cron'
ORDER BY processed_at DESC
LIMIT 5;
```

Expect: `processing_status='processed'`, payload containing `forms_synced`, `responses_synced`, `since` (the safety-window timestamp).

## Recurring tasks

### Adding a new funnel form

The registration script auto-detects active forms by recency. When a new funnel is spun up:

1. Once it has its first submission, it becomes "active" per the 30-day window.
2. Re-run `register_typeform_webhooks.py --apply` (idempotent on (form_id, tag)).
3. The cron backstop already mirrors it (cron walks all forms).
4. The lazy form-definition sync in the receiver covers the first webhook delivery from a never-mirrored form (best-effort).

### Removing a webhook (cleanup)

```bash
.venv/bin/python scripts/register_typeform_webhooks.py \
    --delete --url <unused>   # --url is required by argparse but ignored for delete
```

Removes the `ai-enablement-prod` tag from all currently-active forms. Doesn't touch the mirror tables.

### Re-running backfill

`scripts/backfill_typeform.py --apply` is idempotent. Safe to re-run end-to-end at any time. Useful if the parser changes or if a future schema change adds a column derived from existing `answers` jsonb.

## Failure modes

**Webhook signature mismatch.** Receiver logs `signature_invalid`. Either (i) the Vercel `TYPEFORM_WEBHOOK_SECRET` ≠ the secret used during registration, or (ii) the body got modified in transit (load balancer, proxy). For (i), re-run `register_typeform_webhooks.py --apply` with the secret matching Vercel. For (ii), confirm there's no proxy between Vercel and Typeform munging the body.

**Cron backstop reporting `typeform_token_unavailable`.** `TYPEFORM_API_KEY` not in Vercel env. Add it + redeploy.

**Backfill `HTTP 400 BAD_REQUEST "can't use before/after param together with sort"`.** Someone added a `sort` param to `ingestion/typeform/client.py:list_responses` or `iter_responses`. Revert — default sort is `submitted_at desc` which is what cursor backfill wants. This is documented inline in the client + the schema docs because it WILL re-bite if "tidied up."

**Receiver returns 2xx but no row lands.** Check `webhook_deliveries.processing_status` for the matching `webhook_id`. If `failed`, look at `processing_error`. If `processed` but no `typeform_responses` row, the payload's `form_response.token` / `response_id` was empty (envelope shape changed); the receiver logs `typeform_webhook: missing response_id`.

**Typeform disabled the subscription.** If a webhook returns 5xx repeatedly Typeform disables it. The receiver's fail-soft (always 2xx on handled error) prevents this. If it still disables — confirm Vercel cold-start error rate; re-register via `register_typeform_webhooks.py --apply`.

## Active-form-list audit

Periodically (or after a funnel rotation):

```bash
.venv/bin/python scripts/register_typeform_webhooks.py
# Lists active forms (no --apply / --dry-run) + existing subscriptions per form.
```

Confirms the webhook tags match the active set. If a newly-active form doesn't have the `ai-enablement-prod` tag, re-register.
