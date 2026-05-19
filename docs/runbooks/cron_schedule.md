# Runbook: Cron schedule (UTC → ET reference)

`vercel.json` is strict JSON — Vercel deploys it directly, so it can't
carry inline comments. Per ADR 0003, every cron's UTC schedule and its
ET equivalent live here instead. **Keep this table in sync whenever a
cron is added, removed, or rescheduled in `vercel.json`** (mandatory
doc-update, same discipline as schema docs).

Crons are scheduled in **UTC** (Vercel's scheduler is UTC-native). ET
column shows both DST states: **EDT = UTC−4** (≈ mid-March → early
November) and **EST = UTC−5** (rest of year).

## Current crons (as of 2026-05-19)

| Path | UTC schedule | ET equivalent | What it does |
|---|---|---|---|
| `/api/fathom_backfill` | `0 8 * * *` | daily 04:00 EDT / 03:00 EST | Daily Fathom backlog ingest sweep |
| `/api/gregory_brain_cron` | `0 9 * * *` | daily 05:00 EDT / 04:00 EST | Daily Gregory brain recompute (freshness-filtered) |
| `/api/accountability_notification_cron` | `0 12 * * *` | daily 08:00 EDT / 07:00 EST | Daily CS accountability Slack notification |
| `/api/passive_ella_cron` | `* * * * *` | every minute (TZ-independent) | Drains the Ella passive-response queue |
| `/api/teams_calendar_sync_cron` | `*/30 * * * *` | every 30 min (TZ-independent) | Google Calendar → `calendar_events` sync |
| `/api/faq_digest_cron` | `0 19 * * 5` | Fridays 15:00 EDT / 14:00 EST | Weekly FAQ digest DM to Scott |
| `/api/ella_daily_digest_cron` | `30 20 * * *` | daily 16:30 EDT / 15:30 EST | Daily Ella-flags digest DM to Scott + Drake |
| `/api/ella_unanswered_flagger_cron` | `*/15 * * * *` | every 15 min (TZ-independent) | Posts flagged messages unanswered >2h to #unanswered-channels |

The three interval crons (`* * * * *`, `*/30 * * * *`, `*/15 * * * *`)
have no meaningful ET translation — they fire on a fixed cadence
regardless of wall-clock date. The four fixed-time crons shift by one
clock hour across the DST boundary because the UTC instant is fixed (a
deliberate, accepted trade-off — see ADR 0003 and the FAQ-digest
runbook's DST note).

## Adding or rescheduling a cron

1. Edit the `crons:` array in `vercel.json` (UTC `cron` expression).
2. Add/update the row in the table above (compute both EDT and EST ET
   equivalents — `UTC − 4` and `UTC − 5`).
3. If the cron's exact wall-clock time matters to a human recipient
   (e.g. the FAQ digest lands in Scott's afternoon), note the
   seasonal drift in that cron's own runbook too.

## Why this lives in a doc, not `vercel.json`

`vercel.json` is consumed as strict JSON by Vercel's build; JSONC /
trailing comments would break the deploy. Introducing a
comment-stripping build step purely for schedule readability isn't
worth the moving part (ADR 0003 § Consequences). A short synced doc is
the lighter option. See `docs/decisions/0003-timezone-conventions.md`.
