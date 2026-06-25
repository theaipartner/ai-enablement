# Incident — Close ingestion outage (started 2026-06-20)

**Status:** ✅ RESOLVED 2026-06-25. New API key (seat with org access) + paused webhook resumed + windowed backfill; mirror cross-checked exact against Close. See § Resolution.

**Discovered:** 2026-06-24, while scoping the "Jacob / ECJ outbound campaign" task — the CSV's 11k leads were almost entirely absent from `close_leads`, which led to the freshness check below.

## One-line

Our Close integration lost access to the Close organization at ~**2026-06-20 06:10 UTC**. Since then **no Close data has synced** — leads, calls, SMS, opportunities, and status changes are all frozen at that boundary. Every other ingestion source is healthy.

## Evidence

**1. Only Close tables are stale (latest row per source, UTC):**

| Source | Latest row | Healthy? |
|---|---|---|
| `close_leads` (date_updated) | 2026-06-20 05:52 | ❌ frozen |
| `close_calls` | 2026-06-19 22:52 | ❌ frozen |
| `close_sms` | 2026-06-20 06:09 | ❌ frozen |
| `close_opportunities` | 2026-06-19 22:44 | ❌ frozen |
| `typeform_responses` | 2026-06-25* | ✅ current |
| `calendly_*` | 2026-06-24…26* | ✅ current |
| `airtable_setter_triage_calls` / `airtable_full_closer_report` | 2026-06-24…25 | ✅ current |
| `calls` (Fathom) | 2026-06-24 | ✅ current |

*\*Future-dated rows are normal (scheduled events / forward-stamped submissions).*

**2. Webhook delivery stopped cleanly.** Last Close webhook in `webhook_deliveries`: **2026-06-20 06:10:03 UTC**. Zero Close deliveries after June 21. The final 15 all `processed` — no failure cascade; Close simply **stopped sending**. (Every other webhook/cron source is still landing rows minute-to-minute.)

**3. The API key has no org access.** `CLOSE_API_KEY` authenticates — `GET /api/v1/me/` returns a valid user — but reports **zero organizations**, and any org-scoped call returns `403 {"error": "User has no access to this organization."}`. So the key can no longer read leads or run a backfill.

## Root cause (observable)

A **deauthorization event** around 2026-06-20: the Close user/seat backing our API key + webhook subscription lost access to the org. Both surfaces died together (API key → no org; webhook → stopped delivering), which points at the seat/credential, not our code.

**Trigger (identified by Drake 2026-06-24):** the **`success@theaipartner.io` Close seat was removed from the org** (seat reclaimed to cut cost / reassign to other people). The `CLOSE_API_KEY` *and* the webhook subscription were both created under that account. Close keys + webhook subscriptions are **user-scoped**: when the owning user loses org membership, the key keeps authenticating but reports zero organizations, and its webhook subscription is dropped — which is exactly the dual symptom here, and why both died at the same instant. **Not related** to the GitHub/Vercel/Supabase ownership transfer.

**Recurrence guard:** recreate the key + webhook under a **durable seat that won't be reclaimed** (a stable admin/service account), not a personal seat. Credential ownership is tracked in `docs/runbooks/credentials-and-accounts.md`.

## Blast radius (~4 days and counting)

Anything keyed on Close data is undercounting post-June-20:

- **Main funnel cohort / leads roster / speed-to-lead / tagger** — new opt-ins create a `typeform_responses` row (still flowing) but **no `close_leads` row**, so they drop out of the unique-leads cohort.
- **Connected / dials / FMR** — `close_calls` + `close_sms` frozen.
- **Engagement missing-form pinger** — reads `close_calls`; blind to calls after June 20, so it stopped opening/closing engagements.
- **Opportunities + status changes** — frozen.

**Not affected:** Typeform, Calendly, Airtable forms (triage/closer), Fathom calls, Slack, the dashboards' non-Close surfaces.

## Recovery (once Close access is restored)

1. **Restore org access** for the API key — or mint a new key from a seat that has org access — and update `CLOSE_API_KEY` (`.env.local` + Vercel). Verify with `GET /me/` returning a non-empty `organizations`.
2. **Re-register the webhook** — the subscription may have been removed with the seat. `scripts/register_close_webhook.py`; confirm a fresh delivery lands in `webhook_deliveries`.
3. **Backfill the gap** (June 20 → now) — `scripts/backfill_close.py` / `pipeline.sync_all_leads` + activities. Idempotent upserts on Close ids, so safe to over-scan.
4. **Verify** the freshness table above is current again, then resume dependent work.

## Resolution (2026-06-25)

1. **New API key** — Drake added a Close seat with org access and issued a fresh
   `CLOSE_API_KEY` (verified `/me/` returns org "AI Partner"). Set in `.env.local`.
2. **Webhook** — the subscription wasn't deleted, it was **paused** (`whsub_165…`, our
   receiver, all 14 events). Resumed it to `active` via the Close API (`PUT
   /webhook/{id}/ {status:active}`). **No secret rotation / redeploy** — the existing
   `CLOSE_WEBHOOK_SECRET` still matched (it processed fine until the outage). Confirmed
   live: first post-resume delivery `2026-06-25T04:38:33`, `status=processed`.
3. **Backfill** — windowed catch-up `sync_recently_updated_leads(since 2026-06-19)`
   (activity bumps a lead's `date_updated`, so old leads with gap-period calls/SMS are
   included — verified). 8,429 leads / 4,227 calls / 17,736 SMS / 1,565 status changes,
   1 lead failed (self-heals via webhook). ~3.4 h.
4. **Cross-check** — exact: leads-updated-since-06-20 Close 7766 = mirror 7766; 8/8
   sampled leads have identical call+SMS counts Close-vs-mirror; mirror now current
   (latest 2026-06-25).

**Recurrence guard still applies:** the key + webhook now live on a seat that must not
be reclaimed. If that seat is removed again, both die together — same failure.

> Note: a small pre-existing discrepancy remains (mirror ~20.4k vs Close ~21k leads) —
> old leads that predate the original mirror, **not** outage-related; the June-20 gap is
> 100% recovered.

## Relationship to the Jacob / ECJ task

Blocked on this. The ECJ outreach happens in our Close org (per Drake), so the 11k batch should be in Close — but our mirror can't see it (only 42/10,018 CSV emails present) because the sync is down. Once Close access + backfill land, the batch should appear in `close_leads`, and the Jacob campaign (CSV match → label → second Outbound dropdown) can proceed.
</content>
