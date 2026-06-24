-- 0096_resolve_lead_emails.sql
-- Kill the Calendly email-resolution full scan. The DC + closing loaders
-- (funnel-digital-college.ts, funnel-closing.ts) mapped Calendly-invitee emails
-- to Close lead ids by paging ALL ~13k close_leads and walking the `contacts`
-- JSONB on every Talent/Roster load (~3s each, twice). Replace with a GIN index +
-- a containment lookup: 0.13s for the handful of emails actually needed.
--
-- Stored contact emails are already lowercased, so the lowercased p_emails match
-- via @> containment directly.

create index if not exists ix_close_leads_contacts_gin on close_leads using gin (contacts);

create or replace function resolve_close_lead_emails(p_emails text[])
returns table(email text, close_id text) language sql stable as $$
  select em, cl.close_id
  from unnest(p_emails) em
  join close_leads cl
    on cl.contacts @> jsonb_build_array(jsonb_build_object('emails', jsonb_build_array(jsonb_build_object('email', em))))
$$;

comment on function resolve_close_lead_emails(text[]) is
  'Resolve lowercased invitee emails to Close lead ids via the contacts GIN index. Replaces a full close_leads scan in the Calendly lead-matching loaders.';
