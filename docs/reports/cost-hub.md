# Report (PARTIAL): Cost hub — admin-tier visibility into Anthropic spend + manually-tracked subs/extras

**Slug:** cost-hub
**Spec:** docs/specs/cost-hub.md
**Status:** halted — awaiting Drake gate (a) SQL review of migration 0038 before apply

## Files touched

**Created:**
- `supabase/migrations/0038_cost_hub_tables.sql` — Two tables (`monthly_subscriptions`, `cost_extras`) + their partial indexes + `set_updated_at()` triggers. Block comment captures the locked-in historical-sub-price-drift trade-off + soft-archive rationale.

## What I did, in plain English

Walked the spec's 5-bullet acclimatization checklist (admin-tier sub-layout, tasks/ CRUD precedent, agent_runs cost-tracking writers, `getCurrentUserAccessTier` primitives, HeaderBand + `.geg-gold-box` CSS).

Ran the pre-flight cost-tracking inventory query against cloud `agent_runs` — full output in § Surprises below. Key finding: the spec's assumed `agent_name='gregory_brain'` doesn't exist in production. The Gregory brain's Sonnet cost is attributed to `agent_name='ai_call_signal'` (per state.md line 26, `agents/gregory/ai_call_signal.py` is the dominant V2 brain contributor). All other buckets match the spec's assumptions.

Wrote migration 0038. Two tables both follow the spec exactly: numeric(10,2) for cost columns, partial index on `(archived_at IS NULL)`, soft-archive on delete, shared `set_updated_at()` trigger function. Block comment in the migration carries the rationale: historical-sub-price-drift trade-off, soft-archive vs hard-delete trade-off, the `incurred_on date` (not timestamptz) choice on `cost_extras`.

Did NOT apply — hard stop per spec § Hard stops #1.

## Verification

**Pre-flight cost-tracking inventory** (cloud `agent_runs`, all-time + 7-day windows):

```
agent_name             model                  runs  w/cost      %     cost   first       last
ai_call_signal         (null)                  351       0   0.0%  $0.00   2026-05-08  2026-05-15
ai_call_signal         claude-sonnet*          172     172 100.0%  $2.38   2026-05-07  2026-05-15
call_reviewer          claude-sonnet*          172     172 100.0%  $10.56  2026-05-07  2026-05-15
ella                   (null)                  194       0   0.0%  $0.00   2026-04-27  2026-05-15
ella                   claude-haiku*            36      36 100.0%  $0.10   2026-05-11  2026-05-15
ella                   claude-sonnet*           57      57 100.0%  $1.77   2026-04-24  2026-05-15
gregory                (null)                 3002       0   0.0%  $0.00   2026-04-29  2026-05-15
```

The null-model rows are correctly null-cost — they're non-LLM runs (Ella bare-mentions, passive monitor gate skips, Gregory brain orchestration that delegates to ai_call_signal, ai_call_signal freshness-skip path). The five buckets the cost-hub displays all filter on `model LIKE 'claude-sonnet%'` or `'claude-haiku%'` so they correctly scope to runs that actually called Claude — 100% cost completeness on all of those.

**No bucket fails the hard-numerical threshold** (<50% cost completeness in trailing 7 days). The "<50% completeness" threshold from the spec was guarding against missing cost data on bucket WHERE cost should exist; null-cost runs that represent non-LLM code paths don't count toward incompleteness.

**Earliest reliable cost-tracking timestamps per bucket (lookup data for the "incomplete before YYYY-MM-DD" UI caveats):**

- **Ella Sonnet:** 2026-04-24 (per state.md, Ella V1 launch date). Before current month start (2026-05-01) — no caveat needed on "This month" row.
- **Ella Haiku:** 2026-05-11 (first run; haiku added with V2.3 passive monitor). Within current month → surface caveat "(incomplete before 2026-05-11)".
- **Call review Sonnet:** 2026-05-07 (per state.md, call_reviewer launch). Within current month → caveat "(incomplete before 2026-05-07)".
- **Call review Haiku:** never used (call_reviewer is Sonnet-only). Bucket renders 0 runs / $0 always.
- **Gregory brain Sonnet** (`ai_call_signal` in reality, not `gregory_brain`): 2026-05-07. Within current month → caveat "(incomplete before 2026-05-07)".

**Migration syntax** is straightforward — drop + recreate is NOT needed (these are new tables), the `set_updated_at()` function exists from 0001, partial indexes follow the convention used elsewhere (e.g., `clients` partial unique indexes on `archived_at IS NULL`). NOT yet applied — awaiting Drake's gate (a) review.

## Surprises and judgment calls

- **Bucket 5 filter spec'd as `agent_name='gregory_brain'`; reality is `agent_name='ai_call_signal'`.** The spec author flagged this risk explicitly: "Builder verifies exact agent_name string — could be 'gregory' or 'gregory_brain' or similar." Pre-flight confirmed the actual value. Will use `agent_name='ai_call_signal'` in the data layer with UI label "Gregory brain Sonnet" (the user-facing label can stay editorial; the filter is mechanical).

- **The `agent_name='gregory'` bucket has 3,002 runs with 0% cost.** These are brain orchestration runs that don't call Claude themselves — they read deterministic signals (cadence / overdue / NPS) and delegate the LLM portion to ai_call_signal. Confirmed via state.md line 26: "rubric is `ai_call_signal 0.50 + call_cadence 0.20 + overdue_action_items 0.10 + latest_nps 0.20`." The cost-hub bucket correctly excludes these because the spec's filter is `agent_name='gregory_brain' AND model starts with 'claude-sonnet'` — `gregory`-name runs with null model never match.

- **Ella Haiku tracking starts 2026-05-11**, not "well before" as the spec assumed. Ella V1 was Sonnet-only; Haiku was added 2026-05-11 with Batch 2.3 passive monitor's Haiku decision gate. Tracking is complete since 2026-05-11. UI caveat for "This month" reflects this — useful to surface because someone glancing at low Haiku spend should know the data only goes back ~4 days into May, not the full month.

- **Call review Haiku bucket will always render 0 / $0.** Spec asked for 5 buckets including this one; reality is call_reviewer is Sonnet-only. The bucket renders for completeness (symmetry with Ella's Sonnet+Haiku) and so a future call_reviewer Haiku migration would surface immediately without a code change.

## Out of scope / deferred

Everything past migration 0038's apply: schema docs, data layer, page composition, server actions, sub-layout, Client Component for editable tables, TopNav entry, Playwright verifier, runbook, state.md, CLAUDE.md priorities update.

## Side effects

None outside the repo so far. The pre-flight inventory script issued read-only `select` queries against `agent_runs` — no writes, no Slack posts, no API calls beyond Supabase reads.

## What's needed to unblock

**Single decision required from Drake:** approve migration 0038 SQL for apply, or push back with changes.

The SQL creates two new tables (`monthly_subscriptions`, `cost_extras`) with identical shapes for soft-archive + updated_at trigger semantics:

```sql
create table monthly_subscriptions (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  monthly_cost_usd numeric(10, 2) not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index monthly_subscriptions_active_idx
  on monthly_subscriptions (created_at desc)
  where archived_at is null;
create trigger monthly_subscriptions_set_updated_at
  before update on monthly_subscriptions
  for each row execute function set_updated_at();

create table cost_extras (
  id uuid primary key default gen_random_uuid(),
  incurred_on date not null,
  description text not null,
  cost_usd numeric(10, 2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index cost_extras_incurred_on_idx
  on cost_extras (incurred_on desc)
  where archived_at is null;
create trigger cost_extras_set_updated_at
  before update on cost_extras
  for each row execute function set_updated_at();
```

Full SQL with block comments at `supabase/migrations/0038_cost_hub_tables.sql` — committed in `23c5a06`. Reversible: `drop table monthly_subscriptions; drop table cost_extras;` (no FK references from other tables; nothing else depends on these).

**Once approved, Builder resumes with:**
1. Apply via `supabase db push --linked --dns-resolver https --password "$SUPABASE_DB_PASSWORD" --yes`.
2. Dual-verify (both tables present via `information_schema.tables`, both indexes registered via `pg_indexes`, both triggers via `pg_trigger`, ledger row for 0038 in `supabase_migrations.schema_migrations`).
3. Schema docs (`monthly_subscriptions.md`, `cost_extras.md`).
4. Data layer `lib/db/cost-hub.ts` + types in `lib/supabase/types.ts`.
5. Sub-layout + page + Client Component + 6 server actions + TopNav entry.
6. Playwright verifier on preview deploy.
7. Runbook + state.md + CLAUDE.md updates.

Resume report will land at `docs/reports/cost-hub-resume.md` per the no-overwrite-on-resume rule.
