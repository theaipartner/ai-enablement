"""Meta ad data ingestion — direct from the Meta Marketing (Graph) API.

Replaces `ingestion/cortana/` as the source for the team's Meta ad data.
Cortana (the Meta-consolidation tool) is retired as a data source; we now
pull the same numbers straight from Meta's Insights endpoint
(`/act_<id>/insights`). The mirror tables are UNCHANGED — this module
writes the exact same four tables the dashboard already reads:

  account grain  → meta_ad_daily          (PK day)
  campaign grain → cortana_campaign_daily  (PK day, entity_key)
  ad-set grain   → cortana_adset_daily     (PK day, entity_key)
  ad grain       → cortana_ad_daily        (PK day, entity_key)

The `cortana_*` table NAMES are kept (six dashboard consumers + the sales
bot + the RLS role read them) — same precedent as `meta_ad_daily` keeping
its name through the Sheet→Cortana swap. A rename is a separate, later pass.

Why this is cleaner than Cortana:
  - Ad-set grain is NATIVE (`level=adset`) — the `groupBy=medium` +
    numeric-id-filter hack is gone. `adset_id`/`adset_name` come straight
    from Meta.
  - `frequency`, `ctr`, `cpm`, `cost_per_unique_inline_link_click` are
    NATIVE — no derivation.
  - `platform_entity_id` IS Meta's `campaign_id`/`adset_id`/`ad_id`
    directly (joins `close_leads.*`); no `dimensionKey` parsing.

What is NOT ported (mirrored by Cortana but read by ZERO dashboard code):
  - the `conversions` jsonb attributed-funnel blob (setter_connected_call,
    appointment_booked, purchase, …) and the attributed rollups
    (`leads`/`roas`/`total_revenue`). The dashboard's funnel counts come
    from `close_leads`/`lead_cycles` joined on the Meta ids, NOT from this
    attribution. New rows carry `conversions = {}` and those rollup columns
    NULL. Historical Cortana rows keep their values untouched.

Per CLAUDE.md § Core Principles: this is a replaceable adapter in its own
module; agents/dashboards read the mirror tables, never this API.

Discovery (2026-06-30) + the token/timezone caveats live in
docs/runbooks/meta_ads_ingestion.md.
"""
