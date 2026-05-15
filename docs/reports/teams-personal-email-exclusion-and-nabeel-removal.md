# Report: Teams tracker — exclude Huzaifa's personal Gmail + remove Nabeel from CSM list

**Slug:** teams-personal-email-exclusion-and-nabeel-removal
**Spec:** docs/specs/teams-personal-email-exclusion-and-nabeel-removal.md

## Files touched

**Created**
- `supabase/migrations/0035_nabeel_remove_from_csms.sql` — one-row data UPDATE flipping `team_members.is_csm` from true to false for Nabeel Junaid.

**Modified**
- `api/teams_calendar_sync_cron.py` — new module-level `_fetch_personal_emails(db) -> set[str]` helper that pulls every `team_members.metadata.personal_emails` entry into a lowercased, trimmed set. `_has_external_attendee` gains a `personal_emails: set[str]` parameter and treats any attendee whose email is on that set as internal. `run_teams_calendar_sync_cron` loads the set after `_fetch_csms` and threads it down through `_upsert_events` (signature gains `personal_emails`).
- `tests/api/test_teams_calendar_sync_cron.py` — 3 new tests covering the personal-email exclusion behavior: personal email treated as internal (drops the row); real external attendee still kept when a personal email is also on the invite; empty `personal_emails` set behaves identically to the prior filter (backward compat).
- `docs/schema/team_members.md` — `metadata` column row gains a mention of the `personal_emails` known key; new "Personal emails" section above § Sentinel rows describes the live entry + the SQL recipe for adding more.
- `docs/runbooks/teams_meeting_tracker.md` — Filter behavior section gains a "Personal-email exclusion (2026-05-15)" subsection with the live entry, the no-deploy-needed iteration path, and a pointer to this report for the cleanup-DELETE pattern.
- `docs/state.md` — new top-line entry under "Gregory editorial skin shipped" describing both pieces; migration-count line bumped 34 → 35; latest-migration paragraph updated.

**Side-effect changes to production data**
- Migration 0035 applied via `supabase db push` — Nabeel's `is_csm` flipped from true to false (one row).
- One-shot psycopg2 `UPDATE` on `team_members` (NOT a migration — pure data on the existing jsonb) added `metadata.personal_emails = ["huzaifasaeed460@gmail.com"]` to Huzaifa's row alongside the existing seed metadata.
- One-time cleanup `DELETE` against cloud `calendar_events` removed 20 stale rows (142 → 122) — all "CSM Sync" internal meetings that survived the old filter because Huzaifa was on the invite via his personal Gmail.

## What I did, in plain English

Two surgical changes on top of the same-day external-attendee filter spec. The first is a one-line `is_csm` flip for Nabeel — he no longer takes client calls, so the `/teams` page (head-CSM-and-up Meeting Tracker), the Primary CSM dropdown on `/clients`, and the Primary CSM swap flow on `/clients/[id]` should all stop offering him as a CSM. Migration `0035` packaged the UPDATE; Nabeel's existing 3 active `client_team_assignments` rows stay intact per your direction so affected clients still surface him as their assigned CSM until manually reassigned. His `role='leadership'` + `access_tier='admin'` stay unchanged — only the CSM flag flipped.

The second change is a leak fix on the calendar filter. The previous filter treated any attendee whose email didn't end in `@theaipartner.io` as "external." Huzaifa's personal Gmail (`huzaifasaeed460@gmail.com`) is technically not AIP-domain, so any internal AIP meeting Huzaifa joined from that account looked like it had an external attendee → survived the filter. Concretely: every CSM Sync (Mon–Fri at 15:00 UTC) was showing up on `/teams` for every CSM. Twenty rows in production. Fix is a personal-email exclusion list on `team_members.metadata.personal_emails` — a jsonb array of "this address is mine even though it's not on the AIP domain." The cron loads every team member's personal_emails into a single lowercased set per tick (`_fetch_personal_emails`) and `_has_external_attendee` checks the set alongside the AIP-domain check. Today's live entry is Huzaifa's gmail.

One-time cleanup DELETE swept up the 20 stale CSM Sync rows that were already in `calendar_events` from prior cron ticks. Future ticks will never insert rows for those internal meetings — the filter catches them upstream.

## Verification

- **Pre-apply SELECT** confirmed Nabeel exists (`role='leadership'`, `is_csm=true`, `access_tier='admin'`) and Huzaifa exists (`role='ops'`, `is_csm=false`, current `metadata={seeded_at, seed_source}`). Nabeel had 3 active `client_team_assignments` — stays at 3 per spec.
- **Migration apply** via `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes`. "Connecting to remote database..." → "Applying migration 0035_nabeel_remove_from_csms.sql..." → "Finished supabase db push." Exit 0.
- **Dual-verify post-migration**: 0 rows with `full_name='Nabeel Junaid'` AND `is_csm=true`; the row updated to `is_csm=false` while keeping `role='leadership'` + `access_tier='admin'` intact; ledger has the `0035` entry.
- **Huzaifa metadata UPDATE** via psycopg2: 1 row affected; post-state shows `personal_emails: ["huzaifasaeed460@gmail.com"]` alongside the existing `seeded_at`+`seed_source` keys (jsonb_set merged cleanly).
- **CSM roster after migration**: Lou Perez, Nico Sandoval, Scott Wilson (3 humans, Nabeel correctly removed; sentinels filtered out via the metadata check).
- **Cleanup DELETE preview** showed 20 rows would drop — all "CSM Sync" internal meetings across all four CSMs over the past few days. Spec's "~20-30 expected" range bracketed the actual count.
- **Cleanup DELETE applied**: 142 → 122, `cur.rowcount` returned exactly 20 (matches preview). Zero rows still fail the new filter post-DELETE.
- **Pytest**: 557 passing, 0 failures (was 554 pre-spec; +3 new personal-email tests). All 15 cron tests pass with the new `personal_emails` parameter threaded through.
- **`npx tsc --noEmit`** → clean.
- **`npm run lint`** → "No ESLint warnings or errors."

## Surprises and judgment calls

- **Huzaifa's metadata UPDATE is NOT a migration**, per spec. It's a one-shot DML on an existing jsonb column. I ran it via the same psycopg2 pattern the migration runbook uses for dual-verify — `UPDATE … RETURNING *` style with explicit row-count check. The discipline is the same (preview-via-SELECT, run, verify-via-SELECT); the mechanism just isn't `supabase db push`. Worth flagging because a future Director might look for a `0036_huzaifa_personal_emails.sql` file and not find one.
- **Migration 0035 is pure DML, no schema change.** Sets a precedent (0028 + 0031 + 0032 already mixed DDL + DML in single migration files; 0035 is the first pure-DML migration). Acceptable because the change is small + needs the migration system's tracking. If a future "remove team member from CSMs" pattern recurs, it can ride a manual UPDATE via psycopg2 instead — cheap-deploy + no migration noise.
- **Nabeel still has 6 calendar_events rows post-cleanup.** Those are valid client-attendee meetings he hosted before being de-CSM'd today. The new filter keeps them (they pass the external-attendee check). They'll roll off naturally as the week ends and the cron stops syncing his calendar (since `_fetch_csms` filters `is_csm=true`). The `/teams` page won't render them because the page only iterates over CSMs. Leaving them alone for now; they're invisible and would re-appear if Drake ever re-flipped Nabeel's `is_csm` back to true.
- **`_fetch_personal_emails` reads `team_members` without an `is_csm` filter.** Personal emails could in principle belong to non-CSM team members (Drake, Aman, etc.). Reading all non-archived rows is correct: the filter cares about "is this email's owner internal to AIP" not "is this email's owner a CSM." Today the set has one entry; that scales fine.
- **Spec's example UPDATE uses `personal_emails` array overwrite**, my implementation matched it. If a team member already has a personal_emails array with other entries, an overwrite would wipe them. Today no team_members rows had a pre-existing array; the overwrite is safe. Future additions for the same team member should use the array-append pattern documented in the schema doc (`COALESCE(metadata->'personal_emails', '[]'::jsonb) || '[…]'::jsonb`).
- **Backward-compat test was load-bearing.** The signature change on `_has_external_attendee` (added `personal_emails: set[str]`) ripples to every test that didn't already pass a set. I confirmed the existing 12 tests still pass because the fake DB's team_members fixture has empty metadata → `_fetch_personal_emails` returns `set()` → behavior matches pre-change. The explicit backward-compat test pins this so a future contributor adding personal_emails to fixtures by accident gets caught.
- **DELETE preview matched the actual rowcount exactly** (20 expected, 20 deleted). Same discipline as yesterday's filter spec — preview-then-execute, cross-check rowcount. Forward-only; no rollback path.

## Out of scope / deferred

- **Reassigning Nabeel's 3 active `client_team_assignments`.** Spec explicit: they stay until manually reassigned via the Primary CSM swap flow on `/clients/[id]`. Future work if/when those clients need a different assignment.
- **Adding other team members' personal emails.** Spec explicit: Huzaifa only today. Lou Perez's `loumantis@gmail.com` was confirmed (by Drake) to be a client Lou, not Lou Perez — leave that pattern alone.
- **Cron behavior change for non-CSM team members.** The cron syncs `is_csm=true` calendars only. Now that Nabeel's `is_csm=false`, the cron won't sync his calendar anymore — his existing rows in `calendar_events` won't get refreshed. They'll naturally age out as time passes (the cron's week-window query filters to current Mon-Sun, so old rows fall off the page render even if they linger in the table).
- **No multi-tenant abstraction.** `_AIP_DOMAIN` still hardcoded to `"@theaipartner.io"`. Same as the prior spec — future spec when the team rebrands or the codebase goes multi-tenant.

## Side effects

- **Three commits pushed to `main` this turn** (about to push the report next): `6de37a4` (migration 0035), `7c59e82` (filter code + tests), `ae33534` (docs).
- **Cloud database mutated**:
  - Migration 0035 applied: 1 `team_members` row (`Nabeel Junaid`) had `is_csm` flipped true → false.
  - Huzaifa's `team_members.metadata` gained the `personal_emails` jsonb key with `["huzaifasaeed460@gmail.com"]`.
  - `calendar_events` lost 20 rows (142 → 122) via the cleanup DELETE — all internal "CSM Sync" meetings that survived the old filter.
- **No real Slack posts, DMs, or external API calls.** Pure DB + cron infrastructure.
- **No deploys yet from this turn.** Push will fire Vercel's auto-deploy. Next 30-min cron tick will load Huzaifa's personal email + apply the extended filter — internal-only meetings that previously survived won't re-insert.
- **`/teams` page becomes lighter immediately**: 20 fewer rows surface; Nabeel disappears as a CSM column.
