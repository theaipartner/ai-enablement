"""Airtable ingestion — sales-funnel mirror for base appCWa6TV6p7EBarC.

Three logical sources, two mirror tables. The Full Closer Report has a
US variant and an AUS variant; they're unioned via a `region`
discriminator column into one table since the field sets overlap
~entirely.

Discovery: docs/reports/airtable-discovery.md (Drake's confirmed
config + the five aggregation-layer-pending ambiguities).
Spec: docs/specs/airtable-ingestion.md.
Schema: docs/schema/airtable_setter_triage_calls.md +
        docs/schema/airtable_full_closer_report.md.
Runbook: docs/runbooks/airtable_ingestion.md.

The defining constraint: NEITHER target Airtable table has a stored
`lastModifiedTime` or `createdTime` FIELD. Incremental ingestion can
only use Airtable's record-level `createdTime` metadata — which is
created-only. The cron backstop catches missed webhook CREATIONS but
is structurally blind to EDITS. The live webhook is the only
edit-detection path.
"""

# Airtable base ID — the one base that holds all our sales-funnel tables.
# Hardcoded because it's not a secret and changing it means a re-discovery,
# not a config tweak.
BASE_ID = "appCWa6TV6p7EBarC"


# Table id → (human label, region tag or None, target Supabase mirror table).
# `region` is non-None only for Full Closer Report variants (the US/AUS
# discriminator column). Setter Triage doesn't have regional variants
# in this base today.
TARGET_TABLES: dict[str, tuple[str, str | None, str]] = {
    "tblaoMsiE3FSkHjQt": (
        "Setter Triage Calls",
        None,
        "airtable_setter_triage_calls",
    ),
    "tblYsh3fxTpXuPdIW": (
        "Full Closer Report (US)",
        "US",
        "airtable_full_closer_report",
    ),
    "tblcC25y6lMrtgcty": (
        "Full Closer Report (AUS)",
        "AUS",
        "airtable_full_closer_report",
    ),
    "tbljmzRoMoE5B26lt": (
        "Digital College",
        None,
        "airtable_digital_college_sales",
    ),
    # Rep EOD's — both kinds mirror into one table (airtable_rep_eods); the
    # parser dispatch in pipeline.py keys the setter/closer discriminator off
    # the table id. region slot unused (None).
    "tblnGf0NoNCWVwOsz": (
        "Setter EOD's",
        None,
        "airtable_rep_eods",
    ),
    "tbly2S13lmo82xy5e": (
        "Closer EOD's",
        None,
        "airtable_rep_eods",
    ),
}


# The Airtable "Sales Team Member" table — the roster of sales reps. NOT in
# TARGET_TABLES (the webhook/cron sync that mirrors forms): this table is read
# on its own by api/sales_rep_candidates_sync_cron.py into `sales_rep_candidates`
# to feed the admin verify page. Each record's id IS a team_members.airtable_user_id.
SALES_TEAM_MEMBER_TABLE_ID = "tblpSaR3Iq4vBBbpO"


# Audit source name used in webhook_deliveries — distinct buckets for
# the webhook receiver vs the cron backstop so failures attribute
# cleanly.
AUDIT_SOURCE_WEBHOOK = "airtable_webhook"
AUDIT_SOURCE_CRON = "airtable_sync_cron"
