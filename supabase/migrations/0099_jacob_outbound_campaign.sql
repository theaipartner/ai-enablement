-- 0099_jacob_outbound_campaign.sql
-- The "Jacob" (ECJ Reactivation) outbound campaign: a second pool on the Outbound
-- page alongside Revival. Membership is the Close custom field "Jacob Lead"
-- (cf_m0ooi…), set on close_leads matching the ECJ CSV roster — so the existing
-- outbound_funnel(p_campaign_key) RPC (which keys off custom_fields_raw -> close_cf_id)
-- works with zero RPC changes, exactly like revival.
--
-- The roster table holds the CSV (email/phone) so the tagger can match BOTH the
-- existing batch AND future leads (a webhook hook re-checks new leads against it).

create table if not exists outbound_campaign_roster (
  id            bigserial primary key,
  campaign_key  text not null,
  email         text,            -- lowercased
  phone         text,            -- normalized: digits only, 11-char US (1XXXXXXXXXX)
  first_name    text,
  last_name     text,
  created_at    timestamptz not null default now()
);
create index if not exists ix_ocr_email on outbound_campaign_roster (campaign_key, email);
create index if not exists ix_ocr_phone on outbound_campaign_roster (campaign_key, phone);

-- Registry row. floor = the batch's load start (leads created 2026-06-20..25);
-- per-lead anchor = greatest(date_created, floor_at). Midnight ET = 04:00 UTC.
insert into outbound_campaigns (key, label, close_cf_id, floor_at, sort_order)
values ('jacob', 'Jacob', 'cf_m0ooiwIyM3qqKXpPPuWolmLWJxoS5EbHfsOW5Om46G1',
        timestamptz '2026-06-20T04:00:00Z', 1)
on conflict (key) do nothing;
