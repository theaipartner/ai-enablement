# Filter `/teams` calendar sync to external-attendee meetings only

**Slug:** teams-calendar-external-attendee-filter
**Status:** in-flight

## Context

The Teams Meeting Tracker (`docs/specs/teams-meeting-tracker.md`, shipped 2026-05-14) currently syncs every event from each CSM's calendar to `calendar_events`. That includes OOO blocks, work blocks, focus time, lunch, internal team meetings, and one-off personal items — all of which Nabeel and Scott don't want to see. The page only matters as a CSM-meets-with-clients tracker; everything else is noise.

Drake's decision (locked in via chat, 2026-05-15): filter to events where at least one attendee has a non-`@theaipartner.io` email. Internal-only meetings get dropped. OOO and work blocks (zero external attendees) also get dropped automatically by the same filter.

Filter at fetch time, not display time. No benefit to storing rows we never render; smaller table is cleaner.

## Files Builder reads first (acclimatization)

1. `api/teams_calendar_sync_cron.py` — the cron file. The filter goes here, between the API fetch and the upsert.
2. `docs/schema/calendar_events.md` — schema doc. Update the "Populated By" section to describe the new filter.
3. `docs/runbooks/teams_meeting_tracker.md` — runbook. Add a troubleshooting note about expected vs unexpected filter behavior.

## Decisions baked in (do NOT re-litigate)

- **Filter rule:** keep events where `event.attendees` contains at least one entry whose email does NOT end in `@theaipartner.io` (case-insensitive). Drop events that fail this check.
- **Edge cases that get dropped:**
  - Events with zero attendees (solo OOO blocks, work blocks)
  - Events where the CSM is the only attendee
  - Events where every attendee is `@theaipartner.io` (pure internal meetings)
- **Edge cases that get kept:**
  - Client meetings (client has an external email)
  - Meetings with vendors, prospects, accountants, anyone non-AIP-domain
  - Meetings where attendees include both AIP team members AND external people (still has external = keep)
- **Filter at fetch time, not display time.** The cron applies the filter before upserting; events that fail the check never land in `calendar_events`.
- **Existing rows stay.** No backfill or cleanup of the events already in `calendar_events`. They'll naturally roll off as the table only stores current-week data per cron tick (new sync = new rows for the new week; old rows from prior weeks become irrelevant to the page query but aren't pruned).
- **Domain hardcoded in the cron**, not env-var-driven. Single-tenant deployment; the domain isn't going to change. If The AI Partner ever rebrands or this code goes multi-tenant, that's a future spec.

## Implementation

### 1. Cron filter

In `api/teams_calendar_sync_cron.py`, find where events are iterated for upsert (Builder reads the file to confirm location). Add a filter function and apply it before the upsert loop.

```python
_AIP_DOMAIN = "@theaipartner.io"


def _has_external_attendee(event: dict) -> bool:
    """Return True if the event has at least one attendee outside the
    AIP Workspace domain. Used to filter out OOO blocks, work blocks,
    and internal-only meetings — none of which belong on /teams.
    """
    attendees = event.get("attendees") or []
    if not attendees:
        return False
    for attendee in attendees:
        email = (attendee.get("email") or "").strip().lower()
        if not email:
            continue
        if not email.endswith(_AIP_DOMAIN):
            return True
    return False
```

Apply in the per-CSM loop right before the upsert:

```python
for event in events:
    if not _has_external_attendee(event):
        continue
    # existing upsert logic
```

### 2. Tests

Update `tests/api/test_teams_calendar_sync_cron.py`:

- Add a test asserting events with zero attendees are dropped (OOO/work block case)
- Add a test asserting events with only `@theaipartner.io` attendees are dropped (internal meeting case)
- Add a test asserting events with at least one external attendee are kept (client meeting case)
- Add a test asserting case-insensitivity (`@THEAIPARTNER.IO` is still treated as internal)
- Update any existing happy-path test that used mock events with no attendees — those mocks need at least one external attendee now to pass the filter

### 3. Doc updates

- `docs/schema/calendar_events.md` — "Populated By" section: add a sentence noting events are filtered at sync time to those with at least one external attendee.
- `docs/runbooks/teams_meeting_tracker.md` — add a "Filter behavior" section explaining what gets included vs dropped. Helps Drake/Scott/Nabeel debug "why isn't this meeting showing up."
- `docs/state.md` — small entry noting the filter shipped. Migration count unchanged.

## What success looks like

1. **Cron runs after deploy** — events from each CSM's calendar are filtered; only external-attendee events upsert to `calendar_events`.
2. **OOO blocks, work blocks, internal 1:1s no longer appear** on `/teams`.
3. **Existing client meetings still appear** with their Fathom checkmarks.
4. **Tests pass.** `pytest tests/` green.

## Hard stops

- **Don't add a UI toggle for the filter.** It's not configurable; this is the rule.
- **Don't backfill / clean up existing `calendar_events` rows.** Forward-only. New cron ticks overwrite the data within minutes.
- **Don't change the filter location to display time.** Filter at fetch time per the decision.

## What could go wrong

- **A client uses an `@theaipartner.io` email** (e.g., they're being trialed as a future team member, or sharing a workspace alias). Mitigation: vanishingly rare; if it happens, surfaces as "this client meeting isn't showing up" and we adjust then. Not a V1 concern.
- **A meeting has the external attendee email typo'd or with surrounding whitespace.** The filter lowercases + trims. Should be robust to common variants.
- **An attendee email is `null` or missing.** The current code defends against this via `event.get("attendees") or []` plus the per-attendee `email or ""` check. No new code path needed.
- **Mock events in existing tests had no attendees.** Builder updates those mocks to add at least one external attendee where the test should pass the filter. Spec section 2 calls this out.

## Mandatory doc-update list

- `api/teams_calendar_sync_cron.py` — filter helper + filter applied in cron loop.
- `tests/api/test_teams_calendar_sync_cron.py` — new tests + updated mocks.
- `docs/schema/calendar_events.md` — populated-by note updated.
- `docs/runbooks/teams_meeting_tracker.md` — filter behavior section added.
- `docs/state.md` — small new entry.

## Commit shape

One feature commit ("feat: filter /teams calendar sync to external-attendee meetings only"), one docs commit, one report commit. Push at end.
