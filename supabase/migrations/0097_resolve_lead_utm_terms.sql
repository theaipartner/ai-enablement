-- 0097_resolve_lead_utm_terms.sql
-- The utm_term half of the Calendly lead-resolution full scan (the sibling of
-- 0096's email half). `buildCalendlyLeadResolver` paged all ~9.3k close_leads
-- with a utm_term to build the whole term→lead map (with ambiguity dropping) on
-- every Talent/Roster load. Replace with an index + a function that resolves only
-- the needed terms server-side.
--
-- A utm_term is only usable when EXACTLY ONE lead carries it (most leads share a
-- generic ad term — "Broad", dated labels — which must resolve to null). The
-- `group by … having count(distinct close_id) = 1` enforces that server-side, so
-- a generic term shared by thousands can't starve the others via the 1000-row cap
-- (the bug a client-side `.in()` would have).

create index if not exists ix_close_leads_utm_term on close_leads (utm_term);

create or replace function resolve_close_lead_utm_terms(p_terms text[])
returns table(utm_term text, close_id text) language sql stable as $$
  select cl.utm_term, min(cl.close_id)
  from close_leads cl
  where cl.utm_term = any(p_terms)
  group by cl.utm_term
  having count(distinct cl.close_id) = 1
$$;

comment on function resolve_close_lead_utm_terms(text[]) is
  'Resolve Calendly utm_term tokens to a Close lead id, only when exactly one lead carries the term (generic shared terms → omitted). Replaces a full close_leads scan.';
