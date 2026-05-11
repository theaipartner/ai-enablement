# Ella V2 — Batch 2.2: audit dashboard

**Slug:** ella-v2-batch-2-2-audit-dashboard
**Status:** in-flight

## Context

Ella V2 Batch 1.5 shipped behavioral fixes. Batch 2.3 (passive monitoring) is queued next but will explode run volume — today 28 V1 runs total, projected to be 50-200+ per day across 8 pilot channels once passive is live. The existing audit surface is a one-shot Python script (`scripts/audit_ella_interactions.py`) that dumps a single markdown file — fine for 28 runs, unreadable at scale.

This spec ships a queryable Gregory-dashboard audit page that surfaces every Ella run with filtering, per-row detail, and anomaly views. It's a prerequisite for safely operating Batch 2.3 — without it, the first production problem in passive monitoring would be diagnosed by reading a 5000-line markdown file. With it, Drake (and eventually CSMs / Nabeel) can spot patterns in real time.

The dashboard surface is scoped narrowly to Ella runs only (per Drake's "option A" call). A generic agent-runs audit page that would also cover Gregory brain runs / future agents is real future-work but explicitly out of scope here — build narrow, broaden later if a second agent surfaces the need.

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. The current Gregory dashboard surface — read `app/` to confirm the Next.js 14 app-router layout, the `(authenticated)` route group, the auth-gate pattern via the Supabase client. Look at the existing `/clients` and `/calls` pages as patterns to match.
2. The `agent_runs` schema — confirm columns we'll query (`id`, `agent_name`, `status`, `trigger_metadata`, `input_summary`, `output_summary`, `tokens_in`, `tokens_out`, `cost_usd`, `duration_ms`, `created_at`, plus the channel/user fields). Per the Batch 1.5 work the trigger_metadata now carries `real_author_role`, `real_author_name`, `real_author_id` for new runs — pre-Batch-1.5 runs don't have these fields.
3. The `escalations` schema — how it links to `agent_runs`, what's in `context` jsonb. Used to surface escalation outcomes on the per-row detail view.
4. The `slack_messages` schema — same one the audit script queries. Used to render surrounding-context for each run on the detail view.
5. The shared UI primitives in `components/` — `components/ui/`, `components/client-detail/` patterns, the existing pill components (`StatusPill`, `JourneyStagePill`, etc.). New audit-specific pills (anomaly flags, Haiku decision) should match the existing palette and shape rules.

## Goal

Ship a Gregory dashboard page at `/ella/runs` (Builder's call on exact path — could be `/agents/ella/runs` for forward-compatibility with multi-agent later) that provides:

- A filterable, paginated list of all Ella runs (most recent first)
- Per-row click-through to a detail page showing the full interaction context
- An "anomalies" view pre-filtered to runs that hit one of the audit's defined anomaly checks
- A daily summary band at the top of the list (runs/day, skip vs respond rate, cost trend, escalation rate)

This is read-only — no audit page action modifies data. Drake (and eventually CSMs) read the page; they don't write through it.

## What success looks like

### Route structure

- **`/ella/runs`** — list view, default sort `created_at DESC`. Filters in URL query params so views are linkable.
- **`/ella/runs/[id]`** — per-run detail view. Full interaction context.

Both pages live under the existing `(authenticated)` layout — Supabase auth gate, service-role DB reads via the `'server-only'` guard pattern.

### List view (`/ella/runs`)

**Top band — summary stats** (computed server-side, cached short — say 60s):

- Runs today, this week, this month
- Per-status counts (responded / escalated / error / skipped — pre-Batch-2.3 only has `success` / `error`; post-2.3 adds `respond_substantive / respond_general_inquiry / skip / escalate`)
- Total cost today, this week
- Anomaly count today (any of the audit-script's Check A through Check E patterns)

**Filter bar** (multi-select where it makes sense, single-value for date range):

- Date range (default: last 7 days)
- Channel (multi-select, lists channels with ≥1 Ella run)
- Speaker role (client / advisor / unresolvable / unknown — pre-Batch-1.5 runs are "unknown")
- Status (multi-select)
- Anomaly flags (multi-select — A: ESCALATE leak, B': real-author mismatch, C: error, D: length outlier, E: bare-mention)
- Haiku decision (multi-select — only relevant post-Batch-2.3, but render the field anyway so the column exists)

Filters serialize to URL query params (`?from=2026-05-01&to=2026-05-10&channel=C09FA7EQRDL&status=error,success`). State is shareable.

**List table** — each row:

- Timestamp (relative — "5m ago" / "2h ago" / "yesterday at 3pm" / full date for older)
- Channel name + mapped client name
- Real author (resolved name + role pill: client / advisor / unresolvable)
- Status pill
- Anomaly flags as small badges (red for A/C, amber for B'/D/E)
- Input preview (first ~80 chars of `input_summary`)
- Tokens + cost (compact: "5.6k / 250 · $0.022")
- Click-through arrow

Paginate at 50 rows. Standard Gregory pagination pattern.

### Detail view (`/ella/runs/[id]`)

Single page showing one run. Sections in order:

**Header band:**
- Run ID (copyable)
- Timestamp (absolute + relative)
- Channel, mapped client, real author + role
- Status pill, anomaly flags
- Cost / tokens / duration
- Link back to list view

**Input:**
- The triggering message text (full, not truncated)
- Trigger type (slack_mention / message_passive / bare_mention etc.)
- Trigger ts + thread_ts (small monospace, copyable)

**Surrounding context:**
- The last 15 messages in the same channel + thread (from `slack_messages`) leading up to the trigger ts
- Format: `[HH:MM] <role pill> <resolved name>: <text>` per line
- Triggering message highlighted (different background)
- This is the same context Ella's prompt received during generation (Batch 1.5)

**Ella's response:**
- The full response text Ella posted (from `slack_messages` matching `author_type='ella'` near the trigger ts, OR `agent_runs.output_summary` if response wasn't ingested)
- Note source — "from slack_messages" or "from agent_runs.output_summary (200 char limit)"
- If `[ESCALATE]` was detected, show the stripped client-facing text vs the captured handoff_reasoning separately

**Haiku decision** (only for runs post-Batch-2.3; for earlier runs show "N/A — pre-passive-monitoring run"):
- Decision (respond_substantive / respond_general_inquiry / skip / escalate)
- Reasoning (the Haiku output text)

**Escalation** (if status='escalated' or escalations row exists):
- Proposed response
- Resolution status (resolved / pending / abandoned)
- Resolved by + at, if resolved

**Metadata footer:**
- All `trigger_metadata` fields, rendered as a small key/value list
- Cost breakdown if available (input tokens × rate + output tokens × rate)

### Anomaly view

A toggle or chip at the top of the list view: "Show anomalies only." Pre-applies a filter where any anomaly flag is true. Same list shape, fewer rows.

Anomaly detection is computed at query time (or in a SQL view, Builder's choice). The five checks from the audit script translate directly:

- **A**: `[ESCALATE]` appears in the Slack-side response text AND no `escalations` row exists for this run
- **B'**: real_author_id ≠ channel_mapped_client.slack_user_id (or is_team_member where channel is mapped to a client)
- **C**: status='error'
- **D**: length outlier — `output_chars` in the top 5% or bottom 5% across all runs in the date range
- **E**: bare-mention — input_summary length after stripping mentions is <5 chars

These are display-only flags — they don't trigger any system behavior. Just visualization.

### Daily summary metrics endpoint

A small API route at `/api/ella/daily-summary` (or render server-side inline — Builder's call). Returns the daily aggregates the summary band uses. Cache 60s.

## Hard stops

- **No agent runs from other agents.** Filter `agent_name='ella'` everywhere. Showing Gregory brain runs in the Ella audit accidentally would be confusing and bypasses the "narrow surface" design choice.
- **No write paths.** The audit page is read-only. If a user clicks something that looks like an action (e.g., "mark this run as reviewed"), surface as "not yet implemented" — that's future state. No schema changes for review-state tracking in this spec.
- **No PII leakage in URLs.** Query params can carry filter values (channel IDs, status names, date ranges). They must NOT carry client names or message text. Detail views use the run ID (UUID) in the path, not anything human-readable.
- **No new auth surfaces.** Reuse the existing `(authenticated)` layout. Anyone with Gregory access gets this page. Don't gate on a separate "ella audit" permission.
- **No client-facing surfaces.** This is an internal team tool. The 8 pilot client channels never link to this dashboard, and Ella never references it in her responses.
- **No schema changes.** This spec uses only existing tables and columns. If Builder finds a column we need but don't have (e.g., `agent_runs.haiku_decision` doesn't exist yet because Batch 2.3 hasn't shipped), surface as a follow-up — don't add columns in this spec.
- **No new ingestion logic.** Pure read surface. No new writes to `agent_runs`, `slack_messages`, etc.

## Mandatory doc updates

- **`docs/agents/gregory.md` § Dashboard surfaces** — add a paragraph documenting the new `/ella/runs` page. Two or three sentences. Same shape as the existing surfaces section.
- **`CLAUDE.md` § Live System State** — append an entry noting the audit dashboard ship. Suggested wording (Builder tightens):
  > Ella V2 Batch 2.2 — audit dashboard (shipped <date>). New Gregory dashboard page at `/ella/runs` with filterable list (by date / channel / role / status / anomaly flag / Haiku decision), per-run detail view showing input + surrounding context + Ella's response + escalation routing, and an anomaly view surfacing runs that hit any of the five audit checks (ESCALATE leak / real-author mismatch / error / length outlier / bare-mention). Read-only surface, narrow to Ella runs only. Prereq landing before Batch 2.3 passive monitoring so post-passive run volume is operationally manageable.
- **No new runbooks** — this is a read-only dashboard. If a debugging procedure emerges (e.g., "to investigate a leaked ESCALATE, do X"), capture in `docs/agents/ella/ella.md` or `docs/known-issues.md` rather than its own runbook.
- **No update to `docs/agents/ella/future-ideas.md`** — this is shipping, not deferring. No entry to mark resolved.

## What could go wrong

Think this through yourself:

- **Performance on the list view query.** A `SELECT * FROM agent_runs WHERE agent_name='ella' ORDER BY created_at DESC LIMIT 50` is fine. But joining to `slack_messages` for the surrounding-context preview on the list could be expensive if it fires per-row. Lean: don't preview surrounding context on list rows. Surrounding context is only in the detail view.
- **The anomaly checks need data the schema may not have.** Specifically check A requires Ella's response text — `agent_runs.output_summary` truncates at 200 chars. Builder's audit script falls back to `slack_messages` for the full text. The dashboard should do the same — join `slack_messages` for response text when needed. Confirm the query stays fast.
- **The dashboard might show runs with messy/missing data** from pre-Batch-1.5 (no real_author_id, wrong trigger_metadata.user, etc.). Render gracefully — "unknown" for unresolved fields, don't crash.
- **Date range UX.** Default to last 7 days. If user picks a too-large range (3 months × 200 runs/day = 18000 rows), pagination handles it but the summary band's aggregation might be slow. Add a soft cap — e.g., date range >90 days requires explicit confirmation.
- **The Haiku decision column will be empty for every run pre-2.3.** That's expected. Render as "N/A" or just empty. Don't conditionally hide the column — that creates visual instability when 2.3 ships.
- **Real-time freshness.** The page doesn't need to be live-updating (no WebSocket). A page refresh shows latest. Reasonable for an audit tool. Server-side caching on the summary band (60s) is fine; per-row queries should not cache.

## Commit + report

Per CLAUDE.md § Commits: one logical commit per coherent change. Suggested commit shape:

1. `feat(ella-audit): scaffold /ella/runs route + list view`
2. `feat(ella-audit): add filters + URL state serialization`
3. `feat(ella-audit): add summary band + daily aggregates`
4. `feat(ella-audit): add /ella/runs/[id] detail view`
5. `feat(ella-audit): add anomaly view + flag rendering`
6. `docs: update gregory.md + CLAUDE.md for Batch 2.2 audit dashboard`
7. Final report commit.

If commits split further sensibly (e.g., the detail view has multiple sections that ship separately), let them split. The principle is one logical change per commit.

Report at `docs/reports/ella-v2-batch-2-2-audit-dashboard.md` per the spec/report convention.

After report lands, Drake verifies the page works in production — clicks through to `/ella/runs`, confirms the V1 + Batch 1.5 runs all surface correctly with anomaly flags, navigates to a few detail views, confirms filters work. Drake's gate (c) — post-deploy testing on real surface.
