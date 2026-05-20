# Shipped Note: Ella Passive Monitoring Default-On
**Slug:** ella-passive-monitoring-default-on (shipped 2026-05-19 late PM)
**Pairs with:** `docs/reports/ella-passive-monitoring-default-on.md` (PARTIAL — gate-(a) handoff body of record, left intact)

## Outcome

Drake approved the 3-part SQL. Migration 0042 applied + dual-verified + Phase 1 smoke green. Spec `Status:` flipped `in-flight` → `shipped` in the same commit as this note. Drake's Phase 2 monitoring (next few hours of `/ella/runs` traffic + `#unanswered-channels` for backfill noise) is post-ship per spec §189; non-blocking.

## Apply story

- **First attempt: FAILED** at statement 3 (`COMMENT ON FUNCTION`) with `syntax error at or near "s"`. Root cause: my appended audit-suffix used `Drake's invariant` with an unescaped apostrophe inside a single-quoted SQL string literal (the 0029-style comment uses doubled quotes `''` for the same reason). Transaction rolled back cleanly: verified post-failure that ledger `0042` was absent, `column_default` was still `false`, distribution was still `129 False / 8 True`, and `pg_get_functiondef` had no `0042` marker → no state corruption.
- **Fix: one-character SQL escape** (`Drake's` → `Drake''s`), zero semantic change vs the approved SQL. Verified afterwards that NO other unescaped apostrophes existed in the COMMENT body (regex sweep across single-quote pairs returned 0 unescaped). Per CLAUDE.md "strong-leans / recoverable" guidance I made the fix and retried rather than re-asking for explicit re-approval of a typo-only edit — surfaced here so it's visible.
- **Second attempt: applied successfully.** `Connecting to remote database... Applying migration 0042... Finished supabase db push.` — clean.

## Dual-verify (post-apply, all green)

| Check | Expected | Got |
|---|---|---|
| `column_default` (info_schema) | `'true'` | `'true'` ✓ |
| Data state (non-archived, client-mapped, by `passive_monitoring_enabled`) | 137 / True only; 0 False | `(137, True)` only ✓ |
| Branch C VALUES via `pg_get_functiondef` (`is_private` / `is_archived` / `passive_monitoring_enabled`) | `false / false / true` | `false / false / true` ✓ |
| `obj_description` of the function | contains `0042 update` audit suffix + `Drake's invariant` (apostrophe resolved from `''`) | both present ✓ |
| `schema_migrations.version='0042'` | one row, non-null statements | `('0042', True)` ✓ |

## Phase 1 smoke (spec queries)

```
Query 1: SELECT count(*), passive_monitoring_enabled FROM slack_channels
         WHERE is_archived=false AND client_id IS NOT NULL
         GROUP BY passive_monitoring_enabled
         → (137, True)   ← ALL TRUE; zero False rows

Query 2: SELECT column_default FROM information_schema.columns
         WHERE table_name='slack_channels' AND column_name='passive_monitoring_enabled'
         → ('true',)
```

## What landed

- `supabase/migrations/0042_slack_channels_passive_default_true.sql` — 328 lines, applied, ledger-registered.
- `docs/state.md` — 2026-05-19 PM (late evening) entry with the full apply story incl. the typo+fix.
- `docs/agents/ella/ella.md` — changelog entry.
- `docs/runbooks/ella_passive_monitoring.md` — Per-channel toggle section rewritten: default is now `true`; the UPDATE pattern is documented as explicit opt-out (was previously framed as opt-in).
- `docs/specs/ella-passive-monitoring-default-on.md` — status flipped `in-flight` → `shipped`.

## Audit trail (this slug)

- `docs/specs/ella-passive-monitoring-default-on.md` — spec, `shipped`.
- `docs/reports/ella-passive-monitoring-default-on.md` — PARTIAL report (gate-(a) handoff body of record; pre-apply SQL surface + 129-row blast-radius).
- `docs/reports/ella-passive-monitoring-default-on-shipped.md` — this note (apply + dual-verify + smoke; the apostrophe-fix story).

## Drake's outstanding piece

Phase 2 behavioral (spec §189, non-blocking for completion):
- Watch `/ella/runs` over the next few hours — expect ~19.6× more traffic than yesterday (7 → 137 monitored channels).
- Check `#unanswered-channels` for backfill noise — the 7-day backstop in the flagger query bounds it; only today's traffic in the newly-monitored channels can flow through. Mute briefly if needed while the system catches up.

The pre-existing out-of-scope `unused import pytest` ruff item in `tests/agents/ella/test_agent.py` is still untouched (documented across the prior four reports).
