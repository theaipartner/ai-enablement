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
| `slack_user_id` | `text` | Partial-unique where `archived_at is null`. Slack `U...` id for mentions and matching |
| `is_active` | `boolean` | Default `true`. Cheap filter; `archived_at` is the durable signal |
| `is_csm` | `boolean` | Added in 0022. Not null, default `false`. Marks a team_member as eligible for `primary_csm` assignments. Surfaces in dashboard Primary CSM dropdowns (filter dropdown on `/clients`, swap dialog on `/clients/[id]` — both filter `is_csm = true`). Default `false` so non-CSM team_members (engineering, ops, sales) are excluded; flipping to `true` is an explicit choice. Orthogonal to the free-text `role` column — Scott Wilson and Nabeel Junaid carry `role='leadership'` but `is_csm=true` because they actively own clients. The Scott Chasing sentinel carries `is_csm=true` so it appears in the dropdowns alongside the four real CSMs |
| `metadata` | `jsonb` | Extensible blob for attributes we haven't promoted to columns |
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
