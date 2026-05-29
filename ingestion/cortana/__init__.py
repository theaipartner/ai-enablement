"""Meta ad data ingestion from the Cortana Attribution API.

Replaces the prior Cortana → Google-Sheet → `meta_ad_daily` pipeline
(`ingestion/meta/`) which was broken (CTR exported as a date serial,
no per-campaign / per-ad grain). Cortana's `attribution/data` endpoint
is the single source for the team's Meta ad data; we pull it directly
over HTTPS instead of via the Sheet hop.

Three grains are mirrored, one table each:
  - source grain ("Meta Ads" row)  → `meta_ad_daily`  (unchanged schema;
    feeds the existing /sales-dashboard ADVERTISING section — CTR + and
    frequency are now REAL, not derived/broken)
  - campaign grain                  → `cortana_campaign_daily`
  - ad grain                        → `cortana_ad_daily`

Each grain is pulled once per ET calendar day (the endpoint aggregates
over whatever date range you ask for — there is no working per-day
`dailySummary`, so we window one ET day at a time). Idempotent upsert
keyed on (day, entity) so the cron can re-pull a trailing window and
restatements (Meta backfills spend/conversions for ~72h) just
overwrite — same last-write-wins contract the Sheet pipeline had.

Per CLAUDE.md § Core Principles: Cortana is a replaceable adapter
living in its own module; agents/dashboards read our mirror tables,
never this API directly.

Discovery (2026-05-29) lives in docs/runbooks/cortana_ingestion.md.
"""
