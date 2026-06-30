"""Read-only SQL execution for the sales bot — guard + runner.

Two layers of safety, both must hold:

  * **Suspenders (the real boundary):** the `sales_bot_ro` Postgres role
    (migration 0113). It is `default_transaction_read_only`, has an 8s
    statement timeout, and is granted `SELECT` on the sales allowlist ONLY.
    Even if everything below is bypassed, the DB refuses writes and anything
    off the allowlist.
  * **Belt (this module):** an in-code guard that rejects writes / DDL /
    multi-statement / off-allowlist SQL before it ever reaches the DB, and
    auto-appends a `LIMIT` row cap. Cheaper to fail here (Claude sees the
    error string and rewrites) than to round-trip a doomed query.

`run_sql(query)` returns `{"columns", "rows", "row_count", "truncated"}` on
success or raises `ValueError` (guard) / `Exception` (exec). The agent loop
turns either into a tool_result string Claude can self-correct on.

The introspection helper `fetch_column_catalog()` deliberately does NOT go
through `guard()` — it reads `information_schema` / `pg_catalog` (readable by
PUBLIC, so the RO role can see them) to build the schema block for the prompt.
"""

from __future__ import annotations

import os
import re
from typing import Any

import psycopg2

# Keep IN SYNC with the GRANT list in supabase/migrations/0113_sales_bot_ro_role.sql.
# Tables the bot may read + the read-only sales SQL functions it may call.
_ALLOW: frozenset[str] = frozenset(
    {
        # tables
        "close_leads",
        "close_calls",
        "close_sms",
        "close_lead_status_changes",
        "close_opportunities",
        "close_custom_field_definitions",
        "close_users",
        "lead_cycles",
        "lead_cycle_stages",
        "lead_tag_runs",
        "engagements",
        "calendly_scheduled_events",
        "calendly_invitees",
        "calendly_event_types",
        "airtable_setter_triage_calls",
        "airtable_full_closer_report",
        "airtable_digital_college_sales",
        "airtable_rep_eods",
        "sales_rep_candidates",
        "sales_rep_verifications",
        "typeform_responses",
        "typeform_forms",
        "typeform_form_insights_snapshots",
        "landing_pages",
        "landing_page_forms",
        "meta_ad_daily",
        "cortana_ad_daily",
        "cortana_campaign_daily",
        "cortana_adset_daily",
        "clarity_metrics_daily",
        "wistia_media_daily",
        "wistia_medias",
        "setter_call_reviews",
        "setter_call_transcripts",
        "outbound_campaigns",
        "outbound_campaign_roster",
        "outbound_lead_facts",
        "team_members",
        # callable read-only SQL functions (referenced as `from fn(...)`)
        "sales_funnel_counts",
        "outbound_funnel",
        "outbound_funnel_by_rep",
        "sales_speed_fmr",
        "sales_rep_call_activity",
    }
)

MAX_ROWS = 200

# Write / DDL keywords that could appear inside a SINGLE statement or a
# data-modifying CTE (`with x as (delete ...)`). Matched on the SCRUBBED sql
# (string literals + comments removed) so a value like 'a;b' or a commented-out
# word never trips them; word-boundaried so identifiers like `adset_id`,
# `date_trunc`, `close_calls`, `created_at` are safe. Session/maintenance verbs
# (set, copy, vacuum, comment, analyze, …) are intentionally NOT listed: they
# can't appear mid-SELECT, the read-only role blocks them anyway, and several
# collide with legitimate column names. The role is the real write boundary.
_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|do)\b",
    re.I,
)

_STARTS_OK = re.compile(r"(?is)^\s*(select|with)\b")
_LIMIT_TAIL = re.compile(r"(?i)\blimit\s+\d+\s*$")
# table/function refs after FROM or JOIN, optional schema qualifier (public.x)
_TABLE_REF = re.compile(
    r"(?is)\b(?:from|join)\s+(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)"
)
# CTE names defined by `with x as (...)` / `, y as (...)` (optional RECURSIVE)
_CTE_DEF = re.compile(r"(?is)\b(?:with|,)\s+(?:recursive\s+)?([a-z_][a-z0-9_]*)\s+as\b")


def _scrub(sql: str) -> str:
    """Return `sql` with line comments, block comments, and single-quoted
    string literals removed — for STATIC ANALYSIS only (the original text is
    what executes). Stripping these means a `;`, a forbidden keyword, or a
    table-looking token hiding inside a literal or comment can't fool the guard
    (and can't cause a false rejection of otherwise-valid SQL)."""
    # block comments /* ... */ (non-greedy, across newlines)
    s = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    # line comments -- ... to end of line
    s = re.sub(r"--[^\n]*", " ", s)
    # single-quoted strings, honoring '' escaped quotes
    s = re.sub(r"'(?:[^']|'')*'", " ", s)
    return s


def guard(sql: str) -> str:
    """Validate `sql` is a single read-only SELECT/WITH over the allowlist and
    return the (possibly LIMIT-capped) query to execute. Raises ValueError with
    a Claude-readable message on any violation."""
    original = sql.strip().rstrip().rstrip(";").rstrip()
    if not original:
        raise ValueError("empty query")

    scrub = _scrub(original).strip()

    if ";" in scrub:
        raise ValueError("only a single statement is allowed (no ';')")
    if not _STARTS_OK.match(scrub):
        raise ValueError("only read-only SELECT / WITH queries are allowed")
    forbidden = _FORBIDDEN.search(scrub)
    if forbidden:
        raise ValueError(
            f"forbidden keyword '{forbidden.group(1).lower()}' — this role is "
            "read-only (SELECT/WITH only)"
        )

    allowed = _ALLOW | {c.lower() for c in _CTE_DEF.findall(scrub)}
    refs = {r.lower() for r in _TABLE_REF.findall(scrub)}
    bad = sorted(refs - allowed)
    if bad:
        raise ValueError(
            f"off-allowlist table(s): {bad}. Only sales tables are queryable; "
            "fulfillment / client / PII tables are not accessible."
        )

    # Row cap: append LIMIT to the ORIGINAL if it has no trailing LIMIT.
    if _LIMIT_TAIL.search(scrub):
        return original
    return f"{original}\nLIMIT {MAX_ROWS}"


def connect_ro() -> "psycopg2.extensions.connection":
    """Open a psycopg2 connection as `sales_bot_ro` from SALES_BOT_DB_URL.
    Read-only + autocommit (no write txns; nothing to commit)."""
    dsn = os.environ.get("SALES_BOT_DB_URL")
    if not dsn:
        raise RuntimeError("SALES_BOT_DB_URL is not configured")
    conn = psycopg2.connect(dsn)
    conn.set_session(readonly=True, autocommit=True)
    return conn


def run_sql(query: str) -> dict[str, Any]:
    """Guard, then run ONE read-only SELECT and return rows.

    Returns `{"columns": [...], "rows": [[...]], "row_count": int,
    "truncated": bool}`. `truncated` is True when the result hit MAX_ROWS (so
    Claude knows the answer may be partial). The guard raises before any DB
    work on a disallowed query; exec errors propagate (the caller catches and
    feeds the message back to Claude)."""
    safe = guard(query)  # raises -> caller surfaces to Claude for a retry
    conn = connect_ro()
    try:
        cur = conn.cursor()
        cur.execute(safe)
        cols = [d[0] for d in cur.description] if cur.description else []
        rows = cur.fetchmany(MAX_ROWS)
        return {
            "columns": cols,
            "rows": [list(r) for r in rows],
            "row_count": len(rows),
            "truncated": len(rows) >= MAX_ROWS,
        }
    finally:
        conn.close()


def fetch_column_catalog(tables: list[str]) -> list[tuple[str, str, str, str | None]]:
    """Return `(table, column, data_type, comment)` rows for `tables`, ordered
    by table then column position. Used by prompt.py to feed Claude the live
    schema. Reads information_schema / pg_description directly (NOT via guard).
    """
    conn = connect_ro()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            select c.table_name, c.column_name, c.data_type, pgd.description
            from information_schema.columns c
            join pg_catalog.pg_class cls
              on cls.relname = c.table_name
            join pg_catalog.pg_namespace ns
              on ns.oid = cls.relnamespace and ns.nspname = c.table_schema
            left join pg_catalog.pg_description pgd
              on pgd.objoid = cls.oid and pgd.objsubid = c.ordinal_position
            where c.table_schema = 'public'
              and c.table_name = any(%s)
            order by c.table_name, c.ordinal_position
            """,
            (tables,),
        )
        return [(r[0], r[1], r[2], r[3]) for r in cur.fetchall()]
    finally:
        conn.close()
