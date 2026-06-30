# team_members

Agency-side humans — anyone who operates on behalf of the company.

## Purpose

Identify agency staff (CSMs, leadership, engineering, ops) so agents can attribute actions, route escalations, and tell a team @mention apart from a client @mention. The table is deliberately small: the job here is identity + role, nothing else.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `email` | `text` | Not null. Partial-unique where `archived_at is null`. Primary join key for inbound sources (Fathom, Slack Connect emails) |
| `full_name` | `text` | Not null |
| `role` | `text` | Free-form: `csm`, `leadership`, `engineering`, `ops`, `sales`, `system_bot` |
| `access_tier` | `text` | Added in 0032. Not null, default `'csm'`. CHECK pins the four values `csm`/`head_csm`/`admin`/`creator`. Separate concern from `role` (job function) — controls **seniority within** an area. See § Access tiers and § Department areas |
| `areas` | `text[]` | Added in 0112. Not null, default `array['fulfillment']`. Which **departments** a person sees in Gregory — subset of `{fulfillment, sales}`. **Orthogonal to `access_tier`** (tier = seniority within an area). Drives the top-nav + the `(fulfillment)` / `sales-dashboard` layout gates. Flip with a SQL update — no deploy (like `is_active`). See § Department areas |
| `slack_user_id` | `text` | Partial-unique where `archived_at is null`. Slack `U...` id for mentions and matching |
| `is_active` | `boolean` | Default `true`. Cheap filter; `archived_at` is the durable signal |
| `is_csm` | `boolean` | Added in 0022. Not null, default `false`. Marks a team_member as eligible for `primary_csm` assignments. Surfaces in dashboard Primary CSM dropdowns (filter dropdown on `/clients`, swap dialog on `/clients/[id]` — both filter `is_csm = true`). Default `false` so non-CSM team_members (engineering, ops, sales) are excluded; flipping to `true` is an explicit choice. Orthogonal to the free-text `role` column — Scott Wilson and Nabeel Junaid carry `role='leadership'` but `is_csm=true` because they actively own clients. The Scott Chasing sentinel carries `is_csm=true` so it appears in the dropdowns alongside the four real CSMs |
| `metadata` | `jsonb` | Extensible blob for attributes we haven't promoted to columns. Known keys: `seeded_at`/`seed_source` (manual-seed provenance), `sentinel` (true for system identities like Gregory Bot + Scott Chasing — see § Sentinel rows), `personal_emails` (array of non-AIP email addresses a team member uses for internal meetings — treated as internal by the Teams Meeting Tracker's external-attendee filter, see § Personal emails) |
| `close_user_id` | `text` | Added in 0052. Close's `user_XXX...` id. Partial-unique among non-archived rows. The canonical join key from Close mirrors (`close_calls.user_id`, lead owners) to an agency person. See § Sales identity |
| `airtable_user_id` | `text` | Added in 0052. The sales Airtable base's per-team-member record id (a `rec*` into an internal Team Members table, NOT Airtable's built-in `usr*` accounts). Partial-unique. The authoritative join from form `setter_record_ids` / `closer_record_ids` to an agency person. See § Sales identity |
| `ghl_user_id` | `text` | Added in 0115. GHL (GoHighLevel) user id. Maps `ghl_messages.user_id` (the rep on an outbound call) to this team member for the Outbound **by-rep** block (GHL outbound campaigns). Auto-synced from GHL users by email each `ghl_sync_cron` tick. See § Sales identity |
| `sales_role` | `text` | Added in 0052, extended in 0077. `setter` / `closer` / `dc_closer` / `other` or NULL (the majority who aren't sales). CHECK-pinned. Separate concern from `role` (job function) and `access_tier` (permissions). `dc_closer` marks a dedicated Digital College (low-ticket) closer — kept distinct from `closer` so DC closers stay out of the regular setter/closer call-activity tables and drive the People page's own DC section. See § Sales identity |
| `calendly_event_type_uri` | `text` | Added in 0077. A sales rep's Calendly **event-type** URI (the `https://api.calendly.com/event_types/...` value `calendly_scheduled_events.event_type_uri` holds — NOT the human `calendly.com/...` booking link). Used today by the DC view to pull a `dc_closer`'s meetings; nullable for everyone else. See § Sales identity |
| `created_at` | `timestamptz` | Default `now()` |
| `updated_at` | `timestamptz` | Default `now()`, bumped by trigger on update |
| `archived_at` | `timestamptz` | Soft delete; null = current |

## Uniqueness

`email` and `slack_user_id` are unique only among non-archived rows (see migration `0007_partial_unique_archival.sql`). That lets a former team member be re-hired and re-added without hitting a collision on the archived row.

## Relationships

- Referenced by `client_team_assignments.team_member_id`
- Referenced by `call_participants.team_member_id`
- Referenced by `call_action_items.owner_team_member_id`
- Referenced by `escalations.assigned_to` and `escalations.resolved_by`
- Referenced by `agent_feedback.provided_by`
- Referenced by `alerts.team_member_id`

## Populated By

- Manual seed for V1. Live cloud roster as of 2026-05-04: Scott Wilson, Nabeel Junaid (both `role='leadership'`, `is_csm=true`), Lou Perez, Nico Sandoval (both `role='csm'`, `is_csm=true`), Drake (engineering), Aman (sales), Ellis, Huzaifa, Zain (ops). All `is_csm=false` except the four CSMs above and the Scott Chasing sentinel.
- Later: programmatic sync from the CRM or an internal admin UI.

## Access tiers

Added in migration `0032_team_members_access_tier.sql` (2026-05-14). Four hierarchical values pinned by a CHECK constraint:

| Tier | Outranks | Sees today |
|------|----------|------------|
| `creator` | admin, head_csm, csm | Everything. Drake. |
| `admin` | head_csm, csm | Everything Drake sees. Nabeel today; hosts `/cost-hub` and any future Settings / admin surfaces. (The Ella audit dashboard at `/ella/runs` was admin-gated until it was removed 2026-05-24.) |
| `head_csm` | csm | Clients, Calls; plus the `/teams` Meeting Tracker. Scott Wilson today. |
| `csm` | (default) | Clients, Calls. Lou Perez, Nico Sandoval, Zain, plus every default row. |

Resolution + route gating live in `lib/auth/access-tier.ts` (server-only) + `lib/auth/access-tier-shared.ts` (pure type + `tierAtLeast` helper, importable from Client Components). The `(authenticated)` layout calls `getCurrentUserAccessTier()` once per page load; a missing `team_members` row for the authenticated user redirects to `/login?error=no_team_member_row` with an error banner. Admin-only sub-layouts call `tierAtLeast(tier, 'admin')` and redirect to `/clients?error=insufficient_access` on failure (currently `app/(authenticated)/cost-hub/layout.tsx`; the `ella/layout.tsx` that previously protected the audit pages was deleted alongside the routes on 2026-05-24). `components/top-nav.tsx` receives the resolved tier as a prop and filters `NAV_ITEMS` by `requiredTier`.

Auth-side identity is `team_members.email == supabase auth user.email`, looked up via the admin (service-role) client. Email match is case-insensitive (`ilike`).

No UI for managing tiers in V1 — changes happen via SQL or future migration. Settings page is a separate spec.

## Department areas

Added in migration `0112_team_member_areas.sql`. `areas` (`text[]`) is a **department axis orthogonal to `access_tier`**: tier controls *seniority within* a section (admin → cost-hub/CEO/Content, head_csm → /teams), `areas` controls *which departments* a person sees. Values today: `fulfillment`, `sales`.

Why it exists: access used to be tier-only, which conflated the two — the sales dashboard required `admin`, so sales **reps** (csm tier) couldn't see their own dashboard, and admins saw everything. Areas decouple them: a sales rep gets `['sales']` (and the dashboard) without admin; a sales-only rep no longer sees Fulfillment.

Gating:
- **Top-nav** (`components/top-nav.tsx`): Fulfillment requires the `fulfillment` area, Sales the `sales` area; CEO/Content/Tasks stay tier-only.
- **Layouts**: `(fulfillment)/layout.tsx` requires `fulfillment`; `sales-dashboard/layout.tsx` requires `sales`. A user lacking the area is redirected to their own home (`homePathForAreas` in `lib/auth/access-tier-shared.ts`).
- **Admin tools inside Sales** (Verify Reps, Landing Pages) re-check `admin` tier — sales reps (csm + sales area) see the data pages, not the admin tools.

Resolution: `getCurrentUserAccessTier()` (`lib/auth/access-tier.ts`) returns `areas` on `CurrentUserAccess`. Today's "all pages" group (both areas + admin/creator): Drake, Nabeel, Zain, Huzaifa. Sales reps: `['sales']`. CSM staff (Nico, Lou, Scott Wilson, Ellis): `['fulfillment']`. New sales reps added via the Verify Reps flow get `['sales']` automatically. Flip anyone with `update team_members set areas = array['...'] where ...` — no deploy.

## Sales identity

`close_user_id`, `airtable_user_id`, and `sales_role` (migration 0052) plus `calendly_event_type_uri` (migration 0077) let the sales-dashboard resolve a rep across Close, Airtable, and Calendly from this one table instead of hardcoded maps. The pattern, used by `lib/db/funnel-appointment-setting.ts`, `funnel-closing.ts`, and `funnel-digital-college.ts`:

- **Forms → person:** Airtable closer/setter report rows carry `closer_record_ids` / `setter_record_ids` (`rec*`); resolve them to a `close_user_id` via `airtable_user_id`, then group/attribute by `close_user_id` and display `full_name`.
- **Dials → person:** `close_calls.user_id == close_user_id`.
- **GHL dials → person:** `ghl_messages.user_id == ghl_user_id` (GHL outbound campaigns; auto-synced by email via `ghl_sync_cron`, so unlike `airtable_user_id` it needs no manual step).
- **Calendly meetings → person:** `calendly_scheduled_events.event_type_uri == calendly_event_type_uri`.

**Onboarding a new sales rep — the verify page (`/sales-dashboard/reps`, migration 0109).** `airtable_user_id` is the one sales-identity key with no automatic sync (Sierra's was hand-backfilled in 0104). The admin verify page closes that gap: new reps from the Airtable "Sales Team Member" table (mirrored into `sales_rep_candidates`) surface as cards; an admin resolves the rep's `close_user_id` + `email` (a Close-user picker reading `close_users`, or manual entry), picks `sales_role` (setter/closer/dc_closer), optionally adds `calendly_event_type_uri`, and Completes — which writes this row (`role='sales'`, `access_tier='csm'`). The rep then auto-appears on every per-rep surface via the joins below. Forward-only (Airtable records created on/after the cutoff). See `docs/sales/surfaces.md` § Verify Reps and `docs/schema/sales_rep_candidates.md` / `sales_rep_verifications.md` / `close_users.md`. `close_user_id` still also auto-fills by email via `close_users_sync_cron` for rows that lack it.

`sales_role` partitions the per-rep views: `setter` and `closer` feed the regular call-activity tables; `dc_closer` is excluded from those and instead feeds the People page's Digital College section. The DC view (`funnel-digital-college.ts`) selects `WHERE sales_role = 'dc_closer' AND archived_at IS NULL` and renders one row per closer keyed by `close_user_id` — so a closer whose forms store a short name ("Robby") and whose Calendly/dials path uses a fuller name ("Robby Bryant") no longer splits into two rows.

## Personal emails

`metadata.personal_emails` is an array of email addresses a team member uses to attend internal AIP meetings from accounts outside the `@theaipartner.io` Workspace. The Teams Meeting Tracker's external-attendee filter (`api/teams_calendar_sync_cron.py:_has_external_attendee`) treats these as internal — without the list, internal-only meetings leak past the filter when a teammate joined from a personal Gmail or similar.

Today's set (2026-05-15): one entry — `huzaifasaeed460@gmail.com` on Huzaifa's row. Lou Perez's `loumantis@gmail.com` is NOT on the list because that pattern appears on a real client named Lou, not Lou Perez.

To add a new team member's personal email when a leak pattern surfaces:

```sql
UPDATE team_members
SET metadata = jsonb_set(
  COALESCE(metadata, '{}'::jsonb),
  '{personal_emails}',
  COALESCE(metadata->'personal_emails', '[]'::jsonb) || '["<new-personal-email>"]'::jsonb,
  true
)
WHERE full_name = '<team member name>';
```

The cron picks up the change on the next 30-minute tick — no code deploy required.

## Sentinel rows

A small number of `team_members` rows aren't humans — they're system identities used for attribution or assignment-target purposes. Their UUIDs are pinned literals in the migration that creates them so the value is stable across environments. They carry `metadata.sentinel = true` so they can be excluded from any "real team member" listing via `WHERE NOT (metadata ? 'sentinel') OR metadata->>'sentinel' <> 'true'`.

| Sentinel | UUID | Migration | role | is_csm | Purpose |
|---|---|---|---|---|---|
| Gregory Bot | `cfcea32a-062d-4269-ae0f-959adac8f597` | 0021 | `system_bot` | false | `changed_by` attribution for auto-derived `clients.csm_standing` writes from `update_client_from_nps_segment` and the M5.6 status cascade trigger. The presence of Gregory Bot's UUID on the most recent `client_standing_history` row makes the manual-vs-auto distinction queryable. Post-0027 (NPS-is-gospel, 2026-05-08): no longer gates the NPS auto-derive — the function always writes csm_standing from the segment unconditionally. Gregory Bot's role narrowed to attribution-only after the override-sticky logic was retired. |
| Scott Chasing | `ccea0921-7fc1-4375-bcc7-1ab91733be73` | 0022 | `csm` | true | `primary_csm` assignment target for clients in negative status. The M5.6 status cascade reassigns `primary_csm` to this UUID when status moves to ghost/paused/leave/churned. Distinct from Gregory Bot in `role` and `is_csm` because Scott Chasing functions as a CSM placeholder from the dashboard's perspective — clients here are "the system is chasing them," not "this person is actively managing them." `is_csm=true` so it surfaces in the Primary CSM dropdowns alongside the four real CSMs. |

## Read By

- Every agent (to identify who's acting and who to escalate to)
- CSM Co-Pilot (scorecards, ownership)
- Slack bot / Ella (distinguish team @mentions from client @mentions)
- HITL approval UI (list of possible assignees)

## Example Queries

Find the primary CSM assigned to a given client:

```sql
select tm.*
from team_members tm
join client_team_assignments a on a.team_member_id = tm.id
where a.client_id = $1
  and a.role = 'primary_csm'
  and a.unassigned_at is null;
```

Resolve a Slack user id to a team member:

```sql
select * from team_members
where slack_user_id = $1
  and archived_at is null;
```
