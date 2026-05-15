-- Permissions infrastructure: four-tier access hierarchy on team_members.
--
-- Adds team_members.access_tier as a separate concern from the existing
-- free-text role column. role is job function (csm / leadership /
-- engineering / ops / sales / system_bot); access_tier is what each user
-- is allowed to see in the dashboard. Hierarchical, ordered:
--   creator > admin > head_csm > csm
--
-- Default 'csm' on every row; backfill below promotes the 6 known users.
-- All other team_members rows (sentinels, future hires, sales / engineering
-- / ops staff) stay at the default. UI-side route gating reads this column
-- via lib/auth/access-tier.ts.
--
-- Spec: docs/specs/permissions-access-tiers.md.

ALTER TABLE team_members
  ADD COLUMN access_tier text NOT NULL DEFAULT 'csm';

ALTER TABLE team_members
  ADD CONSTRAINT team_members_access_tier_check
  CHECK (access_tier IN ('csm', 'head_csm', 'admin', 'creator'));

-- Backfill the 6 known users. Email used where confirmed via SELECT
-- against cloud team_members on 2026-05-14; the other five use
-- full_name because the spec's working-norm leans on the stable
-- full_name set Drake confirmed alongside the email correction.
UPDATE team_members SET access_tier = 'creator'
  WHERE email = 'drake@theaipartner.io';

UPDATE team_members SET access_tier = 'admin'
  WHERE full_name = 'Nabeel Junaid';

UPDATE team_members SET access_tier = 'head_csm'
  WHERE full_name = 'Scott Wilson';

UPDATE team_members SET access_tier = 'csm'
  WHERE full_name IN ('Lou Perez', 'Nico Sandoval', 'Zain');
