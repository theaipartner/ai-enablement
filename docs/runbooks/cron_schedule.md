# Runbook: Cron schedule (UTC → ET reference)

`vercel.json` is **the source of truth** for crons — Vercel deploys its `crons:` array directly. It's
strict JSON and can't carry inline comments, so per ADR 0003 the human-readable UTC→ET reference lives
here. **Keep this table in sync whenever a cron is added, removed, or rescheduled in `vercel.json`**
(mandatory doc-update, same discipline as schema docs). If this table and `vercel.json` ever disagree,
`vercel.json` wins.

Crons are scheduled in **UTC** (Vercel's scheduler is UTC-native). The ET column shows both DST states:
**EDT = UTC−4** (≈ mid-March → early November) and **EST = UTC−5** (rest of year). Interval crons
(`* * * * *`, `*/5`, `*/15`, `*/30`, and the `7,22,37,52` offset) fire on a fixed cadence with no
meaningful ET translation. The fixed-time crons shift by one clock hour across the DST boundary because
the UTC instant is fixed (a deliberate, accepted trade-off — see ADR 0003).

## Current crons (verified against `vercel.json`, 2026-07-10)

| Path | UTC schedule | ET equivalent | What it does |
|---|---|---|---|
| `/api/fathom_backfill` | `0 8 * * *` | daily 04:00 EDT / 03:00 EST | Daily Fathom backlog ingest safety net |
| `/api/gregory_brain_cron` | `0 9 * * *` | daily 05:00 EDT / 04:00 EST | Daily Gregory health recompute (freshness-filtered) |
| `/api/clarity_sync_cron` | `0 10 * * *` | daily 06:00 EDT / 05:00 EST | Microsoft Clarity page-metrics pull |
| `/api/close_users_sync_cron` | `30 11 * * *` | daily 07:30 EDT / 06:30 EST | Close CRM users sync (fills `team_members.close_user_id` + mirrors the `close_users` table) |
| `/api/sales_rep_candidates_sync_cron` | `*/30 * * * *` | every 30 min | Airtable "Sales Team Member" → `sales_rep_candidates` (Verify Reps page) |
| `/api/accountability_notification_cron` | `0 12 * * *` | daily 08:00 EDT / 07:00 EST | CS accountability Slack notification |
| `/api/client_meetings_sync_cron` | `30 4 * * *` | daily 00:30 EDT / 23:30 (prev) EST | Google Calendar → `client_meetings` |
| `/api/ella_daily_digest_cron` | `30 20 * * *` | daily 16:30 EDT / 15:30 EST | Post #daily-digest |
| `/api/faq_digest_cron` | `0 19 * * 5` | Fridays 15:00 EDT / 14:00 EST | Weekly FAQ digest to Scott |
| `/api/meta_sync_cron` | `0 */3 * * *` | every 3h (UTC-anchored: 00,03,…) | Meta ad spend/delivery → the four ad mirrors (replaced `/api/cortana_sync_cron` 2026-06-30; Cortana code kept unscheduled for revert) |
| `/api/meta_leads_sync_cron` | `*/15 * * * *` | every 15 min | Meta instant-form leads → `meta_form_leads` (+ forms + leadgen-campaign scan) + DC-ads facts refresh |
| `/api/wistia_sync_cron` | `30 * * * *` | hourly at :30 past | Wistia stats pull |
| `/api/passive_ella_cron` | `* * * * *` | every minute | Drains the Ella passive-response queue (legacy/no-op) |
| `/api/teams_calendar_sync_cron` | `*/30 * * * *` | every 30 min | Google Calendar → `calendar_events` (/teams) |
| `/api/ella_unanswered_flagger_cron` | `*/15 * * * *` | every 15 min | Flag >2h-unanswered client messages → #unanswered-channels |
| `/api/cs_missed_recording_cron` | `*/15 * * * *` | every 15 min | Post "recording not available" notices |
| `/api/typeform_sync_cron` | `*/15 * * * *` | every 15 min | Typeform responses backstop |
| `/api/airtable_sync_cron` | `*/15 * * * *` | every 15 min | Airtable sales-funnel backstop + webhook refresh |
| `/api/setter_calls_sweep_cron` | `*/15 * * * *` | every 15 min | Setter-call sweep |
| `/api/typeform_insights_cron` | `7,22,37,52 * * * *` | every 15 min (offset +7) | Snapshot Typeform lifetime insight totals |
| `/api/engagement_ping_cron` | `*/5 * * * *` | every 5 min | Engagement / missing-form pinger |
| `/api/outbound_facts_refresh_cron` | `*/15 * * * *` | every 15 min | Rebuild `outbound_lead_facts` (Outbound funnel) + `dc_ads_lead_facts` (DC Ads funnel) — off-page; the pages read the precomputed tables |
| `/api/ghl_sync_cron` | `*/15 * * * *` | every 15 min | GHL contacts/conversations mirror |

## Adding or rescheduling a cron

1. Edit the `crons:` array in `vercel.json` (UTC `cron` expression) — and the matching `functions:` entry.
2. Add/update the row in the table above (compute both EDT and EST: `UTC − 4` and `UTC − 5`).
3. If the exact wall-clock time matters to a human recipient (e.g. the FAQ digest landing in Scott's
   afternoon), note the seasonal DST drift in that cron's own runbook too.

## Why this lives in a doc, not `vercel.json`

`vercel.json` is consumed as strict JSON by Vercel's build; JSONC / trailing comments would break the
deploy. A short synced doc is lighter than a comment-stripping build step. See
`docs/decisions/0003-timezone-conventions.md` § Consequences.
