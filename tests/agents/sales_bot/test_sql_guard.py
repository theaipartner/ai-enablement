"""Unit tests for the sales-bot SQL guard (agents.sales_bot.sql_runner.guard).

The guard is the in-code belt over the read-only `sales_bot_ro` Postgres role
(migration 0113). These tests assert it: accepts read-only SELECT/WITH over the
allowlist (incl. CTEs, schema-qualified names, and callable sales functions),
auto-applies a row cap, and rejects writes / DDL / multi-statement /
off-allowlist queries — without false-rejecting on `;` or keywords that live
inside string literals or comments.

No DB needed — `guard()` is pure string analysis.
"""

from __future__ import annotations

import pytest

from agents.sales_bot.sql_runner import MAX_ROWS, guard


# --------------------------------------------------------------------------- #
# Accepts valid read-only queries
# --------------------------------------------------------------------------- #


def test_simple_select_passes_and_gets_limit():
    out = guard("select count(*) from lead_cycles")
    assert "from lead_cycles" in out
    assert out.rstrip().endswith(f"LIMIT {MAX_ROWS}")


def test_existing_limit_is_not_doubled():
    out = guard("select * from close_leads limit 10")
    assert out.lower().count("limit") == 1
    assert out.rstrip().lower().endswith("limit 10")


def test_with_cte_self_reference_is_allowed():
    # `daily` is a CTE name, not a table — must not be flagged off-allowlist.
    sql = (
        "with daily as (select activity_at::date d, count(*) n "
        "from close_calls group by 1) select * from daily order by d"
    )
    out = guard(sql)
    assert "from daily" in out


def test_schema_qualified_table_is_allowed():
    out = guard("select * from public.lead_cycles")
    assert "public.lead_cycles" in out


def test_callable_sales_function_is_allowed():
    out = guard("select sales_funnel_counts(now(), now())")
    assert "sales_funnel_counts" in out


def test_join_across_allowlist_tables_passes():
    sql = (
        "select tm.full_name, count(*) from close_calls cc "
        "join team_members tm on tm.close_user_id = cc.user_id "
        "where cc.duration >= 90 group by 1"
    )
    out = guard(sql)
    assert "join team_members" in out


def test_semicolon_inside_string_literal_is_not_multi_statement():
    out = guard("select * from close_leads where display_name = 'a;b'")
    assert "from close_leads" in out


def test_keyword_inside_string_literal_is_allowed():
    # 'delete' is in the literal, not a statement — must pass.
    out = guard("select * from close_leads where note = 'please delete me'")
    assert "from close_leads" in out


def test_offlist_name_in_comment_is_ignored():
    sql = "select count(*) from lead_cycles -- not from clients\n"
    out = guard(sql)
    assert "from lead_cycles" in out


# --------------------------------------------------------------------------- #
# Rejects writes / DDL
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "sql",
    [
        "insert into close_leads (close_id) values ('x')",
        "update close_leads set excluded_at = now()",
        "delete from close_leads",
        "drop table close_leads",
        "alter table close_leads add column x int",
        "create table foo (id int)",
        "truncate close_leads",
        "grant select on close_leads to public",
        "revoke select on close_leads from public",
        "with x as (delete from close_leads returning *) select * from x",
    ],
)
def test_write_and_ddl_are_rejected(sql):
    with pytest.raises(ValueError):
        guard(sql)


# --------------------------------------------------------------------------- #
# Rejects structural violations
# --------------------------------------------------------------------------- #


def test_multi_statement_is_rejected():
    with pytest.raises(ValueError):
        guard("select 1 from lead_cycles; select 2 from close_leads")


def test_non_select_start_is_rejected():
    with pytest.raises(ValueError):
        guard("explain select * from lead_cycles")


def test_empty_query_is_rejected():
    with pytest.raises(ValueError):
        guard("   ")


@pytest.mark.parametrize(
    "sql",
    [
        "select * from clients",
        "select * from nps_submissions",
        "select * from documents",
        "select * from slack_messages",
        "select c.id from lead_cycles lc join clients c on c.id = lc.close_id",
    ],
)
def test_offlist_tables_are_rejected(sql):
    with pytest.raises(ValueError):
        guard(sql)
