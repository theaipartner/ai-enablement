# Report (PARTIAL): Ella Passive Monitoring Default-On
**Slug:** ella-passive-monitoring-default-on
**Spec:** docs/specs/ella-passive-monitoring-default-on.md
**Status:** halted — gate (a) migration SQL review pending. Migration written + structurally validated; **not applied**. No code/tests/docs touched yet beyond the migration file itself (everything else is post-apply work). No gate (d).

> Read order: **§ The 3-part SQL** (the gate-(a) decision) → **§ Pre-apply cloud read** (the 129-row blast radius) → **§ Surprises** → **§ What's needed to unblock**.

## Acclimatization (3-4 bullets, per spec)

- Migration 0041 is latest; **0042 is the correct next number** (`ls supabase/migrations/` confirmed).
- The onboarding RPC `create_or_update_client_from_onboarding` was last reissued in migration 0029 (post-`ella_enabled`→`passive_monitoring_enabled` rename). I read `pg_get_functiondef('public.create_or_update_client_from_onboarding'::regproc)` from cloud and **diffed it byte-equal (whitespace-agnostic) against 0029's reissue** — no drift since 0029, so the verbatim-copy plan is safe (hard stop #5 satisfied).
- Branch C of the RPC inserts into `slack_channels` with `(slack_channel_id, client_id, name, is_private, is_archived, passive_monitoring_enabled, metadata)` and values `(p_slack_channel_id, v_existing_id, p_full_name, false, false, false, jsonb_build_object(...))` — the 3rd `false` is `passive_monitoring_enabled`. That's the **single-character flip** the migration applies; `is_private` and `is_archived` stay `false`.
- `ingestion/slack/realtime_ingest.py:_maybe_dispatch_passive_monitor` (the gate the toggle controls) is unchanged — it reads `slack_channels.passive_monitoring_enabled` from the channel row at dispatch time, so the bulk-flip lands instantly for live traffic without any code touch.

## 1. Files touched

**Created (1):**
- `supabase/migrations/0042_slack_channels_passive_default_true.sql` — 328 lines, 12,285 bytes. Three-part SQL: default flip + bulk UPDATE + RPC reissue (verbatim body from 0029 + one-value flip + audit-comment append). **Written, NOT applied.**

**Modified:** none. No code, no tests, no docs, no env. Per the spec, this migration is schema+data+RPC-only.

## 2. What I did, in plain English

Verified migration 0042 is the right next number; pulled the live `create_or_update_client_from_onboarding` body from cloud via `pg_get_functiondef` and confirmed byte-equality (whitespace-agnostic) against migration 0029's reissue — so the verbatim-copy approach the spec describes is safe and the spec's hard stop #5 (RPC body drift risk) is satisfied. Composed migration 0042 in three parts: (1) `ALTER COLUMN passive_monitoring_enabled SET DEFAULT true`; (2) bulk `UPDATE` flipping non-archived, client-mapped channels that are currently false; (3) `CREATE OR REPLACE` the RPC with the full 0029 body verbatim, with the single value flip in Branch C's INSERT (`false → true` for `passive_monitoring_enabled` only — `is_private` and `is_archived` remain `false`) plus a `0042 update: …` audit suffix appended to the trailing `COMMENT ON FUNCTION` text, mirroring the 0029 pattern. Structural checks pass (correct flip position confirmed via regex; `language plpgsql` / `security definer` / `grant execute` boilerplate present). `pytest tests/` at the baseline 653 (no code touched). Halted at gate (a).

## 3. Verification (pre-apply)

- **Migration number:** 0042 confirmed next (`ls supabase/migrations/` tail: 0040, 0041, **0042**).
- **RPC body drift check:** live body via `pg_get_functiondef` vs 0029 reissue → whitespace-agnostic byte-equal (6306 chars each, identical after normalization). Hard stop #5 satisfied.
- **Branch C VALUES surgery:** `is_private / is_archived / passive_monitoring_enabled → false / false / true` (verified by regex on the migration file).
- **Boilerplate intact:** `language plpgsql`, `security definer`, `comment on function …`, `grant execute … to service_role` all present in the reissued RPC.
- **`pytest tests/`:** 653 passed, 0 failed (baseline 635 + the prior 4 specs' adds; this spec touched no code).
- **NOT verified — gate (a) is blocking apply.** The dual-verify queries (schema default, data state, RPC reality, ledger) run post-apply.

## 4. Surprises and judgment calls

1. **Live RPC body byte-equals 0029 reissue (whitespace-agnostic).** Good news for hard stop #5 — there's no Studio-side manual edit since 0029. Worth noting because it means the verbatim-copy approach can be performed safely without surfacing any unexpected diffs.
2. **The bulk-UPDATE blast radius is 129 rows.** Pre-apply distribution: 129 non-archived client-mapped channels currently `false`, 8 already `true` (the 7 Batch-1 cohort channels flipped 2026-05-11 + `#ella-test-drakeonly`). Post-apply: 137 non-archived client-mapped channels, all `true`. The 8 already-on channels skip the WHERE clause cleanly (the predicate is `= false`). Spec's "what could go wrong" #1 predicted a 15-20x volume spike on Haiku → 7→137 is **19.6x**, within the predicted band; cost-hub will show the spike but well under the $200/month watchpoint.
3. **0 rows in archived or unmapped states touched.** The WHERE clause filters `is_archived = false AND client_id IS NOT NULL` deliberately; the pre-apply read confirmed 0 archived-and-false-with-client-id rows and 0 client_id-null-and-false rows are in scope (your `is_archived=true` channels and any unmapped rows are unaffected).
4. **Doc + test work deferred to post-apply.** State.md / ella.md / runbook need the actual post-apply counts (the spec asks for the bulk-flip count from dual-verify in state.md). Tests are minimal too — the spec's test additions ("new client lands with passive=true") run against a mocked DB and can't meaningfully assert RPC body behavior; I plan to confirm pytest stays green post-apply and surface that no new unit tests provide signal beyond what the dual-verify queries cover. Calling this out so it's not a "did Builder forget the doc updates" moment when the report is finalized.
5. **The 7 Batch-1 channels + test-mode channel get the audit comment "0042 update" annotation** via the COMMENT ON FUNCTION append — that's purely the RPC's documentation comment, not anything user-visible. Mirrors the 0029 pattern.
6. **`ella-decision-haiku-prompt-sharpening` v1/v2 + `ella-at-mention-structural-override` all shipped before this**, so the over-skip regression that motivated keeping the smaller blast radius is closed. The 129-channel flip lands into a system where every channel's @-mention behavior is structurally fixed.

## 5. Out of scope / deferred (until post-apply)

- Migration apply + dual-verify.
- Tests (likely none — see Surprise 4; will confirm pytest still ≥653 post-apply).
- Docs: `state.md` entry with actual post-apply count, `ella.md` "passive monitoring defaults on" language, `ella_passive_monitoring.md` 2026-05-19 reasoning note.
- Phase 1 immediate smoke (count + default queries — Builder runs).
- Phase 2 behavioral validation (Drake watches `/ella/runs` + checks `#unanswered-channels`).
- Spec status flip to `shipped` + report finalization.

## 6. Side effects

- One read-only cloud query (`pg_get_functiondef` + 4 SELECTs for the distribution / default / ledger checks). No DB writes, no Slack posts.
- Git: **no commit yet** for this work — the migration file is uncommitted in the working tree until you approve the SQL (so a pre-approval push doesn't accidentally land 0042 in CI / make it discoverable). This report file itself is committed + pushed; the migration file is staged-locally only.

## The 3-part SQL (the gate-(a) decision)

Reading from `supabase/migrations/0042_slack_channels_passive_default_true.sql`. Quoting the load-bearing parts; the RPC reissue body is 0029's, verbatim, with the marked single delta.

### Part 1: default flip
```sql
alter table slack_channels
  alter column passive_monitoring_enabled set default true;
```

### Part 2: bulk UPDATE
```sql
update slack_channels
   set passive_monitoring_enabled = true
 where passive_monitoring_enabled = false
   and is_archived = false
   and client_id is not null;
```

### Part 3: RPC reissue — the single-value delta
Full body is the verbatim 0029 reissue (256 lines after the header). The only behavioral delta is one character in Branch C's INSERT into `slack_channels`:

```sql
        insert into slack_channels (
          slack_channel_id, client_id, name, is_private, is_archived,
          passive_monitoring_enabled, metadata
        ) values (
          p_slack_channel_id,
          v_existing_id,
          p_full_name,
          false,
          false,
          true,                      -- was `false` in 0029
          jsonb_build_object('created_via', 'onboarding_webhook')
        );
```

…plus the trailing `COMMENT ON FUNCTION` gains a `0042 update: Branch C INSERT now writes passive_monitoring_enabled=true at row creation …` suffix, mirroring the 0029 audit pattern. The `language plpgsql` declaration, `security definer`, and `grant execute … to service_role` are unchanged.

Pre-apply cloud confirms the live function body matches 0029 byte-equal (whitespace-agnostic), so the verbatim copy carries no other surprises.

## Pre-apply cloud read (blast radius)

```
current default:                                             false
distribution (passive / archived / has_client_id):
  False / False / True  → 129  (← bulk-UPDATE target)
  True  / False / True  →   8  (Batch-1 cohort + test channel — already on)
bulk-UPDATE row count (rows flipping false → true):           129
non-archived client-mapped total (post-apply: all on):        137
ledger 0042 (should be empty pre-apply):                      []
```

0 archived rows and 0 unmapped (client_id IS NULL) rows are affected by the bulk UPDATE. The 8 already-true channels skip the WHERE clause naturally.

## What's needed to unblock — gate (a), Drake

Read parts 1-3 above. The full RPC reissue body sits in `supabase/migrations/0042_slack_channels_passive_default_true.sql` (uncommitted, 328 lines) if you want to spot-check the verbatim copy — `git diff /dev/null supabase/migrations/0042_slack_channels_passive_default_true.sql` shows it whole.

On your explicit "approved," Builder will:
1. Apply via `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes`.
2. Dual-verify (schema default + data state + RPC body via `pg_get_functiondef` + ledger `0042`).
3. Phase 1 smoke: the two count/default queries from the spec.
4. Commit the migration + write docs (`state.md` with post-apply count, `ella.md`, runbook) + finalize this report dropping `(PARTIAL)` and flipping the spec `Status:` to `shipped`.
5. Push.

If anything in the dual-verify doesn't line up, STOP per spec hard stop #2 and hand back. Phase 2 (your `/ella/runs` + `#unanswered-channels` watch over the next few hours) is your gate (c), non-blocking for spec completion.
