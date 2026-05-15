# Teams tracker: exclude Huzaifa's personal Gmail + remove Nabeel from CSM list

**Slug:** teams-personal-email-exclusion-and-nabeel-removal
**Status:** in-flight

## Context

Two surgical changes on top of the Teams Meeting Tracker (`docs/specs/teams-meeting-tracker.md`) + the external-attendee filter (`docs/specs/teams-calendar-external-attendee-filter.md`).

**Problem 1: Huzaifa's personal Gmail leaks internal meetings past the filter.** The current filter keeps events with at least one non-`@theaipartner.io` attendee. Huzaifa attends internal meetings (CSM Sync, Matt Onboarding with Nico, etc.) using `huzaifasaeed460@gmail.com`. The filter treats his personal email as external → internal-only meetings survive. Drake confirmed this is the only personal-email case to address today (Lou's `loumantis@gmail.com` appears to be a client Lou, not Lou Perez).

**Problem 2: Nabeel should be removed from `/teams`.** He no longer takes client calls. Currently appears because `team_members.is_csm = true` for him. Flipping to `false` removes him from `/teams`, the Primary CSM dropdown on `/clients`, and the Primary CSM swap flow. Existing `client_team_assignments` rows pointing to Nabeel stay intact per Drake's direction — those assignments remain visible on the affected client detail pages.

## Files Builder reads first (acclimatization)

1. `api/teams_calendar_sync_cron.py` — specifically `_has_external_attendee()` and `_fetch_csms()`. Both get touched.
2. `docs/schema/team_members.md` — the `metadata` jsonb column already exists and is the right home for the personal-email list. No schema change needed.
3. `docs/specs/teams-calendar-external-attendee-filter.md` — the existing filter spec. New behavior layers on top.

## Decisions baked in (do NOT re-litigate)

- **Personal-email storage:** `team_members.metadata.personal_emails` jsonb array. Matches the `clients.metadata.alternate_emails` pattern. No schema migration needed; metadata is already a freeform jsonb blob.
- **Initial personal-email entry:** Huzaifa only. `huzaifasaeed460@gmail.com`. Other team members' personal emails get added if/when they become a problem.
- **Filter rule update:** an attendee is "external" only if their email is BOTH not in `@theaipartner.io` AND not in any team member's `metadata.personal_emails` list. Personal emails are functionally internal.
- **Personal-email list is fetched fresh each cron tick.** No caching. Single DB query at the start of `run_teams_calendar_sync_cron` builds the set; the helper accepts it as a parameter.
- **Nabeel removal:** SQL `UPDATE` flipping `team_members.is_csm` from `true` to `false` for Nabeel. One-line migration `0035_nabeel_remove_from_csms.sql`.
- **Nabeel's existing `client_team_assignments` rows stay.** Per Drake. Affected clients still show Nabeel as primary CSM on their detail pages until reassigned manually.
- **One-time cleanup of stale `calendar_events` rows.** Same pattern as the last filter spec — events that pass the OLD rule but fail the NEW rule (Huzaifa's internal meetings) get DELETE'd post-deploy. Builder writes the cleanup query, mirrors the last spec's `NOT EXISTS over jsonb_array_elements` shape, runs once.

## Implementation

### 1. Migration: `0035_nabeel_remove_from_csms.sql`

```sql
-- Remove Nabeel from the CSM roster. He no longer takes client calls.
-- His existing client_team_assignments rows stay intact — those clients
-- still show Nabeel as their assigned CSM until manually reassigned via
-- the Primary CSM swap flow on /clients/[id].
UPDATE team_members
SET is_csm = false
WHERE full_name = 'Nabeel Junaid'
  AND is_csm = true;
```

**Dual-verify post-apply:**

```sql
-- Should return 0
SELECT COUNT(*) FROM team_members
WHERE full_name = 'Nabeel Junaid' AND is_csm = true;

-- Confirm the row exists and is now false
SELECT full_name, role, is_csm, access_tier
FROM team_members WHERE full_name = 'Nabeel Junaid';
```

**Hard stop before apply:** Builder reads the migration to Drake in chat for SQL review.

### 2. Add Huzaifa's personal email to `team_members.metadata`

Separate operation, run AFTER migration 0035 lands. Not a migration — pure data update on existing jsonb.

```sql
-- Find Huzaifa's team_members row, then update metadata.personal_emails
UPDATE team_members
SET metadata = jsonb_set(
  COALESCE(metadata, '{}'::jsonb),
  '{personal_emails}',
  '["huzaifasaeed460@gmail.com"]'::jsonb,
  true  -- create_missing
)
WHERE full_name ILIKE 'huzaifa%';
```

**Dual-verify:**

```sql
SELECT full_name, metadata->'personal_emails' AS personal_emails
FROM team_members WHERE full_name ILIKE 'huzaifa%';
```

Should return one row with `personal_emails = ["huzaifasaeed460@gmail.com"]`.

### 3. Code: update `_has_external_attendee` to accept a personal-email set

In `api/teams_calendar_sync_cron.py`:

**Add a helper to fetch personal emails:**

```python
def _fetch_personal_emails(db) -> set[str]:
    """Pull every team_members.metadata.personal_emails entry into a
    single lowercased set. These emails are treated as internal for
    the external-attendee filter — team members joining meetings
    from personal accounts should not count as external attendees.
    """
    resp = (
        db.table("team_members")
        .select("metadata")
        .is_("archived_at", "null")
        .execute()
    )
    out: set[str] = set()
    for row in resp.data or []:
        metadata = row.get("metadata") or {}
        personal = metadata.get("personal_emails") or []
        for email in personal:
            if isinstance(email, str) and email.strip():
                out.add(email.strip().lower())
    return out
```

**Update `_has_external_attendee` signature to accept the set:**

```python
def _has_external_attendee(
    event: dict[str, Any], personal_emails: set[str]
) -> bool:
    """Return True if the event has at least one attendee outside both
    the AIP domain AND every team member's personal-email list.

    Personal emails (e.g., a teammate's @gmail.com used to attend
    internal meetings) are treated as internal here — without this,
    internal-only meetings leak past the filter when teammates use
    personal accounts.
    """
    attendees = event.get("attendees") or []
    if not attendees:
        return False
    for attendee in attendees:
        if attendee.get("resource"):
            continue
        email = (attendee.get("email") or "").strip().lower()
        if not email:
            continue
        if email in personal_emails:
            continue
        if not email.endswith(_AIP_DOMAIN):
            return True
    return False
```

**Thread the set through to `_upsert_events`:**

In `run_teams_calendar_sync_cron`, after fetching CSMs:

```python
personal_emails = _fetch_personal_emails(db)
```

Pass it down through to `_upsert_events` (signature gains `personal_emails: set[str]`).

`_upsert_events`'s filter call becomes:

```python
if not _has_external_attendee(ev, personal_emails):
    continue
```

### 4. One-time cleanup of stale `calendar_events` rows

After deploy, run once against cloud to remove the internal meetings that survived the old filter via Huzaifa's personal email:

```sql
-- Drop calendar_events rows where the only "external" attendee was a
-- team member's personal email (now correctly treated as internal).
DELETE FROM calendar_events
WHERE NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements(attendees) a
  WHERE a->>'email' IS NOT NULL
    AND LOWER(a->>'email') NOT LIKE '%@theaipartner.io'
    AND LOWER(a->>'email') NOT IN (
      SELECT LOWER(jsonb_array_elements_text(metadata->'personal_emails'))
      FROM team_members
      WHERE metadata ? 'personal_emails'
    )
);
```

Builder verifies with a SELECT preview first (`SELECT COUNT(*) WHERE ...` with the same condition), confirms the count looks sensible (~20-30 rows expected — internal meetings Huzaifa attended this week), then runs the DELETE. Verifies post-delete with the same SELECT returning 0.

### 5. Tests

Update `tests/api/test_teams_calendar_sync_cron.py`:

- Add test: event where the only external attendee is a personal email → filter drops it (expected behavior: treated as internal).
- Add test: event with a real external attendee + a personal email → filter keeps it (external attendee still qualifies).
- Add test: empty `personal_emails` set behaves identically to the previous filter (backward compat).
- Update any existing tests that called `_has_external_attendee(event)` to pass `set()` as the second arg.

### 6. Doc updates

- `docs/schema/team_members.md` — add a small paragraph under the `metadata` column noting `personal_emails` as a known key, with the use case (Teams Meeting Tracker filter).
- `docs/runbooks/teams_meeting_tracker.md` — Filter behavior section gains a subsection about personal emails. Include the SQL pattern for adding a new personal email when a new team member's pattern surfaces.
- `docs/state.md` — small entry covering both changes (Huzaifa exclusion + Nabeel removal). Migration count bumps to 35.

## What success looks like

1. **Migration 0035 applies + dual-verifies.** Nabeel's `is_csm = false`.
2. **Huzaifa's `metadata.personal_emails` contains his Gmail.** Confirmed by SELECT.
3. **Next cron tick post-deploy** doesn't write new rows for internal meetings (CSM Sync, etc.). `events_upserted` count goes down accordingly.
4. **One-time cleanup DELETE** drops the ~20-30 stale internal meetings that survived the old filter.
5. **`/teams` page** no longer shows Nabeel as a CSM row. CSM Sync and other Huzaifa-attended internal meetings no longer appear under any CSM.
6. **Tests pass.** `pytest tests/` green.

## Hard stops

- **SQL review before migration apply.** Standard gate (a).
- **DELETE preview before DELETE.** Builder runs the SELECT first to confirm row count is sensible.
- **Don't reassign Nabeel's existing client assignments.** Per Drake; out of scope.
- **Don't add other team members' personal emails yet.** Huzaifa only. Lou's `loumantis@gmail.com` was confirmed by Drake to be a client Lou, not Lou Perez — leave the filter as-is for that email.
- **Don't change the filter rule beyond personal-email exclusion.** No new categories of filtering in this spec.

## What could go wrong

- **A real client uses `huzaifasaeed460@gmail.com` as their primary email.** Effectively impossible — it's clearly Huzaifa's personal address. But if it ever happens, surfaces as "this client's meeting isn't showing up" and we adjust then.
- **The `_fetch_personal_emails` query returns more than expected** if other team_members rows have `personal_emails` entries we don't know about. Builder verifies the result set is just `{huzaifasaeed460@gmail.com}` post-deploy via a logged set print or a one-off SELECT.
- **Nabeel still appears in cached views** until the next page render. Vercel doesn't cache at the data layer for `/teams` (server-rendered each visit), so the change is immediate.

## Mandatory doc-update list

- `supabase/migrations/0035_nabeel_remove_from_csms.sql` — new.
- `api/teams_calendar_sync_cron.py` — `_fetch_personal_emails` + updated `_has_external_attendee` + threaded through `_upsert_events`.
- `tests/api/test_teams_calendar_sync_cron.py` — three new tests + update existing tests to pass `set()` as second arg.
- `docs/schema/team_members.md` — `personal_emails` key documented.
- `docs/runbooks/teams_meeting_tracker.md` — filter behavior + personal-email-add SQL pattern.
- `docs/state.md` — new entry.

## Commit shape

One migration commit ("feat: remove Nabeel from CSM roster"). One feature commit ("feat: exclude team_members.metadata.personal_emails from external-attendee filter"). One docs commit. One report commit. Push at end.
