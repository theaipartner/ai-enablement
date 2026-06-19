# Runbook: client_meetings_sync_cron

Daily Google Calendar → `client_meetings` sync. Maintains the durable
per-client meeting record behind the client page's "meetings this month" +
month history (CSM pay inputs).

## What it does

1. Auth: `Authorization: Bearer ${CRON_SECRET}`.
2. Resolves Drake (creator-tier) and mints a Google access token via
   `shared.google_oauth` — CSMs share calendars with Drake at the Workspace
   level, so his token reads them all.
3. Builds an `email → client_id` map from non-archived clients (`email` +
   `metadata.alternate_emails`, lowercased/trimmed).
4. For each CSM, fetches calendar events over a rolling **14-day** lookback
   (`now-14d .. now`, past meetings only). For each event with an external
   attendee, upserts one `client_meetings` row per matched known client
   (keyed `(client_id, google_event_id)`).
5. **Reconciliation:** deletes `client_meetings` rows whose `start_time` is in
   the 14-day window but which were not seen this run (event deleted/moved in
   Google). Rows older than 14 days are frozen. Reconciliation is **skipped**
   on any run where one or more CSM fetches errored (a partial fetch must not
   trigger false deletions); the next clean run catches up.
6. Writes a summary audit row to `webhook_deliveries` (`source =
   'client_meetings_sync'`).

## Excluded events

Beyond cancelled / dateless / internal-only events, the cron drops a small
ignore list of booking links that must never count as client meetings —
dropped at the same point as cancelled events, before attribution. Helper:
`_is_ignored_event` (constants `_IGNORED_EVENT_TITLES` / `_IGNORED_EVENT_URLS`).

- **Digital College Implementation Call with Nico** (Scott, 2026-06-19). A
  separate program booked on Nico's calendar via an external booking link
  (`api.leadconnectorhq.com`). Matched by exact title (case-insensitive,
  trimmed) **and** by the booking-link URL anywhere in the event payload.
  Today's calendar events carry the title but not the URL — the URL guard is
  forward-insurance. The genuine "Coaching Call with Nico" is untouched (its
  title isn't on the list and its booking link is a different URL).

To add another exclusion, extend the two constants in
`api/client_meetings_sync_cron.py` (and mirror in `teams_calendar_sync_cron.py`).

## Schedule

`30 4 * * *` UTC in `vercel.json` (≈11:30pm EST / 12:30am EDT). `maxDuration`
300s.

## Manual trigger

```bash
curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://ai-enablement-sigma.vercel.app/api/client_meetings_sync_cron
```

Returns `{csms_attempted, csms_succeeded, meetings_upserted, meetings_deleted,
clients_matched, errors}`.

## Failure modes

| Symptom | Likely cause | Where to look |
|---------|--------------|---------------|
| `oauth_token_unavailable` | Drake's Google token expired / revoked | Reconnect at `/teams` (creator). Audit row `processing_error`. |
| One CSM `calendar_api_denied` | CSM unshared their calendar, or scope issue | `payload.errors[]` in the audit row. Reconciliation is skipped that run. |
| `meetings_matched` lower than expected | Client attends under an email not on the client row | Add it to `metadata.alternate_emails` on the client. |
| Counts double for a client | Same person on two client rows | Merge the duplicate clients. |

## Notes

- The cron is self-contained (duplicates a few helpers from
  `teams_calendar_sync_cron.py`) on purpose: the `/teams` Meeting Tracker and
  its 30-minute cron are slated for removal, and this job must survive that.
- Read layer + EST month bucketing: `lib/db/client-meetings.ts`. Schema:
  `docs/schema/client_meetings.md`.
