-- Remove Nabeel from the CSM roster. He no longer takes client calls,
-- so /teams (head_csm-and-up Meeting Tracker), the Primary CSM
-- dropdown on /clients, and the Primary CSM swap flow on
-- /clients/[id] should all stop surfacing him as a CSM option.
--
-- Surgical UPDATE on team_members.is_csm — `role`, `access_tier`, and
-- archival state stay untouched (he's still a leadership team member
-- with admin tier; just not a CSM).
--
-- Nabeel's 3 existing active `client_team_assignments` rows STAY
-- intact per Drake's direction. Affected clients continue to render
-- Nabeel as their assigned CSM on /clients/[id] until manually
-- reassigned via the swap flow. Reassignment is out of scope here.
--
-- Spec: docs/specs/teams-personal-email-exclusion-and-nabeel-removal.md.

UPDATE team_members
SET is_csm = false
WHERE full_name = 'Nabeel Junaid'
  AND is_csm = true;
