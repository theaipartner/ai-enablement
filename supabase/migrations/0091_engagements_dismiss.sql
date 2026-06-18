-- 0091_engagements_dismiss.sql
-- Let a rep dismiss a missing-form ping when the form is genuinely not needed
-- (e.g. a lead called for tech support, not a sales call). The rep @-mentions
-- Ella in the ping's Slack thread; that thread reply resolves to the engagement
-- and stamps dismissed_at, which stops pinging.
--
-- A new sticky tag, distinct from final_at so analytics never count a "not
-- needed" dismissal as a filed form:
--   final_at set     -> FINAL    (a form linked)
--   dismissed_at set -> DISMISSED (rep marked it not-needed; pinging stopped)
-- Both stop the pinger; the two are mutually informative, not the same thing.
--
-- ping_ts accumulates the Slack ts of every ping message posted for the
-- engagement, so an inbound thread reply (thread_ts) maps back to the exact
-- engagement it belongs to. See docs/schema/engagements.md.

alter table public.engagements
  add column if not exists dismissed_at  timestamptz, -- DISMISSED tag (set once)
  add column if not exists dismissed_by  text,        -- Slack user id of the rep who dismissed
  add column if not exists dismiss_reason text,        -- the rep's reply text (may be blank)
  add column if not exists ping_ts       text[] not null default '{}'; -- Slack ts of each ping, for thread matching

-- Reverse lookup: thread reply (thread_ts) -> the engagement whose ping it answers.
create index if not exists engagements_ping_ts_gin on public.engagements using gin (ping_ts);
