# Runbook: Close CRM Ingestion

Spec: `docs/specs/close-ingestion-v1.md`. Reports:
`docs/reports/close-smartview-discovery.md`, `docs/reports/close-full-data-inventory.md`.

This runbook covers backfill, ongoing ingestion approach, idempotency, the canonical-decisions baked into the schema (triage-count path + tier derivation), and failure-mode debugging. Mirrors the shape of `docs/runbooks/fathom_backlog_ingest.md` + `docs/runbooks/cs_call_summary.md`.

## What this ingestion does

Mirrors Close CRM raw objects into six Supabase tables (see `docs/schema/close_*.md`):

- `close_leads` — denormalized lead mirror
- `close_lead_status_changes` — funnel-spine event stream
- `close_calls` — Call activities
- `close_sms` — SMS activities (the dominant channel)
- `close_opportunities` — workflow markers (NOT money)
- `close_custom_field_definitions` — cf reference table

Idempotent on Close's stable IDs (`lead_*`, `acti_*`, `oppo_*`, `cf_*`). Re-running never duplicates rows.

## Architecture

```
                          ┌───────────────────────┐
                          │  Close REST API       │
                          │  (read-only)          │
                          └───────────┬───────────┘
                                      │
                          ┌───────────▼───────────┐
                          │  ingestion/close/     │
                          │    client.py          │  HTTP Basic auth (key-as-username)
                          │    parser.py          │  JSON → row dicts + cf projection
                          │    pipeline.py        │  Idempotent upserts (supabase-py)
                          └───────────┬───────────┘
                                      │
              ┌───────────────────────┼──────────────────────────┐
              ▼                       ▼                          ▼
   scripts/backfill_close.py    api/close_poll_cron.py    (future: webhook receiver)
   one-shot backfill            scheduled incremental     real-time push
                                (planned — see below)     (deferred — see below)
```

No agent code reads from Close. No code outside `ingestion/close/` and `scripts/backfill_close.py` calls Close's API.

## Backfill

### Modes

```bash
.venv/bin/python scripts/backfill_close.py            # dry-run (default)
.venv/bin/python scripts/backfill_close.py --smoke    # 1 lead end-to-end
.venv/bin/python scripts/backfill_close.py --apply    # bulk (Drake-gated)
.venv/bin/python scripts/backfill_close.py --apply --limit 50
```

### Smoke gate (mandatory before any `--apply`)

Per CLAUDE.md § Operational patterns, a real-API smoke MUST pass before any bulk apply. The smoke pulls one real lead end-to-end (full lead JSON + activities + cf definitions) against the real DB. It's idempotent — safe to re-run after fixes.

If smoke fails, investigate before re-trying. Common failure modes:

- **401/403 on `/me/`** — `CLOSE_API_KEY` not set, or API key rotated. Confirm `.env.local` value (Settings → Developer → API Keys in Close to regenerate).
- **Supabase column mismatch** — migration 0043 not applied, or applied to wrong env. Run dual-verify per `docs/runbooks/apply_migrations.md`.
- **`HTTP 400` from /activity/** — unexpected `_type__in` value. The pipeline requests `Call,SMS,LeadStatusChange`; if Close renames a type, the parser silently skips unknown types but won't 400.

### Bulk `--apply` gate (Drake)

The first bulk `--apply` is the first large-scale production write of this arc. **Drake confirms the smoke result before invoking `--apply` at full scope.** Subsequent re-runs (after a parser fix, etc.) are not gated — the idempotency contract holds.

### Expected scale (today)

From the inventory probe sampling: the org has at least 2000 recent leads. With ~30 activities per lead average (calls + SMS + status changes; SMS is by far the densest), expect roughly:

- ~10,000+ leads total
- ~10,000+ status-change rows
- ~10,000+ call rows
- ~50,000+ SMS rows (SMS is 67% of activity)
- ~30,000+ opportunity rows (multiple per lead)

These are rough order-of-magnitude estimates — the bulk apply's actual counts will be reported and should be eyeball-sanity-checked against the team's expectations.

### Pagination ceilings

Close documents a `_skip` ceiling that varies by resource. The pipeline's `PAGINATION_SAFETY_MAX_PAGES = 200` (page size 100) caps top-level paginators at 20000 rows. If the backfill hits this ceiling, switch to the Close Export API (deferred — see § Out of scope).

## Canonical decisions baked into the schema

### Triage-count path: `close_leads.triage_showed = 'Yes'`

The Engine sheet has "Total Closer Triages" as an APPOINTMENT SETTING metric. Two paths exist in Close:

| Path | Source | Semantic | Sample density |
|------|--------|----------|---------------|
| A | `close_lead_status_changes` where `new_status_id = 'stat_GZca...' (Unconfirmed Booking - Handed over)` | Hand-OVER event (closer takes the lead) | 51 events / 25 sampled leads — dense |
| B | `close_leads.triage_showed = 'Yes'` (cf) | Triage CALL happened (closer marks the cf) | 3 / 25 sampled leads — sparse |

**Canonical = Path B** because Drake's spec definition of triage is "the phone call where a human qualifies the lead." A status flip to Handed-over marks the hand-OVER, not the triage call.

**Gap risk:** Path B undercounts unless closers consistently fill in the `Triage Showed` cf. Daily reconciliation:

```sql
-- Count gap between hand-overs and triages-marked-as-done
SELECT
  count(*) FILTER (WHERE new_status_id = 'stat_GZca7DExvxZ2FkjKNFgWxqrlKwB1ULxA2xKrYszhVf5') AS handovers,
  (SELECT count(*) FROM close_leads
   WHERE triage_showed = 'Yes' AND date_updated >= current_date - interval '7 days') AS triages_marked
FROM close_lead_status_changes
WHERE date_created >= current_date - interval '7 days';
```

If the gap grows materially, surface to the team — the cf is the canonical source and closers must fill it in.

### Tier derivation: ≥ $2k disposable → tier_1

Per Drake's confirmed business logic (2026-05-23): qualified for high-ticket if ≥ $2k disposable income; otherwise unqualified, routes to setter / digital college. The `investment` cf carries Typeform output strings (e.g. `'Under $2,000'`, `'$2,000 - $5,000'`).

Implementation: `ingestion.close.parser.derive_tier()`.

| Investment value (typical) | Tier |
|----------------------------|------|
| `Under $2,000` | `tier_2` |
| `Under $5,000` | `tier_1` (ceiling > $2k qualifies) |
| `$2,000 - $5,000` | `tier_1` (floor ≥ $2k) |
| `$5,000 - $10,000` | `tier_1` |
| `$1,000 - $2,000` | `tier_2` (floor < $2k) |
| empty / unrecognized | `null` (don't guess) |

Refreshed in ingestion on every lead upsert; written to `close_leads.tier`.

If Typeform values diverge from the assumed pattern, update `_CF_NAME_TO_COLUMN` / `derive_tier` in `ingestion/close/parser.py` and re-run the backfill (idempotent — `tier` refreshes on every upsert).

## Ongoing ingestion: polling cron (V1) vs webhooks (deferred)

**V1 ships polling cron, not webhooks.** Two reasons:

1. **Webhook subscription registration is a Close-side configuration step that Drake gates** (env-var / external-config territory; CLAUDE.md § Drake's gates § (d)). Polling has zero Close-side setup beyond the existing API key.
2. **Polling is the safer first-pass.** Webhook deliveries can be missed, duplicated, or arrive out of order — the Fathom flow has been reliable but it took infrastructure work to get there. Polling on `date_updated > {last_high_water}` is correct-by-construction.

### Polling cron design (planned — not in this spec's shipped scope)

When wired up:

- **Endpoint:** `api/close_poll_cron.py` (Vercel serverless function)
- **Schedule:** every 15 minutes (mirrors the Fathom poll cadence)
- **Logic:** call `sync_recently_updated_leads(since_iso=now-20min)` — overlap window tolerates clock skew. The 20-minute overlap at a 15-minute cadence means each lead update gets at least one cron tick.
- **Env vars needed (gate (d) — Drake sets):**
  - `CLOSE_API_KEY` (already in `.env.local`; also needs to be set in Vercel)
  - `CRON_SECRET` (already exists — `Authorization: Bearer $CRON_SECRET`)

This cron is **scoped, not built** in `close-ingestion-v1`. Follow-up spec when V1 backfill is shipped + verified.

### Webhook path (deferred)

Close supports webhook subscriptions for `lead.created`, `lead.updated`, `activity.created`, etc. Trade-offs:

- **Pro:** near-realtime data freshness; no polling cost.
- **Con:** subscription setup requires Close API call(s) from a Drake-supervised session; receiver endpoint needs durability + idempotency vs duplicate deliveries (same shape as the Ella realtime ingestion work).

Not in V1. Revisit after the polling cron has a few weeks of clean operational history.

## Failure modes + debugging

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| `HARD STOP: CLOSE_API_KEY missing` | Env var unset | Set in `.env.local`; in Vercel for production |
| 401/403 on `/me/` | Trailing-colon detail or rotated key | Confirm Basic auth is `<api_key>:` (empty password); regenerate key if rotated |
| 429s | Rate limit | Client backs off + retries 3× automatically; if persistent, reduce concurrency or page size |
| Read timeout on heavy lead's `/activity/` | Some leads have very long timelines | Client has 60s timeout + 3-try retry; persistent timeouts → switch to `_type__in` per-type calls instead of bundled |
| Tier values wrong on real data | Typeform values diverged from assumed pattern | Update `_CF_NAME_TO_COLUMN` + `derive_tier()` in `ingestion/close/parser.py`; re-run backfill (idempotent) |
| `close_leads` row missing custom-field columns | cf id ≠ name map | Re-run `sync_custom_field_definitions()` first to refresh names |

## Re-run safety

All upserts key on `close_id`. Re-running any subset (one lead, all leads, all opportunities) is idempotent: existing rows refresh, no duplicates.

Soft-deletion in Close (which is rare) is NOT mirrored — a lead deleted in Close stays in `close_leads` until manually purged. If this becomes a problem, the polling cron can be extended to track deletions via Event Log.

## Out of scope (future specs)

- **Webhook subscription path** — see § Webhook path above.
- **Close Export API for cold-start backfill** — if pagination ceilings become a problem on very large pulls.
- **EOC Forms ingestion** — separate source, separate spec. The Engine sheet's CLOSING section sources from here, NOT from Close. Until EOC Forms ingestion lands, the closing-funnel money rows have no Supabase source. The Close payment cfs on `close_leads` are mirrored but secondary.
- **Custom-field value history** — Close exposes 30-day rolling history via the Event Log API. Useful for back-population if we need historical reconstruction of cf values that changed before ingestion started.
- **Email activity mirror** — deferred per spec (6% of activity; Drake dropped from First Message Response definition). Add `close_emails` if a future metric needs it.
