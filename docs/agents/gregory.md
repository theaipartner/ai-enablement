# Gregory — CSM Co-Pilot

## What Gregory is

A web dashboard hosted on Vercel that gives CSMs (and admins) clear, low-friction visibility into their book of business. Each client gets a profile with status, recent activity, action items, and a Gregory-computed health score with concerns.

Gregory has two halves:

1. **The dashboard surface** (V1) — Next.js app at `/dashboard` that reads from and writes to Supabase. Two pages: Clients and Calls.
2. **The brain** (V1.1, deferred) — Python agent that reads call summaries, action items, NPS, and Slack signals to compute health scores + concerns, writes to `client_health_scores`.

V1 ships the surface with real data where it exists today (call cadence, action items) and clear empty states for what Gregory's brain will fill in later (health score, concerns, NPS once ingested).

## Why a dashboard, not a Slack agent

Gregory's job is *visibility into a portfolio of clients*. Slack is a conversational surface — good for ad-hoc questions ("what's the latest with Javi?"), bad for scanning 30 clients to spot the one that needs attention this week. The CSM workflow Gregory supports is "open the dashboard, scan the list, click into the worrying ones" — that's a UI workflow, not a chat workflow.

Ella (client-facing) lives in Slack because clients live in Slack. Gregory (CSM-facing) lives on the web because CSMs need a portfolio view.

## Surface

### Auth

Supabase Auth with email/password. Team members manually invited via Supabase Studio for V1 (CSM rollout in V2 once permissions are scoped). No magic-link or SSO in V1.

`auth.users.id` joins to `team_members` via email match. RLS off for V1 (app-level auth gate is sufficient for the small internal user base); RLS on for V2 when CSMs get access and we need per-CSM scoping.

### Navigation

Top nav only. Two items: **Clients** | **Calls**. User avatar + logout on the right. No sidebar (premature for 2 pages).

### Routes

- `/login` — auth landing
- `/clients` — list view, default landing after login
- `/clients/[id]` — detail view
- `/calls` — list view
- `/calls/[id]` — detail view
- `/settings` — placeholder for V1 (auth profile)

## Brain V2

The "brain" is the agent that computes per-client health scores and writes them to `client_health_scores`. Lives at `agents/gregory/`. Modules: `agent.py` (entry), `signals.py` (deterministic signal computations), `ai_call_signal.py` (Sonnet-driven call review signal — the dominant V2 contributor), `scoring.py` (rubric → score + tier), `prompts.py` (`AI_CALL_SIGNAL_SYSTEM_PROMPT`). Each invocation opens an `agent_runs` row, runs, writes one `client_health_scores` row per client, closes the run with telemetry. The AI call signal opens its own child `agent_runs` row inside the per-client compute so token + cost accounting is attributable per-signal.

V1.1 had a separate `concerns.py` module gated behind `GREGORY_CONCERNS_ENABLED` that ran Claude over recent call summaries to extract qualitative watchpoints. **Retired in V2** — `call_review` documents already contain the LLM-distilled view of pain_points + wins + dodged_questions + sentiment_arc that concerns.py was extracting from raw summaries. The AI call signal subsumes that work and surfaces concerns alongside the contribution score, eliminating a second Claude call per client and a second source-of-truth for the concerns array. The `GREGORY_CONCERNS_ENABLED` env var is no longer consulted; if set in Vercel it's a no-op.

### Signals (V2)

One AI signal + three deterministic signals. Each emits a `Signal` dict written verbatim into `factors.signals[]`. Order in the array is stable: AI signal first (highest weight, dashboard headline), then the three deterministic signals.

| Signal | Source | Bands / scale | Weight | Missing-data behavior |
|---|---|---|---|---|
| `ai_call_signal` | last 30 days of `call_review` documents for the client, sent to Sonnet for a 0-100 contribution + reasoning + 0-3 concerns | LLM-judged 0-100 | **0.50** | "no recent reviews" → neutral 50, note explains; DB blip / LLM blip / parse failure each fall through to neutral 50 with mode-specific note text |
| `call_cadence` | days since most recent `calls.started_at` where `primary_client_id = client` | <14d → 100; 14-30d → 50; >30d → 0 | 0.20 | "no calls" → neutral 50, note explains |
| `overdue_action_items` | count of `call_action_items` where `owner_client_id=client AND status='open' AND due_date < today` | 100 baseline, −15 per item, floor 0 | 0.10 | 0 items → 100 |
| `latest_nps` | most recent `nps_submissions.score` for the client | raw 0-10 scaled to 0-100 | 0.20 | "no NPS" → neutral 50 |

Weights sum to 1.0. Heavy-but-balanced — the AI call signal dominates at half the weight; the deterministic floor handles cadence + NPS while overdue trims to 0.10 since the open-but-not-yet-due count was double-counting and is retired in V2. **Slack engagement** is still absent (the `slack_messages` cloud table is empty per `docs/future-ideas.md`); land it as a fifth signal once cloud Slack ingestion ships and re-balance.

### Auto-review on Fathom webhook ingest (2026-05-07)

The AI signal's input — `call_review` documents — refills automatically as new calls land. `ingestion/fathom/pipeline.py:_ensure_call_review_document` fires after each successful `_ensure_summary_document` for client-category calls with a non-null `primary_client_id`. Same try/except fail-soft pattern as the M6.1 CS Slack post hook — review-generation failure never breaks the Fathom delivery; failures land on `IngestOutcome.errors[]` for diagnostic visibility. Three-layer idempotency (existence guard inside the helper + persistence-layer upsert + pipeline-layer non-atomic-but-idempotent invariant) means Fathom retries cost zero LLM tokens.

`review_call` distinguishes pipeline-fired runs via `trigger_type='fathom_pipeline'` (vs `'manual_backfill'` for the one-shot script). Cost rollups can split the two via `agent_runs.trigger_type`.

The first auto-review per call costs ~$0.07 in Sonnet tokens at typical transcript size; 13s wall-clock added to the ~10-15s pipeline overhead leaves comfortable headroom against the 60s Fathom webhook ceiling. If real-world latencies tighten, re-architect to async via a queue.

### AI call signal failure semantics

The AI call signal is on the critical weekly-cron path; an LLM blip or DB blip on this signal must not take down the entire sweep. `compute_ai_call_signal` NEVER raises — three failure surfaces (documents fetch, Claude call, response parse) each fall through to a neutral-50 Signal + empty concerns. Each failure surface has its own try/except so the resulting note text identifies which surface tripped, which makes operational diagnosis cheap from `agent_runs` telemetry. The agent_runs row for the AI signal is opened only when there are reviews to send (no row written when input is empty), and is closed with `status=error` whenever the LLM or parse path fails.

Concerns shape match. The AI signal returns concerns matching the existing dashboard renderer's contract — `{text, severity (low|medium|high), source_call_ids[]}`. `source_call_ids` are defensively filtered against the input-call-ids set at parse time, so a hallucinated UUID can't land in `factors.concerns[]`.

### Scoring rubric

```
final_score = sum(signal.weight * signal.contribution) / sum(weights)
            clamped to 0-100, rounded to int.

tier:  >=70 → green
       40-69 → yellow
       <40  → red
```

**Insufficient-data default.** When every signal returned the neutral contribution (i.e. nothing is known about the client), the brain ships `score=50, tier=yellow, factors.overall_reasoning='Insufficient signal data; defaulting to yellow.'`. Never green by accident on no data.

**Never-called-clients-land-yellow (V2 fix).** V1.1 produced score=70 (green) for never-called clients because `overdue_action_items` returned 100 (clean docket) at 0.20 weight while everything else neutralled at 50. V2's rebalance + AI signal fully resolve this: a never-called client now scores `0.50×50 + 0.20×50 + 0.10×100 + 0.20×50 = 55 → yellow`. The AI signal's 0.50 weight on a neutral 50 default structurally pulls no-data clients out of the green band. Pinned by `test_never_called_client_lands_yellow_not_green` in `tests/agents/gregory/test_scoring.py`.

Thresholds and band cutoffs are V2 starting points. The math is fully transparent in `factors.signals[]` — a reviewer reading the dashboard's "Why this score" expand can recompute the score by hand. Iterate as miscalibration surfaces.

### Sweep telemetry

`SweepResult` carries `duration_ms` + `avg_per_client_ms` populated at sweep completion. The sweep also emits an INFO log line with these values so cron logs surface the trend without requiring `agent_runs` queries. Feeds the cron-ceiling watchpoint logged in `docs/followups.md` — re-architect (parallelize the per-client loop OR move the AI signal to a separate weekly job) if duration exceeds 8 minutes (80% of the 600s ceiling).

### Cron schedule

Weekly, Mondays 09:00 UTC, via `vercel.json` cron declaration → `api/gregory_brain_cron.py` → `compute_health_for_all_active()`. **`maxDuration=600`** (V2 bump from V1.1's 300) to absorb the AI signal's per-client Claude calls; ~25 clients-with-reviews × ~5sec each = ~2 min of LLM time on top of the existing deterministic-only sweep, with 2x headroom.

Reasoning for weekly (not daily): signal change rate is slow (call cadence moves day-to-day for ~5 clients; action-item churn is gradual; call_review documents land per-call so day-to-day variance is bounded by call frequency), and at scale the LLM cost compounds. Re-eval cadence once dashboard usage tells us something. Manual sweeps via `scripts/run_gregory_brain.py --all` between cron runs are fine.

The cron lands an hour after the daily Fathom backfill (08:00 UTC) so any calls / action items ingested overnight are visible to the brain.

### Public entry points

- `compute_health_for_client(client_id)` — single client. Used by `scripts/run_gregory_brain.py` and tests.
- `compute_health_for_all_active()` — sweep every active client. Per-client failures isolated; one bad client doesn't halt the sweep. Each per-client run gets its own `agent_runs` row (clean per-client cost / duration accounting).

### Operational notes

- **No locking.** Concurrent runs (cron + manual overlap) write duplicate rows per client. Dashboard reads "latest per client", so dups are noise not corruption.
- **History preserved by design.** `client_health_scores` is append-only; every run produces one row per client. Reviewing trend over time is just `select score, tier, computed_at from client_health_scores where client_id=? order by computed_at desc`.
- **Traceability.** `client_health_scores.computed_by_run_id` FK → `agent_runs.id`. Every score row points back to the run that produced it; cost / duration / errors live there.

## Pages

### Clients page — list view

Sortable table, one row per client. Default sort: by health score ascending (worst first) once Gregory exists; by `last_call_date` descending for V1.

Columns:

| Column | Source | Notes |
|--------|--------|-------|
| Full name | `clients.full_name` | Click → detail view |
| Status | `clients.status` | Color pill (active / paused / ghost / leave / churned). List page default-hides `churned` + `leave`; "Show churned & leave" toggle chip reveals them. Explicit status filter (e.g. `?status=churned`) wins over the default-hide. |
| Journey stage | `clients.journey_stage` | onboarding / active / churning / churned / alumni |
| Primary CSM | `client_team_assignments` where role='primary_csm' | Latest active assignment |
| Health score | `client_health_scores` (latest) | Numeric + tier pill; empty for V1 |
| Last call | `max(calls.started_at)` where `primary_client_id = client.id` | Days-ago format with color coding |
| Open action items | count of `call_action_items` where `owner_client_id = client.id` and `status='open'` | "3 open (1 overdue)" if any past due_date |
| Tags | `clients.tags` | Chip display |

Search: filter on name + email. Filter chips: status, journey stage, primary CSM, "has open action items".

### Clients page — detail view

Vertical layout, 7 collapsible sections (default expanded) via native `<details>`/`<summary>`. The structure changed in M4 Chunk B (post-migration 0017) — what was a 6-implicit-section layout reorganized into 7 explicit sections that surface the new schema (14 columns + nps_submissions.recorded_by + 4 new tables). M4 Chunk B2 wires inline-save on every editable field: click swaps the read-only display into an input/select/textarea, blur or Enter saves, Escape cancels. Status / journey_stage / csm_standing route through history-writing RPCs (migration 0018) so every edit leaves an audit row in the corresponding `*_history` table. metadata.profile.* fields go through a read-modify-write on `clients.metadata`. The needs_review tag triggers a Merge button at the top of the page (orthogonal to the sections, preserved from M3.2).

**Section 1 — Identity & Contact:** Identity- and contact-level fields, mostly editable in B2. `clients.full_name`, primary `clients.email`, alternate emails (from `clients.metadata.alternate_emails`), phone, country (new), time zone, birth year (new — rendered as "Born YYYY"), location/city (new), occupation (new), status, primary CSM (active assignment from `client_team_assignments`), and tags. Three sub-fields are truly read-only (no edit affordance): Slack channel id (joined from `slack_channels` filtered to active, most recent by `created_at`), Slack user id (`clients.slack_user_id`), signup date (`clients.start_date`).

**Section 2 — Lifecycle & Standing:** CSM-judgment fields plus system-derived signals. Editable-in-B2: journey_stage (with note "Stage taxonomy in design — free-text for now"), csm_standing (enum: happy/content/at_risk/problem — new), latest NPS score (read from most recent `nps_submissions.score`), archetype (new — free-text V1, enum once Drake/Nabeel finalize). System-derived: Health score from latest `client_health_scores` row (preserved indicator with tier pill, "why this score" expand of the factors jsonb), and Concerns as a collapsible sub-section under Health score that distinguishes three empty states: "Gregory has not yet evaluated this client" when no health row exists, "No concerns currently surfaced" when a health row exists but `factors.concerns[]` is empty, and the existing list rendering (text + severity pill + linked source calls) when concerns are present.

**Section 3 — Financials:** Editable in B2: contracted_revenue (numeric, dollars), upfront_cash_collected, arrears (note: column has `not null default 0`, so existing clients render `$0.00` — distinguishing "0 because we set it" from "0 because we never imported a value" is not a V1 concern), arrears_note.

**Section 4 — Activity & Action Items:** System-derived activity counts (total calls, total Slack messages, total NPS submissions) rendered as stat blocks alongside two pipeline-pending placeholders (total accountability submissions, course content consumption). Recent calls list shows top 5 with a "Show all calls" expansion that reveals the rest from the same query (no extra round trip). Action items sub-section shows ALL action items grouped by status (open → done → cancelled), collapsing the tail behind a "Show N older action items" toggle when total > 10. Replaces what M2.3b shipped as the open-only Section 6.

**Section 5 — Profile & Background:** All five fields live in `clients.metadata.profile` (jsonb sub-object), NOT as columns on `clients` — the schema spec deliberately keeps these in jsonb until query patterns justify promotion. Editable in B2: niche, offer, traffic_strategy, and SWOT split into 4 sub-fields (strengths, weaknesses, opportunities, threats). Empty by default.

**Section 6 — Adoption & Programs:** Editable in B2: trustpilot_status (enum: yes/no/ask/asked — vocab matches Scott's master sheet, renamed in 0020 from not_asked/pending/given/declined), ghl_adoption (enum: never_adopted/affiliate/saas/inactive — new), sales_group_candidate (boolean three-state: yes/no/not assessed — new), dfy_setting (boolean three-state — new). Plus an Upsells sub-section listing rows from the new `client_upsells` table (sorted sold_at desc nulls last) — amount, product, sold_at, notes per row.

**Section 7 — Notes:** Editable in B2: single text area rendering `clients.notes` (column added in 0012). Empty state shows "No notes yet — click to add" with a dashed-border affordance. Markdown rendering deferred to V1.1 polish.

### Calls page — list view

Sortable table, one row per call. Default sort: `started_at` descending. Secondary "Needs review" toggle re-sorts by `classification_confidence` ascending.

Columns:

| Column | Source | Notes |
|--------|--------|-------|
| Date | `calls.started_at` | |
| Title | `calls.title` | Click → detail view |
| Category | `calls.call_category` | Color pill (client/internal/external/unclassified/excluded) |
| Primary client | join via `primary_client_id` | "—" if null |
| Participants | `call_participants` | "Alice + 3 others" format |
| Duration | `calls.duration_seconds` | mm:ss formatted |
| Confidence | `calls.classification_confidence` | 0-1, color-coded; surfaces low-confidence |
| Retrievable | `calls.is_retrievable_by_client_agents` | Icon |

Search: participant name/email + call title.

Filter chips: by category, by client, **by "Needs review"** (low confidence OR unclassified OR primary_client_id is null when category=client). The "Needs review" filter is the Aman-classification and F1.5-bug review queue.

### Calls page — detail view

**Edit mode + explicit Save/Cancel** for this page. Higher-stakes edits (category and primary_client_id directly affect Ella retrieval).

**Section 1 — Metadata (read-only):** title, started_at, duration, source, external_id, ingested_at, recording_url (link).

**Section 2 — Classification (editable):** category (dropdown), call_type (dropdown), primary_client (searchable dropdown of clients, required when category=client), confidence (read-only, original auto value), method (read-only, auto-set to 'manual' on save), is_retrievable_by_client_agents (read-only, auto-derived from category + primary_client_id presence).

On save, an entry is written to `call_classification_history` (migration 0013) capturing what changed, who changed it, when.

**Section 3 — Participants (read-only):** Table of name/email/role/matched_client/matched_team_member. Unmatched participants flagged visually.

**Section 4 — Summary (read-only):** `calls.summary` if present, otherwise empty state: "No summary — Fathom .txt exports don't carry summaries. Cron-ingested calls have summaries."

**Section 5 — Action items (read-only for V1):** List from `call_action_items` for this call.

**Section 6 — Transcript (collapsed by default):** Toggle to expand, read-only scrollable.

## Schema changes

Two new migrations. Both lightweight, neither destructive.

### `0012_clients_notes.sql`

Adds a single nullable `notes` text column to `clients`. Edited inline by team members on the client detail page.

### `0013_call_classification_history.sql`

New append-only audit table for manual edits to `call_category`, `call_type`, and `primary_client_id` from the Calls detail page. Constrained `field_name` enum to those three fields. Application-side writes (not trigger-based) so the audit logic stays visible in dashboard code rather than hidden in a trigger.

## Airtable NPS integration (V1 — M5.4)

Airtable is the source of truth for NPS Survey segments. Gregory mirrors each client's segment classification into `clients.nps_standing` and conditionally auto-derives `clients.csm_standing` from it.

**Architecture — three layers, one direction:**

1. **Airtable Survey** (external) — captures NPS scores + classifies clients into segments. Fires a webhook into the Vercel receiver on segment change. Source of truth for the segment classification.
2. **Receiver** (`api/airtable_nps.py`, next chunk) — small Vercel serverless function. Validates the webhook payload, normalizes Airtable's raw segment strings to lowercase (`"Strong / Promoter"` → `promoter`, `"Neutral"` → `neutral`, `"At Risk"` → `at_risk`), then calls the combined RPC. No business logic at this layer; it's a thin adapter.
3. **`update_client_from_nps_segment` RPC** (migration 0021) — does the work in one transaction. Always writes `clients.nps_standing`. Conditionally auto-derives `clients.csm_standing` per override-sticky semantics.

**Override-sticky semantics (Scott-confirmed behavior B — manual CSM judgment wins):**

The auto-derive only writes `csm_standing` when EITHER:
- `clients.csm_standing IS NULL` (no prior value), OR
- the most recent `client_standing_history` row for the client has `changed_by = Gregory Bot UUID` (`cfcea32a-062d-4269-ae0f-959adac8f597`).

If neither holds — i.e., a CSM has manually set `csm_standing` via the dashboard — the RPC skips the auto-derive and only writes `nps_standing`. The manual judgment is sticky until a CSM clears it (back to null) or until Gregory Bot is the most recent author again. The `Gregory Bot` `team_members` row (added in 0021, role `system_bot`) exists solely to make this manual-vs-auto distinction queryable from the existing `client_standing_history.changed_by` column — no separate `is_automated` flag needed.

**Segment → csm_standing mapping** (encoded only inside the RPC; receiver passes the segment, DB does the work):

| `nps_standing` | derived `csm_standing` |
|---|---|
| `promoter` | `happy` |
| `neutral` | `content` |
| `at_risk` | `at_risk` |

`'problem'` `csm_standing` has no auto-derive path — only manual CSM judgment. The function never writes `csm_standing = 'problem'`.

**Why the auto-derive delegates rather than writing directly:** the RPC `PERFORM update_client_csm_standing_with_history(...)` rather than UPDATE'ing `clients.csm_standing` directly. Reusing the 0018 RPC keeps the audit logic + idempotency (no-op when value unchanged → no history row written) in one place. The Gregory Bot UUID is passed as `p_changed_by` and `'auto-derived from NPS segment <segment>'` as `p_note` so the history row carries enough context to reconstruct what happened.

### Receiver implementation (M5.4)

Endpoint: `POST https://ai-enablement-sigma.vercel.app/api/airtable_nps_webhook`. Source code: `api/airtable_nps_webhook.py`. Friendly `GET` returns 200 with `{"status": "ok", "endpoint": "airtable_nps_webhook", "accepts": "POST"}` for browser/uptime probes.

**Auth.** `X-Webhook-Secret` HTTP header. Server compares against `AIRTABLE_NPS_WEBHOOK_SECRET` env var via `hmac.compare_digest` (constant-time). Missing or mismatched → 401 with `{"error": "unauthorized"}`, no DB write. Missing env var (deployment misconfiguration) → 500 with `{"error": "misconfigured"}`. Note: this is shared-secret auth, NOT HMAC signature like Fathom — Make.com supports custom headers cleanly, signature-based auth would require Make-side computation.

**Payload shape (Make.com → receiver):**

```json
{
  "client_email": "ada@example.com",
  "segment": "Strong / Promoter",
  "airtable_record_id": "recXyz123",
  "submitted_at": "2026-05-01T15:30:00Z"
}
```

`client_email` and `segment` are required. `airtable_record_id` is optional but persisted on `webhook_deliveries.call_external_id` for forensics + queryability via the existing `(source, call_external_id)` partial index. `submitted_at` is captured in the `payload` jsonb but not used in the V1 logic.

**Segment normalization at the receiver boundary** (case-insensitive, whitespace-stripped):

| Airtable raw | Normalized |
|---|---|
| `Strong / Promoter` | `promoter` |
| `Neutral` | `neutral` |
| `At Risk` | `at_risk` |

Unrecognized → 400 with `{"error": "invalid_segment", "accepted": ["Strong / Promoter", "Neutral", "At Risk"]}`. The accepted list shows canonical Airtable forms (not the lowercased internal lookup keys) so Make.com configurators see the strings to send.

**Response shapes:**

| Status | Body | When |
|---|---|---|
| 200 | `{"status": "ok", "delivery_id": "airtable_nps_<uuid>", "client_id": "<uuid>", "nps_standing": "<seg>", "csm_standing": "<value\|null>", "auto_derive_applied": true\|false}` | RPC succeeded |
| 400 | `{"error": "invalid_json"}` | body not parseable JSON |
| 400 | `{"error": "missing_field", "detail": "<which>"}` | required field missing or empty |
| 400 | `{"error": "wrong_type", "detail": "<which> must be a string..."}` | type mismatch |
| 400 | `{"error": "invalid_segment", "detail": "...", "accepted": [...]}` | segment value not in the three known forms |
| 401 | `{"error": "unauthorized"}` | missing or wrong `X-Webhook-Secret` |
| 404 | `{"error": "client_not_found", "email": "<input>"}` | RPC raised "no active client matches email" — primary `clients.email` and `metadata.alternate_emails` both missed |
| 500 | `{"error": "misconfigured"}` | `AIRTABLE_NPS_WEBHOOK_SECRET` env var unset |
| 500 | `{"error": "rpc_failed"}` | any other RPC exception |
| 500 | `{"error": "internal_error"}` | unhandled exception in handler |

`auto_derive_applied` is a best-effort inference: post-RPC `csm_standing` matches what the segment-mapping would produce. Intentionally NOT a precise "we just wrote it" signal — the RPC's idempotency + the override-sticky branch means the value can match without a write happening this call. The boolean answers "value matches the mapping," not "the auto-derive ran." Source of truth for actual writes is `client_standing_history.changed_by` — a Gregory Bot UUID on the most recent row means the auto-derive ran.

**Audit trail.** Every request that passes auth lands a `webhook_deliveries` row with `source='airtable_nps_webhook'`. Status transitions: `received` (initial insert) → `processed` (RPC success) | `failed` (404/500) | `malformed` (400). Auth failures (401) write NO row — same gate-before-DB pattern as the Fathom webhook handler. The `webhook_id` PK is `airtable_nps_<uuid4>` per request (no native idempotency token from Airtable; UUID-per-request gives every delivery a unique row, which matches the V1 "no idempotency layer" decision).

**Local test harness:** `scripts/test_airtable_nps_webhook_locally.py` spins up the real `handler` class via `http.server.HTTPServer` in a background thread (same pattern Vercel uses), fires 8 paths (2 happy + 6 negative), verifies HTTP responses + cloud DB state via direct psycopg2, cleans up the test client (Branden Bledsoe — selected as a low-profile active client with null csm_standing and no history rows pre-test) in try/finally. Run via `.venv/bin/python scripts/test_airtable_nps_webhook_locally.py`. Sets a test secret if `AIRTABLE_NPS_WEBHOOK_SECRET` is unset.

**Historical backfill (one-shot):** `scripts/backfill_nps_from_airtable.py` walks the Airtable NPS Survery table, dedupes to the latest Survey Date per linked NPS Clients record, and POSTs each surviving row through the production receiver — same code path as Airtable's automation, same audit trail. Default mode is dry-run; `--apply` fires real requests. First run: 2026-05-03 (M5.4 follow-up after the receiver went live). Runbook at `docs/runbooks/backfill_nps_from_airtable.md` covers modes, report buckets, and the 404 triage flow (the `sent_404_client_not_found` bucket surfaces email mismatches between Airtable and Gregory — useful signal for `clients.metadata.alternate_emails` cleanup). Idempotent — re-runs land identical end states modulo extra `webhook_deliveries` audit rows.

**Dashboard rendering:** `clients.nps_standing` renders in **Section 2 — Lifecycle & Standing** of the client detail page (`components/client-detail/lifecycle-section.tsx`) via the `NpsStandingPill` component (`components/client-detail/nps-standing-pill.tsx`). Replaced the prior `Latest NPS` field that read `nps_submissions.score`; that field is empty for nearly every client because score-piping is deferred to V1.5. The `NpsEntryForm` for manual NPS-score entry stays below the pill (different data source — writes `nps_submissions`, not `nps_standing`). Pill colors are deliberately distinct from status / health-tier palettes to avoid visual collision: `promoter` indigo, `neutral` slate, `at_risk` orange. Null renders as em-dash placeholder (138 of 197 active clients post-backfill have no Airtable submission yet).

## Airtable onboarding integration (V1 — M5.9)

Path 3 inbound. Zain's Make.com automation fires this once per new client when his existing onboarding flow (Slack channel created → client invited → onboarding form submitted in Airtable) completes. The receiver is the second inbound webhook on the Airtable side (after Path 1 NPS) and the dashboard's primary client-row birth path going forward.

**Architecture — three layers, one direction:**

1. **Airtable onboarding form + Make.com automation** (external) — Zain's existing flow captures full_name / email / country / date_joined plus optional phone / slack_user_id / slack_channel_id at form submission. Make.com fires a webhook into the Vercel receiver. Source of truth for the form payload.
2. **Receiver** (`api/airtable_onboarding_webhook.py`) — small Vercel serverless function. Validates auth + payload (4 required + 3 optional fields), parses `date_joined` (ISO date or ISO timestamp), then calls the combined RPC. No business logic at this layer; thin adapter.
3. **`create_or_update_client_from_onboarding` RPC** (migration 0025) — does match-or-create + `*_with_history` audit writes + `slack_channels` insert + `needs_review` tag-append in one transaction.

**Three branches (mirroring Fathom's `_lookup_or_create_auto_client`):**

The RPC's match-or-create logic looks up by primary `clients.email` AND `clients.metadata.alternate_emails` (case-insensitive, whitespace-stripped — same pattern as `update_client_from_nps_segment`). The lookup hits one of three branches:

| Branch | Match | Action | Response `action` |
|---|---|---|---|
| 1 | active row (`archived_at IS NULL`) | UPDATE in place | `updated` |
| 2 | archived row (`archived_at IS NOT NULL`) | clear `archived_at`, then UPDATE | `reactivated` |
| 3 | no row | INSERT new client | `created` |

Branch 2 (reactivate) handles the legitimate case where a client churns, then re-signs months later. Mirrors `ingestion/fathom/pipeline.py:_lookup_or_create_auto_client`'s archived-row reactivation. Per migration 0007 the partial unique indexes on `clients.email` / `clients.slack_user_id` are scoped `WHERE archived_at IS NULL`, so reactivating doesn't collide.

**Field semantics on update / reactivate (existing-non-null wins):**

- `status` → `'active'` via `update_client_status_with_history` (Gregory Bot UUID, note `'onboarding form submission'`). Idempotent if already active.
- `csm_standing` → `'content'` via `update_client_csm_standing_with_history` (same attribution + note). Idempotent if already content.
- `tags` → append `'needs_review'` via DISTINCT-on-unnest. Idempotent (no duplicate tag).
- `phone` / `country` / `start_date` / `slack_user_id` → backfill ONLY when current value is NULL. **Existing non-null values are NOT overwritten.** The form submission is one snapshot among potentially many; trust pre-existing data.
- `email` (primary column) → never touched. When alternate-email match wins, the canonical email stays canonical; the form's email lives in `metadata.alternate_emails` already.

**Field semantics on create:**

- `clients` row INSERT with `full_name`, `email` (lowercased), `phone`, `country`, `start_date`, `slack_user_id`, `status='active'`, `tags=['needs_review']`, and metadata `{auto_created_from_onboarding_webhook: true, auto_created_from_delivery_id: <delivery>, auto_created_at: now()}`.
- Status seeded via DIRECT INSERT into `client_status_history` (note `'onboarding form initial seed'`). The `*_with_history` RPC's idempotent-when-unchanged path skips writing for create-time `'active'` because the column is `NOT NULL DEFAULT 'active'` so current==new at row birth. Direct insert matches migration 0017's seed pattern.
- `csm_standing` seeded via the RPC (column is nullable; `null → 'content'` is a real transition that writes a history row naturally).

**Slack ID anti-overwrite (409 conflict):**

The RPC raises three structured exceptions the receiver translates to HTTP 409. Conflict paths leave **zero state changes** — the RPC raises BEFORE any writes, and PostgreSQL rolls back the entire transaction.

| Exception substring | Meaning | Response error code |
|---|---|---|
| `slack_user_id_conflict: existing=X new=Y` | Existing client has slack_user_id set, payload sends a different one | `slack_user_id_conflict` |
| `slack_channel_id_conflict_for_client: existing=X new=Y` | Existing client has an active slack_channels row pointing at a different channel id | `slack_channel_id_conflict_for_client` |
| `slack_channel_id_owned_by_different_client: client_id=X` | The payload's slack_channel_id exists in slack_channels but is already linked to a DIFFERENT client | `slack_channel_id_owned_by_different_client` |

Per spec: never silently overwrite an established Slack identity. The 409 surfaces the conflict; CSMs (or Drake) reconcile manually before re-submitting.

**slack_channels resolution (six branches inside the RPC):**

`slack_channels.slack_channel_id` is full-table UNIQUE (not partial — different from `clients.email`'s active-only UNIQUE). The RPC handles the surfaces:

| # | Pre-state | Action |
|---|---|---|
| A | row exists for this client + active + same channel id | no-op |
| B | row exists for this client + active + different channel id | RAISE `slack_channel_id_conflict_for_client` |
| C | no row anywhere with this channel id | INSERT (with `name` = client `full_name` + `is_private=false` + `metadata.created_via='onboarding_webhook'`) |
| D | row exists with `client_id IS NULL` | UPDATE `client_id`, clear `is_archived` (reattach pattern from `cleanup_master_sheet_completeness.py`) |
| E | row exists for this client + archived | UPDATE `is_archived=false` (unarchive) |
| F | row exists for a different client | RAISE `slack_channel_id_owned_by_different_client` |

### Receiver implementation (M5.9)

Endpoint: `POST https://ai-enablement-sigma.vercel.app/api/airtable_onboarding_webhook`. Source: `api/airtable_onboarding_webhook.py`. Friendly `GET` returns 200 with `{"status": "ok", "endpoint": "airtable_onboarding_webhook", "accepts": "POST"}`.

**Auth.** `X-Webhook-Secret` HTTP header against `AIRTABLE_ONBOARDING_WEBHOOK_SECRET` env var via `hmac.compare_digest`. Missing/wrong → 401 `{"error": "unauthorized"}`, no DB write. Missing env var → 500 `{"error": "misconfigured"}`. Same shared-secret model as the NPS receiver.

**Payload shape (Make.com → receiver):**

```json
{
  "full_name":        "Jane Doe",
  "email":            "jane@example.com",
  "country":          "USA",
  "date_joined":      "2026-05-05",
  "phone":            "+1 555-123-4567",
  "slack_user_id":    "U01ABC123",
  "slack_channel_id": "C01ABC456"
}
```

**4 required + 3 optional** (since migration 0026, M6.x). Required: `full_name`, `email`, `country`, `date_joined` — non-null, string-typed, non-empty after strip. Optional: `phone`, `slack_user_id`, `slack_channel_id` — may be omitted from the payload OR sent as `null`; if PRESENT, must be a non-empty string after strip (sending `""` is rejected as `wrong_type`). The receiver passes `null` to the RPC for any optional field that's absent / null, which the RPC's null-guards on the slack_* anti-overwrite checks + the wrapped six-branch slack_channels resolution treat as a no-op for that field.

The optional fields support a re-fire flow: Zain submits the form for a new client BEFORE the Slack channel is provisioned (no slack IDs in hand) → client lands in Gregory immediately → Zain re-submits the same form later with the IDs filled in → client updates in place via the email match (NULL-only backfill on `slack_user_id`, fresh `slack_channels` INSERT via Branch C). No duplicate clients; no manual reconciliation. See `docs/runbooks/airtable_onboarding_webhook.md` § "Re-fire to add slack IDs" for the full operator-facing description.

`date_joined` accepts ISO date (`"2026-05-05"`) or ISO datetime (`"2026-05-05T14:30:00Z"`). Country isn't CHECK-constrained at this layer — Zain owns the contract on his side; today's expected values are `'USA'` / `'AUS'` but other strings pass through as-is.

**Response shapes:**

| Status | Body | When |
|---|---|---|
| 200 | `{"status": "ok", "delivery_id": "airtable_onboarding_<uuid>", "client_id": "<uuid>", "action": "created\|updated\|reactivated"}` | RPC succeeded |
| 400 | `{"error": "invalid_json"}` | body not parseable JSON |
| 400 | `{"error": "payload_not_object"}` | body parsed but isn't a JSON object |
| 400 | `{"error": "missing_field", "detail": "<field> is required"}` | required field missing or empty |
| 400 | `{"error": "wrong_type", "detail": "<field> must be a string..."}` | type mismatch on any field |
| 400 | `{"error": "wrong_type", "detail": "date_joined: ..."}` | `date_joined` unparseable |
| 401 | `{"error": "unauthorized"}` | missing or wrong `X-Webhook-Secret` |
| 409 | `{"error": "slack_user_id_conflict\|slack_channel_id_conflict_for_client\|slack_channel_id_owned_by_different_client", "detail": "..."}` | Slack ID anti-overwrite conflict |
| 500 | `{"error": "misconfigured"}` | env var unset |
| 500 | `{"error": "rpc_failed"}` | RPC raised non-conflict exception |
| 500 | `{"error": "rpc_returned_no_data"}` | RPC returned empty result (shouldn't happen) |
| 500 | `{"error": "internal_error"}` | unhandled exception in handler |

**Audit trail.** Every authed request lands a `webhook_deliveries` row with `source='airtable_onboarding_webhook'`. Status transitions: `received` → `processed` (200) | `failed` (409/500) | `malformed` (400 validation). 401s write NO row — gate-before-DB. The `webhook_id` PK is `airtable_onboarding_<uuid4>` per request. The delivery_id is also embedded into the new client's `metadata.auto_created_from_delivery_id` so a CSM looking at a fresh `needs_review` row can grep the payload + headers in `webhook_deliveries`.

**Conflict-pattern matching order.** The receiver checks substring matches in this order (the `_owned_by_different_client` form must come BEFORE `_conflict_for_client` to avoid the longer string being misclassified by a shorter prefix match):

1. `slack_channel_id_owned_by_different_client`
2. `slack_channel_id_conflict_for_client`
3. `slack_user_id_conflict`

**Local test harness:** `scripts/test_airtable_onboarding_webhook_locally.py` spins up the real `handler` class via `http.server.HTTPServer` in a background thread; runs 11 paths (74 sub-checks) — happy create / update / reactivate / idempotent / 7 missing-field permutations / wrong-type / unparseable date / invalid JSON / wrong secret + no-delivery-row check / both Slack ID conflict cases. Self-seeds an `onboarding-test-update-<token>@nowhere.invalid` fixture for the update/idempotent/conflict tests rather than relying on a stable production client (the NPS harness's Branden Bledsoe pattern broke when Branden was archived 2026-05-05). Hard-deletes the synthetic fixture in cleanup; soft-archives the per-run created clients. Sets a test secret if `AIRTABLE_ONBOARDING_WEBHOOK_SECRET` is unset.

**Dashboard rendering.** Created clients land with `tags=['needs_review']`, surfacing immediately on `/clients` with the existing Needs Review filter (M5.5). The Section 5 (Profile & Background) and Section 6 (Adoption & Programs) fields stay null until a CSM fills them via the dashboard. Clients reactivated via Branch 2 also gain `needs_review` (Scott may want to confirm pre-archive details still apply).

## Repo location

Next.js at repo root, alongside the existing Python serverless functions in `api/`. The "dashboard" label survives as a conceptual grouping (Next.js routes live under `app/`, dashboard helpers under `components/` and `lib/`) rather than a literal top-level directory.

```
ai-enablement/
├── api/                     # existing Python serverless functions
├── app/                     # Next.js 14 app router (dashboard routes)
│   ├── (authenticated)/     #   route group — auth-gated layout wraps all child routes
│   │   ├── clients/         #     /clients list + /clients/[id] detail
│   │   └── calls/           #     /calls list + /calls/[id] detail (M3.1)
│   ├── login/               #   /login
│   ├── layout.tsx           #   root layout (html, body, fonts)
│   └── page.tsx             #   root → redirects to /clients
├── components/              # shared UI (top-nav, ui/* shadcn primitives)
├── lib/                     # dashboard utilities
│   ├── db/clients.ts        #   data layer (uses service-role client)
│   └── supabase/            #   client/server/admin Supabase factories + types
├── ingestion/               # existing
├── shared/                  # existing Python utilities
├── supabase/                # existing migrations / seeds
├── package.json             # NEW (Next.js + Tailwind + shadcn deps)
├── next.config.mjs          # NEW
├── tsconfig.json            # NEW
├── pyproject.toml           # existing
├── vercel.json              # MODIFIED — declares framework + Python functions
└── CLAUDE.md
```

### Why Next.js at root, not in `dashboard/`

The original M2.3 spec planned a nested `dashboard/` directory. Reality forced Next.js to repo root because Vercel auto-detects Next.js from a *root-level* `package.json` with a `next` dependency. With Next.js nested, Vercel would need either (a) a project-level `rootDirectory` setting (which would then exclude the existing `api/*.py` serverless functions from the deploy), (b) the legacy `builds` block in `vercel.json` which mixes awkwardly with the modern `functions` block, or (c) a second Vercel project for the dashboard. None match the "single Vercel project; same deploy" constraint that gregory.md committed to.

Putting Next.js at root keeps a single Vercel project with both Next.js and Python serverless functions deploying together. The trade-off is repo-root visual clutter — `package.json`, `next.config.mjs`, `tsconfig.json`, `app/`, `components/`, `lib/` all sit alongside `pyproject.toml`, `api/`, `ingestion/`, `shared/`. Acceptable.

### vercel.json shape

The current `vercel.json` declares (a) the Python functions per file path, (b) the daily Fathom backfill cron, and (c) `"framework": "nextjs"` so Vercel builds the Next.js app alongside the Python functions.

The framework declaration is required, not optional. An explicit `functions` block in vercel.json suppresses Vercel's framework auto-detection from `package.json` — without `"framework": "nextjs"`, Vercel treats the project as static + functions and skips the Next.js build entirely (every dashboard route 404s). Caught and fixed during M2.3a deploy; documented in `docs/followups.md` as the lesson "explicit framework declaration is required when functions is also explicit."

## Stack

- Next.js 14 + TypeScript (per repo language policy)
- shadcn/ui for component primitives (table, dropdown, dialog, form)
- Tailwind for styling
- `@supabase/ssr` for server-side data access + auth
- `@supabase/supabase-js` for client-side hydration
- Generated TypeScript types from Supabase schema (avoid manual sync)

## Build phases

**M2.2** (this session, documentation only): scoping doc + migrations written but not applied + tracker + CLAUDE.md cleanup. No code.

**M2.3** (next session): scaffold + auth + Clients page (list + detail + inline save). Migrations applied. First deploy.

**M2.4** (following session): Calls page (list + detail + edit mode + classification_history writes).

**M2.5** (Drake-led): Aman manual review using the new Calls page. Reclassify ~66 external calls one-at-a-time via "Needs review" filter.

**V1.1 (later, separate session series):** Gregory's brain — Python agent that computes health scores + concerns, writes to `client_health_scores`. UI is already built against the locked `factors` jsonb shape; brain just needs to produce data in that shape.

## What V1 ships without

- No bulk operations on calls (Aman backlog done one-at-a-time)
- No automated sales-call classifier (deferred — manual via dashboard)
- No documents / chunks inspection (deferred to V2)
- No multi-CSM assignments in UI (schema supports, UI shows primary only)
- No CSM rollout / RLS / per-CSM scoping (V2)
- No Gregory brain (V1.1)
- No NPS ingestion pipeline (separate work)
- No Slack notifications from Gregory (V2+)

## Open architectural questions (deferred to V1.1)

- **Concerns vs score, separate or unified output?** V1.1 lean is unified (single jsonb on `client_health_scores`); could split into `client_concerns` table later if real distinction emerges.
- **`factors` jsonb final shape.** Locked-but-open per Drake's call. Proposed shape:

```json
{
  "signals": [
    {"name": "...", "weight": 0.3, "value": "...", "contribution": 15, "note": "..."}
  ],
  "concerns": [
    {"text": "Client mentioned doubt about the methodology in last 2 calls", "severity": "high", "source_call_ids": ["..."]}
  ],
  "overall_reasoning": "..."
}
```

V1 renders raw JSON acceptably; V1.1 nails the shape against whatever Gregory's brain actually produces.

## Working principles

Same as Ella — Gregory follows the four core principles in CLAUDE.md. Specifically:

- Dashboard reads from Supabase only; never queries Fathom or Slack directly.
- All Supabase access goes through a thin data layer (`lib/db/`) so swapping Supabase for another backend is contained.
- Page components are thin clients on the data layer; no business logic in pages.

## Build log

### M2.3a — Dashboard scaffold + auth (deployed 2026-04-28)

Shipped: Next.js 14 + TypeScript + Tailwind + shadcn scaffold at repo root. Supabase Auth wired (email/password). `/login`, auth-gated `/(authenticated)` route group, top nav with Clients / Calls links + logout. Migrations 0012 (`clients.notes`) and 0013 (`call_classification_history`) created as files. Deployed to https://ai-enablement-sigma.vercel.app.

Deviations from the M2.3a spec:

- **Next.js at repo root, not in `dashboard/`.** The original spec assumed a nested directory; Vercel auto-detection requires Next.js at root when `vercel.json` declares explicit functions. Spec section "Repo location" rewritten in this same housekeeping pass to reflect the actual layout.
- **Server Component auth gate, not middleware.** `@supabase/ssr` middleware crashes on Vercel Edge runtime (transitive dep uses Node-only `__dirname`). Replaced with a Server Component auth gate in `app/(authenticated)/layout.tsx` — both are documented Supabase patterns; the Server Component variant is functionally equivalent for our 2-user dashboard. Token refresh happens client-side in `@supabase/supabase-js` when tokens expire; no server-side refresh-on-every-request, which doesn't matter at our scale.
- **Cookie API uses `getAll`/`setAll`** (current pattern). The original spec used the deprecated `get`/`set`/`remove` triplet which crashes silently on Edge.
- **vercel.json required `"framework": "nextjs"`.** The original Task 7 analysis declared the vercel.json edit a no-op; that was wrong — an explicit `functions` block suppresses Vercel's framework auto-detection from `package.json`, so Next.js never built and every dashboard route 404'd. One-line fix.

### M2.3b — Clients pages (deployed 2026-04-28, smoke test pending)

Shipped: Data layer at `lib/db/clients.ts` (`getClientsList`, `getClientById`, `updateClient`, `changePrimaryCsm`). Migration 0014 (`change_primary_csm` Postgres function for atomic CSM reassignment). Clients list page with filters (status / journey / primary CSM / has open action items / auto-created needs review), debounced search on name + email, sortable columns, default sort `last_call_date desc nulls last`. Clients detail page with all 7 sections per spec — Identity (inline-save), Status (inline-save), Primary CSM (confirmation dialog + atomic swap via RPC), Indicators (4 cards: Health Score V1 empty, Call Cadence live, Concerns V1 empty, NPS live-or-empty), Recent Calls (read-only), Open Action Items (read-only), Notes (inline-save to `clients.notes`). Server Actions for inline-save and CSM swap. `needs_review` pill renders in the detail-page header with amber treatment.

Deviations from the M2.3b spec:

- **RLS fix required mid-session.** The data layer was first written using the auth-aware Supabase client (anon key + user session). All 134 clients in cloud, but page returned 0 because every public table has RLS enabled with zero policies (deny-default, already documented as a known issue in `docs/future-ideas.md`). Resolution: split into two Supabase clients — auth client (anon key + cookies, for user session in layout) and data client (service role + no cookies + `'server-only'` import guard, for `lib/db/` queries and `team_members` lookups in the page entry). This matches gregory.md's locked V1 spec ("RLS off for V1; app-level auth gate is sufficient"). Server-side-only constraint enforced; the service role key never reaches the browser bundle.
- **M2.3b smoke test steps 2–10 NOT YET RUN.** Step 1 (visual confirmation: page loads, all 134 clients populating) confirmed by Drake. Steps 2–10 (clicking into a client, inline edits actually persisting, CSM swap creating two `client_team_assignments` rows, filter chips narrowing the list, debounced search, sort toggling) are scheduled as the first task in M3.1 tomorrow. Building Calls pages on top of unverified Clients code would compound risk; the smoke test gates M3.1b.
- **`shadcn form` component skipped.** shadcn v4's registry didn't expose a `form` component under that name; the login form and detail-page inputs use plain controlled state + Server Actions instead of `react-hook-form`. Revisit if M3.x adds forms with non-trivial validation.
- **Tailwind v4 + shadcn v4** (not v3 as originally implied). shadcn v4's emitted components target Tailwind v4 utilities (`ring-3`, OKLCH theme colors, `@theme inline` directive, `@base-ui/react` primitives). Local upgrade was the cleaner path than backporting components to v3.

### M3.2 — Merge feature for auto-created clients (built 2026-04-29, deploy pending)

Shipped: end-to-end "Merge into…" flow on the Clients detail page for rows tagged `needs_review`. Five logical pieces:

- **Migration 0015 — `merge_clients(p_source_id uuid, p_target_id uuid) returns jsonb`.** Atomic plpgsql function performing all five merge steps in one transaction: (1) reattribute `call_participants.client_id`, (2) re-point `calls.primary_client_id` and flip `is_retrievable_by_client_agents=true`, (3) re-point + reactivate transcript_chunk `documents` whose `metadata.call_id` is in the source's call set, (4) soft-archive source via `archived_at=now()` + stamp `metadata.merged_into` / `metadata.merged_at`, (5) sync `metadata.alternate_emails` and `metadata.alternate_names` on target (always runs, dedupes via jsonb containment). Idempotency gate is `source.metadata.merged_into` — if set, steps 1–4 skip; step 5 always runs to fill retroactive gaps. Validation raises on: source missing, target missing, target archived, source not tagged `needs_review`, source == target. Returns a counts summary the dashboard surfaces in toasts.
- **Data layer at `lib/db/merge.ts`.** `mergeClient(sourceClientId, targetClientId)` calls the RPC and narrows raw Supabase errors into the dashboard's `success/error` result type. `listMergeCandidates(excludeClientId)` powers the dropdown — fetches `id, full_name, email` for every active client other than the source, ordered by name. Sibling file to `clients.ts` because merge is a multi-table operation, not a per-field client update.
- **Server Action `mergeClientAction` in `app/(authenticated)/clients/[id]/actions.ts`.** Wraps `mergeClient`, revalidates the source detail path, the target detail path, and the Clients list on success. No per-action auth verification — matches the existing actions pattern (the `(authenticated)` route-group layout gates every request to this path).
- **Reusable `SearchableClientSelect` at `components/searchable-client-select.tsx`.** Fetch-all-on-mount + client-side filter as the user types. ~134 rows comfortably; logged followups for the scaling triggers (~800 clients) and the transcript-doc-query scaling trigger (~50k transcript_chunk docs) so neither one becomes a surprise. Designed for reuse in the M3.3 Calls page primary-client picker.
- **`MergeClientButton` + dialog at `app/(authenticated)/clients/[id]/merge-client-button.tsx`.** Renders next to the amber `needs_review` pill in the detail-page header, only for `needs_review`-tagged clients. Dialog body explains the reattribution + archive consequence in plain language with the "reversible only by manual SQL" warning. On confirm: Server Action fires; on success the user is redirected to the target's detail page (the source is archived and would 404). On failure: error renders inline in the dialog and the dialog stays open.

Deviations from the originally-deferred M2.3c spec:

- **TypeScript-native via Postgres function, not a Vercel Python function.** The deferred spec called for `api/merge_clients.py` wrapping the existing `scripts/merge_client_duplicates.py`. Replaced with: (a) plpgsql function `merge_clients` in migration 0015 carrying the full merge body atomically, (b) TypeScript Server Action calling the RPC. Reasoning: the Python wrapper would have introduced an HTTP hop with no per-request transactionality (the script's 5 steps are sequential `UPDATE`s, partial-failure recovery is difficult), while the plpgsql function is single-transaction and matches the existing `change_primary_csm` pattern from M2.3b. The Python script was archived to `scripts/archive/merge_client_duplicates.py` in the same session as historical record of the four pilot pairs already merged.
- **Pulled forward in session ordering.** Originally slotted as M2.3c, deferred until after M3.3 Calls. M3.2 swapped this in (after the M3.1 smoke test) to clear the `needs_review` queue before Calls work begins.
- **No recovery runbook written.** The non-transactional-merge concern that motivated a runbook in option (a) is moot because the function is single-transaction by construction — partial failures roll back.
- **No SQL tests added.** The repo has no plpgsql test pattern today (Python tests live alongside Python code; the dashboard layer has no tests yet). Verification path: end-to-end test against a real source/target pair from the cloud `needs_review` queue, picked by Drake before deploy. The existing Python tests for `scripts/archive/merge_client_duplicates.py` stay as-is — they test the reference implementation, which is unchanged.

**Verified live 2026-04-29.** Migration 0015 applied to cloud via Studio + ledger registration; dual-verified (`pg_proc` returns `merge_clients` with 2 args returning `jsonb`, `security definer = true`; `supabase_migrations.schema_migrations` carries the 0015 row). Live merge ran beyond the recommended single Vid pair — three Vid rows existed (canonical `vid.velayutham@gmail.com` plus two auto-created at `vid@remodellectai.com` and `vid.velayutham@remodellectai.com`), so two sequential merges into the gmail canonical were performed. Both sources archived + stamped with target id; target accumulated *both* source emails into `metadata.alternate_emails` (the dedup-aware accumulator works correctly across sequential merges into the same target — a stronger stress test than a single pair); 5 calls re-pointed to target with `is_retrievable_by_client_agents = true`; transcript chunks reattributed and reactivated; zero orphan participants. Two visual flags surfaced and resolved: (a) "Call cadence didn't update" was a false alarm — most recent call across all three Vids was April 13, which the canonical already showed; (b) "Alternate emails not visible on the client detail page" was confirmed as a UI omission, not a merge bug — Section 1 (Identity) doesn't render `metadata.alternate_emails` / `alternate_names` because those fields are consumed server-side by the Fathom classifier. Logged in `docs/followups.md` as a small polish-pass fix.

### M3.3 — Calls page (built 2026-04-29, migration 0016 + deploy pending)

Shipped: end-to-end Calls list + detail with edit-mode classification save and per-changed-field audit rows. Five logical pieces:

- **Migration 0016 — `update_call_classification(p_call_id, p_changes jsonb, p_changed_by uuid)`.** Atomic plpgsql function applying classification edits in one transaction. Compares each incoming key in `p_changes` against the current row, writes one `call_classification_history` row per actually-changed field, then updates `calls`. Server-side enforcement: non-client category auto-clears `primary_client_id` (separate history row); `is_retrievable_by_client_agents` auto-derived (true iff `category='client' AND primary_client_id IS NOT NULL`); `classification_method` auto-set to `'manual'`. No-op silently when no fields differ. Same security-definer + jsonb-return shape as `merge_clients` and `change_primary_csm`.
- **Data layer at `lib/db/calls.ts`.** `getCallsList` does a single PostgREST round trip with nested `primary_client` and `call_participants` selects, then JS-side filters for the participant search (matches title + participant name/email). The `needs_review` filter is a three-way PostgREST `or()`: `confidence < 0.7`, `category = 'unclassified'`, or `(category = 'client' AND primary_client_id IS NULL)`. `getCallById` parallelizes participants / action items / summary / primary_client fetches. `updateCallClassification` wraps the RPC with whitelist enforcement (rejects non-editable field names before the round trip).
- **List view at `app/(authenticated)/calls/page.tsx`.** Sortable table with the 8 spec columns; default sort `started_at desc`; when the `Needs review` chip is on and no explicit sort is chosen, defaults to `confidence asc` so the lowest-confidence calls float to the top. Filter bar: category chips, "Filter by client…" button opening a `Dialog` with the M3.2 `SearchableClientSelect`, debounced 300ms search.
- **Detail view at `app/(authenticated)/calls/[id]/page.tsx`.** Six sections per spec. Section 2 is the only editable surface — explicit Edit button reveals dropdowns + Save/Cancel; Section 6 transcript is collapsed by default. The page entry passes the full client list to `ClassificationEdit` so the picker is always available without an extra round trip.
- **Server Action `updateCallClassificationAction`.** Wraps the data-layer fn, revalidates `/calls/${id}` and `/calls` on success, calls `router.refresh()` from the client to pick up the new state without a full nav. No per-action auth verification — route-group layout pattern, same as M3.2.

Deviations from the M3.3 spec:

- **Confidence threshold for "Needs review" set to 0.7.** Cloud distribution justified the choice: 6 calls below 0.5, 105 below 0.7, no rows in 0.7–0.8 (a clean cliff). 0.7 is the natural break — see §3 "What could go wrong" surfacing in this prompt's pre-build report.
- **Section 4 reads from `documents`, not `calls.summary`.** The original spec said "calls.summary if present, otherwise empty state." But `calls.summary` is empty for all 560 cloud rows; summaries live as `documents` rows of `document_type='call_summary'` keyed on `metadata.call_id`. `getCallById` queries `documents` for the latest matching row. Logged in followups: either backfill `calls.summary` from `documents` on ingest or drop the column.
- **`call_type` "(unset)" handling.** 175 of 560 calls have `call_type=null`. Read mode shows "(unset)" for null; edit mode dropdown's first option is `(Unset)` (value=`""`) which the function translates to `null`. All other enum values from migration 0003's column comment (`sales`, `onboarding`, `csm_check_in`, `coaching`, `team_sync`, `leadership`, `strategy`, `unknown`) included regardless of cloud-data presence.
- **Diff-only save.** UI builds a diff of fields that differ from the initial call values and sends only those. The function would also handle "send all 3" correctly (its `is distinct from` comparisons dedup), but the diff approach makes the audit trail honest about user intent.
- **`changed_by` is null in V1.** Migration 0013's column comment accommodated this: "auth.users to team_members join via email is best-effort." Server Action passes null; no per-action user resolution wired yet. Same pattern as `changeClientPrimaryCsm`'s reserved-but-unused `_current_user_team_member_id` parameter.
- **No SQL tests added.** Consistent with M2.3b / M3.2: the dashboard layer has no test pattern yet, and the plpgsql function isn't exercised by the existing Python suite.

**Migration 0016 not yet applied.** Drake applies via Studio + manual ledger registration before deploy.

**Verified live 2026-04-29.** Migration 0016 applied to cloud via Studio + ledger registration; dual-verified (function exists with three-arg signature `(p_call_id uuid, p_changes jsonb, p_changed_by uuid) returns jsonb`, `security definer = true`, ledger row landed). No-op smoke test (passing `'{}'::jsonb` for `p_changes`) returned the expected shape `{fields_changed: 0, history_rows_written: 0, auto_cleared_primary_client_id: false}`. Deploy hit one transient build failure that resolved on redeploy (logged separately in followups). Live UI smoke test on the cloud-deployed dashboard: edited a low-confidence call (Fathom external_id `137772208`) by changing its `call_type` via the detail page Save button. Outcome: exactly one row landed in `call_classification_history` with the correct `field_name='call_type'`, the prior value as `old_value`, the new value as `new_value`, and `changed_at` set to the save moment. `changed_by` is null per the V1 stance. Detail-page Section 2 reflected the new state on reload, `classification_method` showing `manual`. End-to-end verified.

### M3.4 — Gregory brain V1.1 (built 2026-04-29, deploy pending)

Shipped: end-to-end brain agent that computes per-client health scores + tier + (gated) concerns, plus weekly Vercel cron, manual-trigger script, and 37 unit tests. Architecture is complete; concerns generation is gated off until summary coverage densifies.

Pieces:

- **`agents/gregory/` package.** `signals.py` (4 deterministic signals — call cadence, open/overdue action items, latest NPS), `scoring.py` (rubric → 0-100 score + green/yellow/red tier, with insufficient-data default = yellow/50), `concerns.py` (Claude-driven, env-var-gated), `prompts.py` (concerns system prompt + user-message builder), `agent.py` (entry: `compute_health_for_client` + `compute_health_for_all_active`, agent_runs lifecycle wired with `duration_ms` populated — closes the duration-never-written gap for this agent).
- **Cron at `api/gregory_brain_cron.py`.** Weekly Mondays 09:00 UTC via `vercel.json`. BaseHTTPRequestHandler matching the `fathom_backfill` pattern. Bearer-token auth via a per-source-named env var at ship time (consolidated to `CRON_SECRET` across all crons in M6.2 — the per-source-namespacing rationale was never deliverable since Vercel only supports one CRON_SECRET per project).
- **Manual trigger at `scripts/run_gregory_brain.py`.** Three modes: `--client-id <uuid>`, `--email <addr>`, `--all`. Single-client mode is the M3.4 hard-stop verification path (Drake reviews one row in Studio before the all-active sweep lands).
- **Dashboard empty-state copy updated.** `ConcernsIndicator` and `HealthScoreIndicator` no longer say "Gregory will populate this in V1.1" — they now reflect the actual V1.1.0 state ("activates as call summary coverage grows" / "writes scores on the weekly cron run").

Spec deviations:

- **Concerns generation gated behind `GREGORY_CONCERNS_ENABLED` env var, default false.** Cloud reality at ship time: 22 `call_summary` documents across 132 active clients (~85% would have empty input). Paying the LLM cost to hand Claude nothing was the deciding factor. Architecture is complete; flag flips on without a code change once data densifies. Documented in this section's "Concerns generation (gated)" subsection above.
- **Cron weekly, not daily.** Signal change rate is slow (call cadence shifts day-to-day for ~5 clients tops; action items churn gradually). Weekly cadence is enough; daily would compound LLM cost when concerns flag flips on.
- **Slack engagement signal omitted.** `slack_messages` cloud table is empty (local-only ingestion). Add as a fifth signal once cloud Slack ingestion lands — re-balance weights at that time. Logged in followups.
- **No formal eval harness.** Same V1 carve-out as Ella. The 37 unit tests cover signal math, rubric, JSON parsing, and end-to-end wiring; golden-dataset eval is deferred until the rubric stabilizes.

**Migration count: 0.** No new migration required — `client_health_scores` and `agent_runs` already exist (migrations 0005, 0006).

**Not yet deployed.** Per M3.4 hard stops, Drake reviews `vercel.json` diff and confirms the cron auth env var is set in Vercel before push + deploy. First cloud run is single-client (Drake-reviewed in Studio) before the all-active sweep lands.

**Verified live 2026-04-29.** Vercel deploy succeeded (one transient build failure during the day resolved on redeploy — pattern noted in followups). Cron auth env var set in Vercel. **Single-client verification on Vid Velayutham** produced `score=70, tier=green, insufficient_data=false, concerns=0`. Factors math checks out: cadence 16 days ago → contribution 50 (mid-band), open action items 0 → 100 (clean docket), overdue 0 → 100, NPS missing → neutral 50. Weighted: `0.4×50 + 0.2×100 + 0.2×100 + 0.2×50 = 70`. Tier `green` per the ≥70 threshold. **All-active sweep** (`scripts/run_gregory_brain.py --all`) completed in ~6 minutes, landing 132 `client_health_scores` rows + 132 `agent_runs` rows (per-client wiring, every compute opens its own row, all `status='success'`, `duration_ms` populated — closes the duration-never-written gap for this agent). Tier distribution: **93 green / 40 yellow / 0 red**, zero rows with `insufficient_data=true`. Concerns generation gated off (`GREGORY_CONCERNS_ENABLED` unset), so every `factors.concerns[]` is empty — confirmed in spot-checks of the dashboard's Concerns indicator (now reads "No concerns surfaced — concerns generation activates as call summary coverage grows" per the M3.4 empty-state copy update). One rubric quirk surfaced: never-called clients still land green via the "0 action items = clean docket" interpretation (logged as a followup with two resolution options).

First scheduled cron run hits next Monday 09:00 UTC. Manual sweeps via the script are fine in the meantime.

### M5.5 — Comprehensive filter bar on /clients (shipped 2026-05-03, visual smoke implicitly verified through M5.6 smoke 2026-05-04)

Shipped: replacement of the chip-row + single-CSM-dropdown filter bar with a row of 9 dropdowns. 5 active multi-selects, 1 single-value toggle, 3 disabled placeholders that signal next-slice work to Scott during Monday's onboarding. Highest-priority push #1 from the M5 V1-adoption pivot — Scott reads "match the master sheet so I'll adopt Gregory" and the filter bar is the surface he'll spend most of his daily time on.

Pieces:

- **`lib/client-vocab.ts` — single source of truth for the four UI-surfaced clients vocabularies.** Status / csm_standing / nps_standing / trustpilot_status, each as `*_OPTIONS` (`{value, label}[]` with `as const satisfies readonly VocabOption[]`) plus a `*_VALUES` derived array for membership checks. Mirrors the DB CHECK constraints from migrations 0019 (status), 0020 (trustpilot rename), and 0021 (nps_standing). Color treatments stay co-located with their pill components — vocab is shared, visual treatment is a per-component concern. Closes the M5.4 followup that anticipated this share when the M5.5 NPS Standing filter dropdown landed.
- **`app/(authenticated)/clients/multi-select-dropdown.tsx` — base-ui filter primitive.** Built on the existing `DropdownMenu` + `DropdownMenuCheckboxItem` from `components/ui/dropdown-menu.tsx`; no new primitive system installed. Trigger label modes: `'multi'` (default, "{label}: {first} +{N}") and `'toggle'` ("{label}: on"). Disabled variant renders the same trigger silhouette as a plain `<button disabled>` with a `title` attribute for the hover hint — no Tooltip primitive is available and installing a Radix-based shadcn Tooltip would fragment the codebase's base-ui-only component aesthetic.
- **Filter bar rewrite at `app/(authenticated)/clients/filter-bar.tsx`.** 9 dropdowns in a `flex flex-wrap` row: Status, Primary CSM, CSM Standing, NPS Standing, Trustpilot (active multi-selects); Needs review (single-value toggle); Accountability, NPS toggle, Country (disabled placeholders with hover-tooltip hints describing what each will gate on once it ships). Search input + "Clear filters" button on a row above. Search stays debounced 300ms.
- **URL state model.** Each multi-select serializes as comma-separated values (`?status=active,ghost`). OR-within-dropdown, AND-across-dropdowns. Status carries a default-vs-explicit-empty sentinel: param absent → pre-check the default trio (`['active', 'paused', 'ghost']`) and keep the URL clean; param empty (`?status=`) → "user has unchecked everything, show all statuses including churned/leave"; param populated → `.in()` clause. The writer collapses the default-trio case via *set equality* (order-independent), so re-checking the three defaults in any click order returns to a clean URL. Sort + dir are orthogonal — preserved by every `writeParams` call and by `clearAll`.
- **Filter shape rewrite at `lib/db/clients.ts`.** `ClientsListFilters` switches from single-value to `string[]` arrays. DB-side via PostgREST `.in()` for `status` / `csm_standing` / `nps_standing` / `trustpilot_status`. JS-side filter for `primary_csm_ids` — matched against the active primary CSM derived from the `client_team_assignments` join (can't be expressed as a server-side `.in()` because the value lives in a nested select). Drops dead `has_open_action_items` / `show_archived` / `journey_stage` / `needs_review_only` branches; `needs_review` preserved under its new boolean shape with the same `tags @> ['needs_review']` predicate.
- **`EditableField.options` widened to `ReadonlyArray<...>`.** Supporting refactor so the vocab module's `as const` exports flow into the existing inline-edit dropdowns (lifecycle-section's CSM standing selector, adoption-section's Trustpilot selector) without manual narrowing at the call sites.

Deviations from the M5.5 spec:

- **`primary_csm_id` URL param renamed to `primary_csm`** for consistency with the other multi-value params. Deliberate break of any M3-walkthrough bookmarks Scott may have. Drake-confirmed at acclimatization time; Monday's onboarding is a fresh-start state where bookmark cost is negligible against the URL-naming-consistency win.
- **`mode: 'toggle'` prop on MultiSelectDropdown** beyond the spec's API. Needed for the Needs review dropdown — without it the trigger would read "Needs review: Auto-created — needs review" (long option label echoed back). With `mode='toggle'`, the trigger reads "Needs review: on" when checked, "Needs review" muted when unchecked. Single-line addition to the multi-select primitive; no separate component.
- **Trustpilot dropdown labels kept short** ("Yes", "No", "Ask", "Asked") matching the existing `adoption-section.tsx` inline-edit dropdown, not the spec's longer "Yes (review left)" / "No (declined)" form. Pre-baked rule from the spec's "prefer existing source and surface the diff" clause; surfaced at acclimatization, Drake confirmed.
- **`journey_stage` filter dropped** beyond the spec's explicit "drop has_open_action_items / show_archived / needs_review_only" instruction. The appendix's Change 3 `ClientsListFilters` shape doesn't include `journey_stage`; no UI exposes it after the chip removal; dead code removed.
- **`STATUS_DEFAULT_SELECTED` duplicated** between `filter-bar.tsx` (Client Component) and `page.tsx` (Server Component) rather than imported from a shared location. The 'use client' boundary makes a single import path awkward; both copies tested at the smoke checkpoint. Drift risk is small (one constant, two files) but flagged here.

**Migration count: 0.** Pure UI + data-layer change — vocab values come from existing DB CHECK constraints (0019, 0020, 0021).

**Smoke checkpoint passed 2026-05-03.** `next build` clean (0 type errors, 8/8 static pages, `/clients` route bundle 32.1 kB). 7 URL-equivalent SQL count probes against cloud all sensible: default trio = 145 (matches 145 + 52 churned = 197 non-archived from CLAUDE.md exactly); explicit-empty status = 197 (✓ all non-archived); `?needs_review=1` under default status = 24 (matches followups.md's "24 auto-created clients" exactly); `?nps_standing=promoter,neutral` under default = 48 ≈ 49 (CLAUDE.md's 27 promoter + 22 neutral; -1 for one outside default-visible — consistent); `?trustpilot=yes,no` under default = 82 ≤ 90 (-8 for ones in churned/leave — consistent); two-dropdown intersection `?status=active&csm_standing=at_risk` = 16 (subset of 145 default). Risks from the pre-build report: (1) default-state-vs-explicit-empty sentinel implemented per spec, (2) `DropdownMenuCheckboxItem` close-on-click neutralized at probe time — base-ui's default is `closeOnClick: false`, opposite of Radix, no special-case needed, (3) `primary_csm_id` rename shipped per Drake's confirmation. Visual eyeball on the auth-gated dashboard pending Drake's push + browser session.

**Pushed during the smoke greenlight window.** Three commits at `c761207` (vocab module + nps-standing-pill refactor) → `d8febaa` (MultiSelectDropdown) → `4059602` (FilterBar + page + getClientsList). Vercel auto-deploy follows the push. Visual smoke through the auth-gated dashboard UI is the remaining verification step — pending Drake's eyeball.

### M5.6 — Status cascade + Scott Chasing + accountability/NPS toggles (shipped 2026-05-04, hotfix landed same day)

Shipped: DB-level cascade so when a client's `clients.status` moves to a negative value (`ghost` / `paused` / `leave` / `churned`), a coordinated set of derived field changes auto-fire in one transaction:

1. `csm_standing` → `'at_risk'` (history row written, attributed to Gregory Bot)
2. `accountability_enabled` → `false`
3. `nps_enabled` → `false`
4. `primary_csm` reassigned to the **Scott Chasing** sentinel team_member
5. `trustpilot_status` — explicitly NOT touched (Scott was clear)

Implements Scott's Loom 1 + Loom 3 walkthroughs ("safer to default off whenever unsure"). Cascade is **one-directional** — there is no symmetric trigger for `active`. CSMs can manually flip `accountability_enabled` / `nps_enabled` back to `true` via the dashboard; the override is **not sticky** — a future negative-going status transition re-fires the cascade and flips them back to false. The dashboard surfaces an `active+off` amber hint on the toggles so re-activations don't go un-noticed.

Pieces:

- **Migration `0022_status_cascade.sql`.** Schema additions: `clients.accountability_enabled boolean not null default true`, `clients.nps_enabled boolean not null default true`, `team_members.is_csm boolean not null default false`. Sentinel: `Scott Chasing` team_member, UUID `ccea0921-7fc1-4375-bcc7-1ab91733be73`, `role='csm'`, `is_csm=true`, `metadata.sentinel=true`. Triggers: `clients_status_cascade_before` (BEFORE UPDATE — mutates NEW row in-flight) + `clients_status_cascade_after` (AFTER UPDATE — writes history row + reassigns primary_csm). Both gated on `OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('ghost','paused','leave','churned')`. The AFTER trigger handles primary_csm reassignment via `INSERT ... ON CONFLICT (client_id, team_member_id, role) DO UPDATE SET unassigned_at = NULL, assigned_at = now()` — the unique-key collision case fires when a client gets cascaded → manually reassigned to a real CSM → cascaded again, leaving the original Scott-Chasing assignment archived but present.
- **Updated `update_client_status_with_history` RPC.** Same signature, same allowlist. Adds `set_config('app.current_user_id', p_changed_by::text, true)` at the top of the function body (when `p_changed_by IS NOT NULL`) so the AFTER trigger can read the human attribution via `current_setting('app.current_user_id', true)`. SET LOCAL via `set_config(_, _, true)` is transaction-scoped; clears on COMMIT/ROLLBACK. Verified at smoke: probe A (RPC with GUC) landed Lou's UUID in the note; probe B (direct UPDATE in a fresh transaction immediately after A) landed `:by:NULL` — no leak.
- **Structured note format on cascade-induced rows.** `cascade:status_to_<status>:by:<uuid_or_NULL>` for transition-fired rows; `cascade:backfill:m5.6` for the migration's data backfill. SQL-side joinable to recover "which human triggered this cascade" — see audit query below.
- **Data backfill for current negative-status clients.** Two passes (history insert before UPDATE so the SELECT reads pre-update state). 82 clients in negative status flipped: 65 got `cascade:backfill:m5.6` history rows; 17 are silent toggles where `csm_standing` was already `'at_risk'` so no history row was written (snapshot at `docs/data/m5_6_silent_toggle_backfill.md`; recovery query in `docs/followups.md`). Primary_csm reassignment intentionally skipped for the backfill — the 32 currently-CSM-owned negative-status clients (Lou 18, Scott Wilson 13, Nabeel 1) keep their assignments. Drake decides manual cleanup post-apply.
- **`is_csm` backfill + dashboard dropdown filter.** `is_csm = true` set on the four real CSMs (Lou Perez, Nico Sandoval, Scott Wilson, Nabeel Junaid) + Scott Chasing sentinel. Both team_members SELECT sites in the dashboard now filter on `is_csm = true`: the M5.5 filter bar's `primaryCsmOptions` query in `app/(authenticated)/clients/page.tsx`, and the swap-CSM dialog's team_members fetch in `lib/db/clients.ts:getClientById`. Post-M5.6 the Primary CSM dropdowns show 5 options (the four CSMs + Scott Chasing); engineering / ops / sales / Gregory Bot are excluded.
- **`BooleanToggleField` in `components/client-detail/adoption-section.tsx`.** Small custom component for the two new toggles. Built rather than extending `EditableField` because the active+off warning hint depends on a sibling field (`client.status`) the generic component doesn't see. Visual treatment: amber border + ⚠ icon + `title` attribute tooltip on the trigger when `client.status === 'active' && client.<toggle> === false`. Same amber palette as the existing `needs_review` pill — reusing rather than introducing a new warning-color convention.
- **`UPDATABLE_FIELDS` + `FIELD_TYPES` extended in `lib/db/clients.ts`.** New `'boolean_toggle'` field type added to the `FieldType` union; Server Action narrowing accepts `true` / `false` / `'true'` / `'false'`, rejects null (the columns are `NOT NULL DEFAULT true`).
- **`lib/supabase/types.ts` hand-edits.** `accountability_enabled` + `nps_enabled` added to clients Row/Insert/Update + the three RPC `Returns` types that mirror clients shape (status / journey_stage / csm_standing). `is_csm` added to team_members Row/Insert/Update. Per CLAUDE.md the Supabase types regen path is broken; the standing followup tracks the manual-edit gap.

Audit-trail SQL query — find cascade-induced standing changes by who triggered them:

```sql
select
  c.full_name,
  csh.changed_at,
  split_part(csh.note, ':', 4) as triggered_by_user_uuid,
  tm.full_name                  as triggered_by_name,
  csh.csm_standing              as cascade_set_to,
  csh.note
from client_standing_history csh
join clients c on c.id = csh.client_id
left join team_members tm on tm.id::text = split_part(csh.note, ':', 4)
where csh.note like 'cascade:status_to_%'
order by csh.changed_at desc;
```

Notes on the query: `split_part(note, ':', 4)` returns the literal string `'NULL'` for cascade rows where no GUC was set (direct UPDATE via Studio, or a calling RPC that didn't set the GUC). The LEFT JOIN handles that — rows with `:by:NULL` show `triggered_by_name = NULL` (no UUID matches the literal string `'NULL'`). Future-proofing if the literal-NULL convention proves annoying: wrap with `nullif(split_part(note, ':', 4), 'NULL')` before the join.

Spec deviations:

- **17 silent-toggle clients accepted with snapshot + recovery query** (Drake call (a)+(d)). Pre-apply count was 17, above the spec's single-digit acceptance threshold. Drake confirmed accept-and-document path: `docs/data/m5_6_silent_toggle_backfill.md` carries the static UUID list; `docs/followups.md` carries the recovery query for re-derivation post-hoc.
- **Scott Chasing sentinel `role='csm'`** (Drake call). Distinct from Gregory Bot's `role='system_bot'` — Scott Chasing functions as a CSM placeholder from the dashboard's perspective (clients get assigned to it like any real CSM). The orthogonal `metadata.sentinel=true` flag remains the "exclude from real-team listings" filter.
- **Primary_csm reassignment skipped for backfill** (per spec). 32 currently-CSM-owned negative-status clients (Lou 18 / Scott Wilson 13 / Nabeel 1) keep their existing primary_csm assignments. Drake decides manual cleanup post-apply via the dashboard's swap-CSM dialog.
- **Custom `BooleanToggleField` over EditableField extension.** The active+off warning hint depends on `client.status`, which the generic EditableField doesn't carry. Adding the warning to EditableField would couple it to the parent client shape. Contained in adoption-section.tsx; ~70 lines.
- **stale `team_members.md` flagged + backfilled.** Doc listed only V1 seed (Scott / Lou / Nico / Drake / Nabeel / Zain) but live cloud has 11 rows including Aman (sales), Ellis (ops), Huzaifa (ops). Doc updated as part of Step 5 to mirror live state + add Scott Chasing to the sentinel table.

**Migration count: 1** (`0022_status_cascade.sql`).

**Smoke checkpoint passed 2026-05-04.** Migration applied to cloud via psycopg2; dual-verified (11/11 schema + ledger checks). Four SQL probes: A — RPC with GUC landed `:by:<lou-uuid>`. B — direct UPDATE in fresh transaction immediately after A landed `:by:NULL` (no GUC leak — the SECURITY DEFINER + SET LOCAL pattern works as designed; this was the highest-priority verification per Drake's pre-apply condition). C — re-fire idempotency on client_a (paused → ghost) wrote a new history row, did not double-swap primary_csm (correctly stayed Scott Chasing). D — both probe clients fully reset to pre-state (history rows preserved per immutability). `next build` clean: 0 type errors, 8/8 static pages, `/clients/[id]` route bundle 10.4 → 10.8 kB.

Risks post-build:

1. **GUC under SECURITY DEFINER + SET LOCAL** — *did not materialize* (probes A + B confirmed no leak).
2. **`UNIQUE` collision on re-cascade** — *not yet exercised in smoke.* Probe C re-fired the cascade on client_a, but client_a's active assignment was already Scott Chasing so the no-op-when-already-Scott-Chasing branch fired. The `ON CONFLICT (client_id, team_member_id, role) DO UPDATE` path will be exercised the first time a CSM manually reassigns a cascaded client back to a real CSM and that client subsequently gets cascaded again. Worth a follow-up live verification once a real cascade-then-reassign-then-recascade pattern surfaces.
3. **Backfill UPDATE accidentally firing the cascade** — *did not materialize.* The backfill UPDATE doesn't touch status; the trigger's `OLD.status IS DISTINCT FROM NEW.status` guard correctly evaluates false. 65 cascade:backfill:m5.6 rows landed via the explicit INSERT path; no surprise extras.
4. **active+off UI hint requires `client.status` in the toggle's data flow** — *resolved at design time* by building a custom `BooleanToggleField` rather than extending `EditableField`. Section reads `client.status` and `client.<toggle>` together at the call site; passes computed `warn` boolean down. EditableField stays unchanged.

**M5.6 commit chain shipped 2026-05-04** (all on origin/main): `fe51fec` (M5.5 carryover docs) → `4f8811f` (migration 0022) → `7251906` (dashboard wiring) → `5e57983` (close-out docs) → hotfix follow-up below.

#### M5.6 hotfix — three regressions surfaced by visual smoke (shipped 2026-05-04)

The expanded visual smoke triggered by the M5.6 deploy surfaced three bugs. Two of them were **pre-existing** issues never tested before; one was the M5.6 cascade exercising a 0014-era code path the migration apply briefly hit and the trigger had already correctly fixed inline. Documenting honestly because the audit trail benefits from "this bug existed for X commits before being caught" being visible — informs future smoke-test scoping.

- **Bug 1 — `clients.status` edit silently failed** (Section 1 of the client detail page). Click registered, dropdown closed, no Server Action fired. Pre-existed M5.6 — root cause introduced in M4 commit `19f4e50` ("feat(client-detail): add EditableField, EditableTagsField, NpsEntryForm") via the `setTimeout(commit, 0)` pattern in EditableField's enum onChange. Affected every enum and three_state_bool dropdown (status, csm_standing, trustpilot, ghl_adoption, sales_group_candidate, dfy_setting). Went untested until M5.6's expanded visual smoke because nobody had previously edited those specific fields through the dashboard end-to-end with a network-tab eye on them.
- **Bug 2 — `clients.csm_standing` edit silently failed** (Section 2). Same root cause as Bug 1, same fix.
- **Bug 3 — `change_primary_csm` RPC errored on swap-back-to-archived-CSM** with a unique-key violation. The 0014 RPC unconditionally INSERTed the new (client, member, primary_csm) row after archiving the active one — but `client_team_assignments` has `UNIQUE (client_id, team_member_id, role)` so a previously-archived row collided. The M5.6 cascade trigger (migration 0022) had hit the same case and used `ON CONFLICT (...) DO UPDATE SET unassigned_at = NULL, assigned_at = now()` to reactivate; the dashboard-facing RPC didn't get the same treatment until 0023 aligned it.

Root cause analysis on Bug 1+2 — the `setTimeout(commit, 0)` in `editable-field.tsx`'s enum onChange queued a macrotask that captured the THIS-render `commit` closure. The closure read `draft` from React state at queue time — **before** the just-fired `setDraft(e.target.value)` had taken effect. By the time the macrotask fired, React had re-rendered with the new draft, but the queued commit was a stale reference. It computed `parsed.value` from the OLD draft, hit `rawEquals(parsed.value, committed) === true`, took the "no change — exit cleanly" branch, and exited without calling `onSave`. The user saw a closed dropdown and assumed the save fired. The text/textarea/integer paths were unaffected because they call `commit()` from `onBlur` — a separate event handler that runs after typing has settled, with a fresh closure.

Pieces:

- **Migration `0023_change_primary_csm_on_conflict.sql`** — single-function `CREATE OR REPLACE` that replaces `change_primary_csm` with the ON CONFLICT variant. Same signature, same `language plpgsql security definer`, same archive-then-insert two-step. Behavior change purely additive (previously-erroring case now succeeds; previously-working first-time-assignment path unchanged). Mirrors the M5.6 status cascade trigger's primary_csm reassignment pattern (0022) so cascade-fired and dashboard-fired paths produce identical row shapes. Explicit `GRANT EXECUTE on ... to service_role` preserved for symmetry with 0018+ RPCs (discoverable via grep without needing the CREATE OR REPLACE preservation rule).
- **EditableField fix in `components/client-detail/editable-field.tsx`** — `commit` accepts an optional `draftOverride: string`; the enum / three_state_bool select onChange passes `e.target.value` directly (the new value is already in hand at that point); `setTimeout` dropped. Text/textarea/input onBlur paths wrap as `() => commit()` so React's FocusEvent doesn't get coerced into the new optional parameter. ~15 LoC net change including a multi-paragraph comment block explaining the failure mode for future readers.

Smoke verification:

- **Bug 3** — SQL probe (no UI needed) on Allison Jayme Boeshans (test client): swap Lou → Nico → Lou via the RPC. Step 2 (Nico → Lou, the previously-erroring case) succeeded with `+1` row delta — the archived Lou row reactivated rather than a duplicate landing.
- **Bug 1+2 + the four enum fields** — visual smoke through the auth-gated dashboard (Drake-driven, 2026-05-04). Status (Section 1), csm_standing (Section 2), trustpilot_status (Section 6), and one three_state_bool (Section 6) all edit + persist correctly. Cascade fires correctly through the dashboard path on negative-status transitions (status edit → cascade history row with `cascade:status_to_<x>:by:NULL` + csm_standing/accountability/nps flipped + primary_csm reassigned to Scott Chasing). Bug 3 swap-back also verified through the dashboard CSM swap dialog.

Untested but probably-affected pre-fix (verified working post-fix since they share the renderEditor branch): `ghl_adoption` (enum), `sales_group_candidate` (three_state_bool), `dfy_setting` (three_state_bool). Single fix covers the entire enum + three_state_bool family.

Hotfix commits on origin/main: `8d27e1e` (migration 0023) → `c2d59f4` (EditableField fix). Vercel auto-deploy followed Drake's manual redeploy.

Future-proofing: visual smoke scope expanded to include "edit-and-persist for every enum-variant field on the client detail page" going forward. The EditableField stale-closure bug existed for ~30+ commits across M4 → M5.6 before being caught; the cost of catching it earlier would have been one focused 5-minute pass after M4 Chunk B2 shipped. Logged as a reminder for future visual-smoke checklists.

### Path 2 outbound — accountability/NPS daily roster endpoint (shipped 2026-05-04)

Shipped: a GET endpoint Make.com pulls once per day to drive Zain's existing accountability + NPS automation. Replaces the Financial Master Sheet as the source of truth for that roster. Path framing reshaped from the earlier "event-driven UPDATE listener" sketch by yesterday's Make.com walkthrough with Zain — Zain's Make.com scenario already operates on a daily-pull cadence, so giving him one simple GET to swap in (and keeping Gregory unaware of the consumer) was the cleaner contract than triggering on column-level UPDATEs.

Pieces:

- **`api/accountability_roster.py`** — Vercel Python serverless function. Mirrors `api/airtable_nps_webhook.py`'s `BaseHTTPRequestHandler` shape and `gate-before-DB` auth pattern: missing env var → 500 (deploy bug, not caller's problem); missing or wrong `X-Webhook-Secret` header → 401 with empty body; only GET supported (POST → 405 `{"error": "method_not_allowed"}`; PUT/DELETE/PATCH naturally 501 from the base class). Single round-trip query: `clients` SELECT with embedded `slack_channels(slack_channel_id, is_archived, created_at)`. Per-client filter in Python mirrors `getClientById`'s slack_channel selection rule exactly (filter `is_archived=false`, sort `created_at desc`, take first) — kept in a `_select_active_channel` helper so the rule lives in one place.
- **`vercel.json`** — added `api/accountability_roster.py` to the functions block (`@vercel/python@4.3.1`, `maxDuration: 60`). Sixth Python function deployed.
- **`scripts/test_accountability_roster_locally.py`** — local 7-path harness mirroring `scripts/test_airtable_nps_webhook_locally.py`. Stands up the real `handler` class in a background `HTTPServer` thread on a kernel-picked port, then runs: happy-path response shape (10 sub-checks), count matches direct-SQL expected actionable count, spot-check known-good client appears with matching slack_channel_id, missing/wrong secret → 401, POST → 405, missing env var → 500. Read-only — no test-client cleanup needed.
- **`MAKE_OUTBOUND_ROSTER_SECRET`** env var minted by Drake, set in `.env.local` (local harness) and Vercel Production scope (deploy target). Same value in both. The harness uses its own per-run test secret and never reads the production value.

Eligibility filter (server-side, every row in the response is actionable by Make.com):

- `clients.archived_at IS NULL`
- `clients.slack_user_id IS NOT NULL`
- at least one `slack_channels` row with `is_archived=false` (most recently created wins)
- `clients.email IS NOT NULL` (defensive — Make.com keys on email)

No status filter — `accountability_enabled` and `nps_enabled` columns travel in the payload and Make.com filters on its side.

Response shape:

```json
{
  "generated_at": "<ISO8601 UTC>",
  "count": <int>,
  "clients": [
    {
      "client_email": "...",
      "slack_user_id": "U...",
      "slack_channel_id": "C...",
      "accountability_enabled": <bool>,
      "nps_enabled": <bool>
    }
  ]
}
```

Smoke checkpoint passed 2026-05-04 (local harness 22/22 green, deploy verification 4/4):

- Local harness: 22 checks across 7 paths against cloud DB. Live count = 100 actionable; total non-archived = 195; filtered out = 95 (NULL slack_user_id, no resolvable channel, or no email). Spot-check landed on Abel Asfaw with matching `C0A972VJQ9F` channel.
- Live endpoint at `https://ai-enablement-sigma.vercel.app/api/accountability_roster`: 200 with valid secret + identical 100/195 numbers; 401 with no header; 401 with wrong secret; POST → 405. Deploy took ~4 minutes from push to first 200 (existing endpoints stayed up throughout — Next.js 404 page surfaced on the new path until the Python function registered).

Spec deviations:

- **Defensive email-NULL filter** beyond the spec's two-condition filter (slack_user_id + slack_channel_id). All 197 active clients have emails today but the seed/import path doesn't enforce NOT NULL on `clients.email`, so a future bad import could surface a row with all other fields resolved but no email. Cheap to skip; matches the "every row in the response is actionable" contract since Make.com keys on email.
- **POST returns 405; PUT/DELETE/PATCH naturally 501.** Spec said "anything else → 405." Overriding all four `do_*` methods is busywork for a GET-only endpoint that Make.com only ever sends GET to. The harness covers POST → 405 (the spec'd test path); the rest hit `BaseHTTPRequestHandler`'s default 501 which is still rejection.
- **No outbound `webhook_deliveries` audit row.** Spec was explicit (table is for inbound). Make.com has scenario history on its side; we don't need a per-pull row. Logged as a followup if duplicate-pull volume ever becomes worth tracking.

Filter-delta observation worth flagging: **100 actionable / 195 non-archived = 95 clients dropped server-side** — bigger than expected. Likely causes: pre-resolution-sweep clients without `slack_user_id` resolved + clients without a `slack_channels` row in our DB. The endpoint is correct (it returns what's actionable today), but this surfaces a gap in client→Slack-identity coverage that may warrant a sweep before Scott's onboarding tomorrow. Surfaced to Drake at deploy time; not a blocker on the endpoint shipping.

**Migration count: 0.** Pure new-endpoint + harness. No schema changes — `accountability_enabled` / `nps_enabled` columns landed in M5.6 (migration 0022).

**Path 2 commit chain shipped 2026-05-04** (all on origin/main): `b204a88` (handler + vercel.json) → `b23b27c` (harness). Vercel auto-deploy followed; build registered the new function on the second-to-last poll.

### Cleanup pass — master sheet reconcile (shipped 2026-05-04)

Shipped: a two-phase Python tool (`scripts/cleanup_master_sheet_reconcile.py`) that diffs Scott's USA + AUS Financial Master Sheet tabs against Gregory's `clients` table and applies the high-confidence delta via existing RPCs. Replaces the M4 Chunk C `import_master_sheet.py` for ongoing reconciliation — that script was build-time seed; this one is steady-state cleanup. Built to handle the dual-CSV reality (master sheet now split across two regional tabs with different column orders) and the cascade-aware delta semantics that landed with M5.6.

Phase 1 (read-only): reads both CSVs, matches each row via the same 4-step ladder as `import_master_sheet.py` (email primary → email alternate → name primary → name alternate), classifies proposed changes into Tier 1 (auto-apply via RPC), Tier 2 (eyeball), Tier 3 (Scott meeting), and writes:

- `docs/data/m5_cleanup_diff.md` — structured diff for Drake to scan top-to-bottom
- `docs/data/m5_cleanup_scott_notes.md` — Bucket A pre-apply ambiguities + Bucket B post-apply mismatches + Quick Reference (status directives applied)

Phase 2 (`--apply`): tiered apply pass in cascade-aware order — status → re-read → csm_standing → primary_csm → trustpilot direct UPDATE → handover notes append. All RPC calls attributed to Gregory Bot UUID with structured note `cleanup:m5_master_sheet_reconcile` for SQL-side joinable audit. Re-diffs post-apply; remaining Gregory-vs-CSV mismatches land in scott_notes Bucket B.

Pieces:

- **CSV ingestion**: header-based parsing (filename is informational only — the contract is `Client Name` for USA / `Customer Name` for AUS). Trailing-whitespace headers (`Standing `, `Owner `, `Meetings May `) tolerated. Aggregator footer rows (USA's `TOTALS` / `Referrals` / `Upsells` / `Refund Rate` / etc.) filtered by "name non-empty AND email/status/owner/standing all blank" — drops 13 footer rows that survived the simpler blank-name filter.
- **Vocab maps** (CSV → Gregory): status (`Active`/`Paused`/`Paused (Leave)`/`Ghost`/`Churn`/`Churn (Aus)` + `N/A`/blank skip sentinels), csm_standing (compound parser handling `Owing Money, At risk` → at_risk), trustpilot (identity post-0020), owner (longest-match-first: `Scott Chasing` before `Scott` first-name fallback — AUS data has `Scott Chasing` as a real owner value).
- **Cascade-redundancy filter** (Drake's adjustment 1): if status is going to a negative value AND CSV csm_standing == `at_risk`, skip the explicit `update_client_csm_standing_with_history` RPC — the cascade trigger sets at_risk for free; an extra RPC produces a duplicate history row for no behavior delta. Positive-going transitions (Marcus Miller `ghost→active`, Allison Jayme Boeshans `paused→active`) keep the explicit write because the cascade is **one-directional** (off-only) and does not auto-revert standing.
- **slack_channel_id coverage filter** (Drake's adjustment 2): the previous "surface every CSV channel" approach produced 126 Tier 2 rows that were mostly noise (Gregory already had channels for those clients). Refactored to query `slack_channels` and only flag clients where Gregory has zero channels — knocked 126 → 26 real coverage gaps.
- **Handover note append**: 8 specific clients per Scott's morning message (Marcus Miller, Mac McLaughlin, Srilekha Sikhinam, Kurt Buechler, Michael Garner(Arthur Taylor), Sierra Waldrep, Shivam Patel, Nico Bubalo) get the literal handover note text appended to `clients.notes`. Idempotent on existing-text-contains-note. Matt G resolved to Matthew Gibson via CSV; he's a new client (CSV-side) not yet in Gregory, surfaced to scott_notes A6 + A9. The literal `Lou` from Scott's spec list is genuinely ambiguous (no client by that name in either CSV) — surfaced to A6.
- **Phase 2 apply ordering** (cascade-aware): status flips fire first, cascade BEFORE/AFTER triggers run in-transaction, then we re-read post-cascade state. Then csm_standing flips: explicit RPC writes CSV value, overriding cascade's at_risk for the contradiction subset (status moved negative + CSV said non-at_risk). Then primary_csm: explicit RPC overrides cascade's Scott Chasing reassignment for clients where CSV says a real CSM should own. Then trustpilot direct UPDATE (no history table). Then handover notes append (read current, check idempotency, write).

Apply outcome (2026-05-04 cloud cleanup):

- 36 status flips applied (34 negative-going → cascade fires; 2 positive-going → explicit standing/owner writes required)
- 32 csm_standing flips applied (4 cascade-redundant skipped at compute_diff time)
- 22 primary_csm changes (16 applied via `change_primary_csm`, 6 already matched — likely cascade-set Scott Chasing already aligned with CSV)
- 13 trustpilot flips applied (direct UPDATE; no history table)
- 8 handover notes applied (0 idempotent skips — first run)
- 0 errors
- 0 post-apply Bucket B mismatches — Gregory matches CSV across all Tier 1 fields

Tier 2 + Tier 3 staying for Scott meeting / manual triage (per Drake's adjustments 3, 4, 5):

- 26 slack_channel_id coverage gaps (clients with no slack_channels row but CSV has one)
- 15 csm_standing "Owing Money" / unparseable values (scott_notes A5 — CSM annotation, not a Gregory standing value)
- 2 email mismatches (scott_notes A8 — handle per `docs/runbooks/backfill_nps_from_airtable.md` § Failure modes)
- 4 Aleks-owned rows (scott_notes A2 — M4 Chunk C carry-over, Scott reassigns)
- 59 NPS Standing CSV-vs-Gregory differences (scott_notes A4 — Path 1 owns the column; informational only)
- 3 unmatched-with-email rows (scott_notes A9 — Anthony Huang, Matthew Gibson, Melvin Dayal — likely new clients to create-or-merge)
- 5 unmatched-without-email rows (scott_notes A10 — Clyde Vinson, Mishank, Rachelle Hernandez, Scott Stauffenberg, Vaishali Adla — Scott decides per row)

Spec deviations:

- **CSV-wins ordering for cascade contradictions** (status going negative + CSV csm_standing != at_risk). Drake's apply-gate framing implied "cascade overrides to at_risk; surface as Bucket B contradiction." The implementation has the explicit RPC fire AFTER the cascade in the same flow, so the explicit RPC wins — Gregory ends up matching CSV. End result is the cleanest possible (no Bucket B mismatches), honors Scott's explicit CSV intent. The diff still labels these cases at compute time so Drake can spot the pattern; the post-apply re-diff confirms Gregory matches CSV.
- **Toggle re-activation for positive-status transitions not handled.** Marcus Miller (ghost→active) ends with `accountability_enabled=False`, `nps_enabled=False` — cascade backfill from M5.6 set them False when he was negative-status, and the cascade is one-directional (off-only). These don't auto-revert on positive transitions. Followup logged for Drake/Scott to manually flip back via dashboard or to add a "positive-transition toggle reset" pass to this script in V1.1.
- **Aggregator footer filter narrower than positional**. The USA tab has 13 footer rows with names like `TOTALS`, `Referrals`, `Refund Rate`, `BE Collection Opportunity` that survived the simpler blank-name filter. Filter rule: name non-empty AND email/status/owner/standing all blank. Real clients with `N/A` status (Vaishali Adla, Rachelle Hernandez) keep their `N/A` strings which pass the filter — they surface to scott_notes A10 correctly.

**Migration count: 0.** All writes go through existing RPCs (`update_client_status_with_history`, `update_client_csm_standing_with_history`, `change_primary_csm`) + direct UPDATE on `clients.trustpilot_status` and `clients.notes`. The `cleanup:m5_master_sheet_reconcile` note format is SQL-joinable to find every row written by this sweep.

**Cleanup commit chain shipped 2026-05-04** (all on origin/main): `7f4d917` (Phase 1 dry-run + script) → `1c80149` (Drake-adjusted refactor + Phase 2 apply landed). Idempotency: re-running `--apply` against unchanged CSVs is a near-no-op — RPCs are no-op-when-unchanged; the handover-note append is gated on the literal text not already being present.

### Cleanup pass — delta + completeness (against canonical CSVs, shipped 2026-05-04)

Shipped: a delta re-run of the reconcile script against the canonical CSV location (`data/master_sheet/master-sheet-05-04/`) followed by a new completeness pass (`scripts/cleanup_master_sheet_completeness.py`) that closes the autocreate + crucial-field-fill gaps. End state: every CSV row resolves to a Gregory client, every client whose CSV row carries a value has Gregory populated, country is set USA/AUS per tab. Reconcile re-dry-run after both passes shows 0 Tier 1 changes — fully idempotent against the canonical CSVs.

Pieces:

- **CSV path repointing.** `cleanup_master_sheet_reconcile.py`'s `DEFAULT_USA_CSV` / `DEFAULT_AUS_CSV` constants now point at `data/master_sheet/master-sheet-05-04/...` (in-repo, gitignored data dir). Prior `/mnt/c/Users/drake/Downloads/` defaults were ad-hoc and had pointed at a stale Windows-side export — the canonical export superseded that, found in the prior diff/CSV mismatch surfaced as 24 cascade-introduced primary_csm reverts that needed a second pass.
- **Delta apply (Phase A).** 24 primary_csm reverts: clients whose status went negative during the prior cleanup's apply got reassigned to Scott Chasing by the M5.6 cascade trigger, but Scott's master sheet still had the original real CSM in the Owner column. The reconcile script's "primary_csm if current ≠ CSV" check at compute_diff time only caught cases where Gregory differed from CSV BEFORE the cascade; the cascade then introduced new mismatches that this re-run catches. Sample: `Cheston Nguyen: Scott Chasing → Lou Perez`. Zero status flips, csm_standing flips, trustpilot flips. 8 handover-note appends were idempotent skips (literal text already present from the prior apply).
- **Completeness script (Phase B).** New `scripts/cleanup_master_sheet_completeness.py`. Imports the reconcile script's CSV loader / resolver / normalizers (rather than re-building them) and adds two phases: autocreate-unmatched + fill-NULL-crucial-fields. NULL-fill semantics — never overwrites an existing Gregory value, with the one exception of `@placeholder.invalid` email replacement (synthesized stubs from `import_master_sheet.py` get replaced with real CSV emails when the CSV row resolves). UNIQUE collision-aware on `slack_user_id` (existing client wins) and `slack_channel_id` (existing link wins; NULL-client_id slack_channels rows get reattached to the new client). All RPCs / inserts attributed to Gregory Bot UUID with note `cleanup:m5_completeness`. Autocreated clients carry `metadata.created_via='m5_cleanup_completeness'` + `metadata.original_master_sheet_status='<raw CSV string>'` for the 4 N/A USA clients (Vaishali Adla, Scott Stauffenberg, Clyde Vinson, Rachelle Hernandez) coerced to status='churned'.
- **CsvRow extension.** Added `raw_date` field so the completeness pass can fill `clients.start_date` from the master sheet's `Date` column. Reconcile script's `_USA_HEADER_KEYS` / `_AUS_HEADER_KEYS` extended to include `"date"`. Backwards-compatible default (`raw_date: str = ""`).
- **slack_channels reattach pattern.** Inspired by `ingestion/slack/pipeline.py:262`: insert new row when `slack_channel_id` doesn't exist; if existing row has `client_id IS NULL`, UPDATE to set `client_id`; if existing row points elsewhere, surface to anomalies (skip — existing link wins). The 29 slack_channels writes during apply broke down as 26 fills + 3 inserts from autocreates; whether each was a fresh INSERT or a NULL-reattach is captured in the apply summary counts (`slack_channels_inserted` vs `slack_channels_relinked`).

Apply outcomes (2026-05-04 cloud cleanup):

**Phase A delta (commit `0efff3a`):**
- 24 primary_csm reassignments applied (cascade-introduced reverts)
- 0 status / csm_standing / trustpilot flips needed
- 8 handover-note idempotent skips (literal text present from prior run)
- 0 errors

**Phase B completeness (commit `83a0f88`):**
- 8 autocreates (5 with placeholder email, 3 with real email)
- 180 country fills (every matched non-archived client; tab-derived USA/AUS)
- 180 start_date fills (every matched client had CSV date + Gregory NULL)
- 92 phone fills
- 1 slack_user_id fill (UNIQUE-collision-aware)
- 29 slack_channels inserts (26 from gap-fills + 3 from autocreates with channel ids)
- 5 primary_csm assignments (3 of 8 autocreates had no resolvable owner: Clyde Vinson, Rachelle Hernandez, Mishank)
- 8 status_history seeds + 3 standing_history seeds (only 3 autocreates had csm_standing in CSV)
- 0 anomalies, 0 errors

End-state verification:
- 203 non-archived clients (was 195; +8 autocreates ✓)
- 15 clients with NULL country / start_date — these are non-CSV clients (203 total - 188 CSV rows = 15 not on Scott's master sheet; can't fill from a source that doesn't exist)
- Re-running `cleanup_master_sheet_reconcile.py` dry-run after both passes: 0 Tier 1 changes — Gregory exactly matches CSV across status, csm_standing, primary_csm, trustpilot. Tier 2 dropped 44 → 18 (the 26 slack_channel coverage gaps closed). Tier 3 went 63 → 67 (+4 because the 8 new autocreates surface NPS Standing values from CSV that Path 1 hasn't touched yet).

Spec deviations:

- **start_date and country are completeness-pass scope, not reconcile-pass scope.** Reconcile only handles the four canonical edit fields (status / csm_standing / primary_csm / trustpilot_status). Adding two more would have bloated reconcile's diff and conflated edit-flips with first-time fills. Keeping completeness as the dedicated NULL-fill tool keeps each script's purpose tight.
- **Reused reconcile's data primitives via import.** `cleanup_master_sheet_completeness.py` imports `CsvRow`, `load_csv`, `build_resolver`, `load_team_members`, `load_active_primary_csm`, `load_slack_channels_by_client`, all the normalizers, and the sentinel UUIDs. Not factored into a `shared/cleanup/` module yet — the two scripts are the only callers and a third would prompt the refactor. Logged as a follow-up if a third caller arrives.
- **No status_history seed for autocreates with N/A original status.** The status_history insert lands the post-coercion value (`'churned'`), not the literal `'N/A'`. The metadata column carries the literal — that's the forensics trail. The history table only carries valid status values per its CHECK constraint.

**Migration count: 0.** All writes through existing RPCs / direct INSERTs. `cleanup:m5_completeness` note is SQL-joinable to find every row written by this sweep, distinct from `cleanup:m5_master_sheet_reconcile` so the two passes' contributions are separable.

**Combined commit chain on origin/main:** `0efff3a` (Phase A path repoint + delta apply) → `83a0f88` (Phase B completeness script + apply). Both phases idempotent on re-run. Canonical CSV location going forward: `data/master_sheet/master-sheet-<MM-DD>/`.

### Cleanup pass — misclassified-client archive (shipped 2026-05-05)

Shipped: end-of-cleanup tool (`scripts/archive_misclassified_clients.py`) that closes the last 3 Gregory rows that the Fathom classifier auto-created from non-client conversations. Each row got its calls reclassified through the dashboard's existing `update_call_classification` RPC, then the client row was soft-archived with structured metadata for forensics. Two-phase apply via `--apply-calls` / `--apply-archives` flags so a hard stop sits between them — call writes land first, client archive is the recovery point if anything surprises us.

Pieces:

- **3 client rows archived** (matches `metadata->>'archived_via' = 'm5_cleanup_misclassification_archive'`):
  - `Andrés González` (Drake's spec said "Andy Gonzalez"; DB had the formal name with accents) — `email='andy@thecyberself.com'`, `misclassification_type='external_hiring'`. 3 calls reclassified to `category='external'`. The Fathom classifier auto-created him as a client from a hiring-interview call series — sales-flavored conversation tripped the heuristic.
  - `Aman` — `email='amanxli4@gmail.com'`, `misclassification_type='internal_team'`. 1 call reclassified to `category='internal'`. Aman is now on team_members but his call pre-dated his team_members row, so the classifier had no email/identity hint to call it internal.
  - `Branden Bledsoe` (Drake's spec said "Brendan"; DB had "Branden") — `email='brandenbledsoe@transcendcu.com'`, `misclassification_type='representative_of_other_client'`, `rerouted_to_client_id=<Isabel Bledsoe's UUID>`. 1 call kept `category='client'`; only `primary_client_id` flipped from Branden to Isabel (her offboarding call where Branden joined as her representative).
- **5 calls reclassified.** All went through `update_call_classification` RPC (migration 0016) with `p_changed_by=Gregory Bot UUID`. The RPC auto-handled: clearing `primary_client_id` on the 4 category-changing calls, deriving `is_retrievable_by_client_agents` (false for external/internal, true for Branden's repointed client call), stamping `classification_method='manual'`, writing per-field `call_classification_history` rows. 1 history row per category change + 1 per primary_client_id change = 9 history rows total (4 category + 4 auto-cleared primary + 1 Branden primary repoint).
- **Document is_active suppression** for category-change calls (Drake's gate-time adjustment 2). Call-level `is_retrievable_by_client_agents` is the primary gate (Ella's `kb_query` filters on it transitively), but flipping `is_active=false` on the linked documents is a defensive over-suppress so the docs are excluded by every layer that filters on document state directly. 3 documents deactivated (Andy's 2 + Aman's 1); 1 already inactive (Andy had a previously-suppressed doc); 1 kept active (Branden's, which is now Isabel's offboarding-call summary — legitimately retrievable for her account).
- **Soft-archive pattern** mirrors `merge_clients` (migration 0015:115): `archived_at=now()` + metadata jsonb merge with structured keys (`archived_via`, `archived_at_iso`, `misclassification_type`, optional `rerouted_to_client_id`). Idempotent on re-run via `archived_at IS NOT NULL` check. SQL-joinable — `WHERE metadata->>'archived_via' = 'm5_cleanup_misclassification_archive'` returns the 3 rows.

End-state verification:
- 188 non-archived clients (was 191; -3 ✓)
- 188 CSV rows on the canonical master sheet (perfect 1:1 match between CSV and Gregory; zero extras, zero unmatched)
- 5 history rows attributed to Gregory Bot UUID with `changed_at` in the today's apply window — UUID-only attribution (the table has no `note` column per migration 0013)

Spec deviations:

- **Attribution rides on Gregory Bot UUID alone for call_classification_history.** Drake's spec called for `note='cleanup:m5_archive_misclassified'`; the audit table has no `note` column (per migration 0013 — only `changed_by`, `changed_at`, `field_name`, `old_value`, `new_value`). Surfaced at the gate; Drake accepted UUID + timestamp window as sufficient forensic signal.
- **Document is_active flipped only for category-change calls.** Branden's case is a primary_client_id repoint (category stays `client`); his call summary is legitimately Isabel's account content post-repoint and stays retrievable. Andy's + Aman's docs flipped to inactive as belt-and-suspenders.
- **Name resolution defensive against spelling drift.** "Andy Gonzalez" resolved to "Andrés González" (the formal name in DB with accent characters) via a 3-candidate ladder. "Brendan Bledsoe" resolved to "Branden Bledsoe" (DB has the alt spelling). "Aman" enforced exact full_name match post-ilike to avoid "Amanda" / "Amanpreet" false positives.

**Migration count: 0.** All writes through existing RPCs (`update_call_classification` for calls) + direct UPDATE on `clients` (archive) and `documents` (is_active flip).

**Commit chain on origin/main:** `6d6b460` (script + dry-run, no writes) → `c7d1cbe` (call reclassifications + targeted document suppression applied). Archive phase landed via second invocation of the same script; no new code commit (script unchanged from `c7d1cbe`).

### M5.7 — Trustpilot cascade + 3 filter dropdowns + monthly meetings + inactivity flag (shipped 2026-05-05)

Shipped: four small adoption-focused chunks plus a Path 2 payload extension. Lands on top of M5.6's cascade infrastructure (Chunk 1) and M5.5's filter bar (Chunk 2), and adds two computed-on-read activity signals to the client list + detail surfaces (Chunks 3 + 4). Path 2 outbound roster grows one field for Zain (Chunk 5).

Pieces:

- **Migration `0024_trustpilot_cascade_on_happy.sql`.** One-directional BEFORE UPDATE trigger on `clients`. Fires when `csm_standing` transitions TO `'happy'` (`OLD IS DISTINCT FROM NEW AND NEW = 'happy'`); sets `clients.trustpilot_status := 'ask'`. No AFTER trigger (no history table for trustpilot_status, no companion side effects). No backfill (forward-only by design — existing happy clients with non-`'ask'` trustpilot keep their state, since the trigger fires on transition not presence). Co-exists with the M5.6 status cascade via alphabetical trigger-name ordering: `clients_status_cascade_before` < `clients_trustpilot_cascade_on_happy_before`, so a hypothetical UPDATE that flips both status to negative AND csm_standing to happy in one statement runs the status cascade first (which sets NEW.csm_standing='at_risk'), then the trustpilot trigger's WHEN clause re-evaluates against the post-cascade NEW row and does NOT fire — negative status dominates. Multi-paragraph comment block in the migration explains both the ordering interaction and the no-backfill rationale.
- **Filter bar — three dropdowns replacing the M5.5 disabled placeholders.** `app/(authenticated)/clients/filter-bar.tsx` now exposes Country, Accountability, NPS toggle as live multi-selects. Country options are sourced **dynamically** server-side in `page.tsx` from `clients.country` distinct-values (USA + AUS today, NULLs filtered server-side); chosen over a static vocab export because country isn't CHECK-constrained yet, so the DB is the only authority — when the column gets promoted to a CHECK-constrained vocab in a later slice, the options will move into `lib/client-vocab.ts` alongside the others. Accountability + NPS toggle each carry On / Off via static `TOGGLE_OPTIONS` in filter-bar.tsx; mapping `'on' | 'off'` → boolean happens in the data layer (`getClientsList` `.in('accountability_enabled', bools)`). URL params: `?country=USA,AUS`, `?accountability=on,off`, `?nps_toggle=on,off` (the latter chosen over `?nps=` to disambiguate from `nps_standing`'s adjacent param space). `hasAnyFilter` extended to surface the Clear button when any of the three is set. Junk values in the URL params (e.g. `?accountability=foo`) are filtered at parse time so a crafted URL no-ops cleanly.
- **Monthly meetings tracker + inactivity flag (Chunks 3 + 4).** Both are computed JS-side from the existing nested calls select in `getClientsList` and the existing parallel calls fetch in `getClientById` — no migration, no new round trip, no stored column. `meetings_this_month`: count of calls where `started_at >= date_trunc('month UTC', now())`. `inactive`: true when no calls at all OR latest call > 30 days ago. Both surface on the Clients list page (extending the existing "Last call" cell with `· N this mo` muted sub-text and an `Inactive` amber pill on flag=true) and on the Clients detail page (the Section 4 `Total calls` StatBlock gains a `submeasure` slot showing "X this month", and an `Inactive` pill renders next to the "Recent calls" subheader on flag=true). `StatBlock` gained a `submeasure` prop alongside the existing `note` prop — `submeasure` is a real value (non-italic, tabular-nums), `note` stays reserved for the "Pipeline pending" placeholder italics. `ClientsListRow` and `ClientDetail` types extended with `meetings_this_month: number` and `inactive: boolean`.
- **Path 2 outbound roster — `full_name` added to payload (Chunk 5).** Zain needs `full_name` in the Make.com daily-pull payload to address clients by name in the automation. One-field add: `api/accountability_roster.py` selects + emits `full_name` per row; module docstring's `Response shape` block updated; harness `expected_keys` set extended with `full_name` plus a new `1.row_full_name_str` assertion. Non-breaking for the existing Make.com scenario. Live count at re-deploy: 128 actionable / 188 non-archived (was 100 / 195 at ship 2026-05-04 — coverage closed 28 clients in the intervening day, likely from the slack_user_id fills via the M5 completeness pass).

Audit-trail SQL — find clients whose trustpilot was auto-set by the new trigger:

The trigger writes to `clients.trustpilot_status` directly without a history row (no history table for that column). To confirm it fired in a recent transition, join `client_standing_history` on the same `client_id` for a `csm_standing → 'happy'` row near the same `clients.updated_at` (or `now()` for direct UPDATEs). For audit visibility V1 accepts the lossy view; if Scott wants per-event provenance later, we'd add a `client_trustpilot_history` table mirroring `client_standing_history`'s shape.

Spec deviations:

- **Country dropdown options sourced dynamically from DB, not a static vocab module.** Two-value reality today (USA + AUS), no CHECK constraint, M5 completeness pass is the populator. A static vocab would lock the dropdown to those two values when the next CSV import could legitimately add more (UK, Canada). The dynamic query is one extra `.select('country')` round trip per `/clients` render — acceptable at our volume. When country gets CHECK-constrained, this moves into `lib/client-vocab.ts` next to the other vocabs in one swap.
- **Detail-page `Inactive` pill placed next to "Recent calls" subheader, not next to a "Last call" display.** The detail page has no single "Last call" widget — the closest analog is the Recent calls list. Pill rendered inline with the subheader. Same amber palette as the existing `needs_review` pill and the M5.6 toggle warning so we're not introducing a new warn-color convention.
- **`StatBlock` gained `submeasure` prop rather than overloading `note`.** `note` is reserved for the "Pipeline pending" italic placeholder (used by the `Total accountability submissions` and `Course content consumption` blocks); using it for a real value would conflate "data not implemented yet" with "real signal." `submeasure` renders non-italic, tabular-nums.
- **No "Inactive only" filter dropdown in this slice.** Per the spec — defer until we see if Scott actually uses the inactive pill before adding a filter for it.
- **Monthly meetings uses UTC month boundary, not Drake's local timezone.** Existing list-view "Last call" cell uses `new Date()` without timezone awareness either; matching the established pattern. The display-layer 1-day timezone-shift followup (Drake at UTC-7) is unrelated — that's a `toLocaleDateString` artifact, not a counting artifact. Calls right around midnight UTC at month boundaries could land in the "wrong" month from Scott's perspective; rare enough at V1 to ignore.

**Migration count: 1** (`0024_trustpilot_cascade_on_happy.sql`).

**Smoke checkpoint passed 2026-05-05.** Migration applied to cloud via psycopg2 with parameterized credentials (the pooler URL contains an unquoted `#` in the password that breaks naive URL injection — used keyword args directly). Dual-verified: `pg_trigger`, `pg_proc`, and the `supabase_migrations.schema_migrations` ledger row all returned the expected single match. Smoke probe: picked Adam Macdonald (`csm_standing='content'`, `trustpilot_status='no'`); direct UPDATE flipped csm_standing to `'happy'`; trustpilot flipped to `'ask'` as expected; reverted both fields cleanly. `next build` clean: 0 type errors, 8/8 static pages, `/clients` route bundle 32.1 kB unchanged, `/clients/[id]` 10.8 kB unchanged. ESLint 0 warnings. pytest 381/381 (no new tests; UI chunks rely on tsc + build for type-correctness, harness covers Chunk 5). Path 2 harness 23/23 (was 22/22 +1 for full_name).

**M5.7 commit chain on origin/main:** TBD — five commits ready to push, held for greenlight. Per-chunk:

1. Migration 0024 + apply ledger
2. Filter dropdowns (country/accountability/nps_toggle) + onboarding-notes update
3. Monthly meetings tracker (data layer + StatBlock submeasure + list cell)
4. Inactivity flag (data layer + detail pill + list cell)
5. Path 2 payload `full_name` addition (handler + harness)

Plus an M5.7 build log entry in this file + the CLAUDE.md migration count update.

### M5.8 — Path 2 outbound roster grows country + advisor_first_name (shipped 2026-05-05)

Shipped: two-field extension to the Path 2 payload per Zain's NPS-automation ask. `country` is a passthrough of `clients.country` (free-text today; USA / AUS / null in production). `advisor_first_name` is derived from the active primary_csm's `team_members.full_name` via `full_name.split()[0].capitalize()` — whitespace-split (hyphenated names like "Mary-Jane" stay whole), leading-cap-rest-lower for cosmetic consistency, null when no active primary_csm assignment. Existing eligibility filter unchanged — clients without a primary_csm still surface in the roster, they just emit `advisor_first_name: null`.

Pieces:

- **`api/accountability_roster.py`** — extended the `.select(...)` to add `country` plus `client_team_assignments(role,unassigned_at,team_members(full_name))`. New `_select_advisor_first_name` helper picks the `role='primary_csm' AND unassigned_at IS NULL` row from the embed list, takes `team_members.full_name`, returns the first whitespace-separated token capitalized. Mirrors the JS-side derivation in `lib/db/clients.ts:240-247` exactly. Module docstring's `Response shape (200 OK)` block updated with both new fields + a paragraph documenting the derivation rule and the null-when-no-CSM contract.
- **`scripts/test_accountability_roster_locally.py`** — `expected_keys` set extended with `country` + `advisor_first_name` (8 total). Four new assertions: `1.row_country_str_or_null`, `1.row_advisor_str_or_null`, plus two conditional checks when advisor is non-null (`1.row_advisor_single_token`, `1.row_advisor_leading_cap`). 23/23 → 27/27.
- **`docs/runbooks/accountability_roster.md`** — runbook doesn't spell out the response shape inline (references the docstring), so no shape edit. Stale "Expected output: 22/22 checks passed" line bumped to 27/27 (was already drifting from the M5.7 23/23).

Spec deviations:

- **`.capitalize()` mangles internally-cased names like "DeShawn" → "Deshawn".** Per Zain's spec; current CSMs (Lou / Nico / Scott / Nabeel + Scott Chasing) all clean. Logged followup if internally-cased CSMs ever appear.
- **No primary_csm join added to eligibility filter.** Spec didn't ask for it; clients without a primary_csm legitimately surface with `advisor_first_name: null`. Adding eligibility-gating would silently shrink the roster.

**Migration count: 0.** Pure payload-shape extension.

**Smoke checkpoint passed 2026-05-05.** Local harness 27/27 against cloud (was 23/23). Spot row: Kevin Black, country=USA, advisor=Scott. Live actionable count 128 / 188 non-archived (unchanged from M5.7 chunk 5 ship — the Slack-identity coverage gap stays static day-over-day at this scale).

**Commit chain:** TBD — single commit ready-to-push, held for greenlight.

### M5.9 — Path 3 inbound onboarding form receiver (shipped 2026-05-05)

Shipped: third Airtable integration path. Path 1 (NPS) was inbound + segment-mirroring; Path 2 (accountability/NPS roster) was outbound + daily-pull. Path 3 closes the new-client provenance loop — Zain's existing onboarding flow (Slack channel created → client invited → Airtable form submitted) now fires a webhook into Gregory at submission time. Replaces the manual-or-via-Fathom-side-effect path that was the only way new clients landed in Gregory's `clients` table before today.

Pieces:

- **Migration `0025_create_or_update_client_from_onboarding.sql`** — single security-definer RPC `create_or_update_client_from_onboarding(p_full_name, p_email, p_phone, p_country, p_start_date, p_slack_user_id, p_slack_channel_id, p_delivery_id) returns jsonb`. Match-or-create on email + alternate_emails (case-insensitive) with three branches: active match → `updated`; archived match → `reactivated` (clears `archived_at`); no match → `created`. Mirrors `ingestion/fathom/pipeline.py:_lookup_or_create_auto_client`'s archived-row reactivation pattern. Uses `update_client_status_with_history` + `update_client_csm_standing_with_history` RPCs with Gregory Bot UUID attribution (note `'onboarding form initial seed'` for create, `'onboarding form submission'` for update/reactivate). Status seed on the create branch goes via DIRECT INSERT into `client_status_history` rather than the RPC because the column is `NOT NULL DEFAULT 'active'` and the RPC's idempotent-when-unchanged path skips at row birth. csm_standing seed goes via the RPC because the column is nullable. needs_review tag appended idempotently via `array(select distinct unnest(coalesce(tags, '{}') || array['needs_review']))`. slack_channels resolution handles 6 branches (active-same / active-different-conflict / no-row-INSERT / NULL-client_id-reattach / archived-unarchive / different-client-conflict) — see migration header for the full grid.

- **Receiver `api/airtable_onboarding_webhook.py`** — Vercel Python serverless function. Auth via `X-Webhook-Secret` against `AIRTABLE_ONBOARDING_WEBHOOK_SECRET` (gate-before-DB; 401s write no row). 7-field payload validation (all required, non-null, string-typed, non-empty after strip). `date_joined` accepts ISO date or ISO datetime. RPC's structured exception strings translate to HTTP 409: substring matching ordered to check the longer `_owned_by_different_client` form before the shorter `_conflict_for_client` to avoid prefix misclassification. webhook_deliveries audit lifecycle mirrors the M5.4 NPS receiver: `received` → `processed` | `failed` | `malformed`.

- **Harness `scripts/test_airtable_onboarding_webhook_locally.py`** — 11 paths (74 sub-checks). Self-seeds an `onboarding-test-update-<token>@nowhere.invalid` fixture for the update / idempotent / conflict tests, hard-deleted in cleanup. Discontinued the NPS harness's stable-Branden pattern because Branden was archived 2026-05-05 in the M5 misclassification cleanup (followup logged). Uses DB's `now()` (not Python's `datetime.now()`) for history-row threshold queries to avoid cross-clock skew filtering out just-written rows by milliseconds.

- **`vercel.json`** — added `api/airtable_onboarding_webhook.py` to the functions block. Seventh Python serverless function deployed.

- **`.env.example`** — `AIRTABLE_ONBOARDING_WEBHOOK_SECRET` documented with a 12-line block describing generation, secret rotation flow, and the runbook reference.

- **Runbook `docs/runbooks/airtable_onboarding_webhook.md`** — endpoint URL, auth + rotation flow, payload + response shapes, three-action contract, `Debug a missing client` flow (find the webhook_deliveries row by source + email), `Debug a Slack ID conflict` flow (with SQL probes for each conflict type), failure modes table.

Spec deviations:

- **Status seed on create branch uses direct INSERT, not the RPC.** The RPC's idempotent path (`current_status == new_status` → no history row) means calling `update_client_status_with_history(id, 'active', ...)` on a freshly-INSERTed clients row writes zero history rows — the column is `NOT NULL DEFAULT 'active'` so current is already 'active' at row birth. Direct INSERT into `client_status_history` matches migration 0017's seed pattern and gives the audit row the spec asks for.
- **Conflict-error pattern matching is substring-based.** Same brittle-but-honest pattern as the M5.4 NPS receiver's `'no active client matches email'` substring. The harness covers all three conflict types so a future RPC message change surfaces as a regression there. Order of checks is significant: `_owned_by_different_client` → `_conflict_for_client` → `slack_user_id_conflict`.
- **First migration apply hit a `slack_channels.name NOT NULL` violation.** The initial RPC body INSERTed only `slack_channel_id`, `client_id`, `is_archived`. Caught by the smoke probe; the failed transaction rolled back atomically (zero cloud state change). Patched the INSERT to provide `name = p_full_name` (channel-name hint mirroring `cleanup_master_sheet_completeness.py`'s pattern), `is_private = false`, plus `metadata.created_via = 'onboarding_webhook'` for forensics. CREATE OR REPLACE re-apply landed clean. Smoke probe 13/13 on second apply.

**Migration count: 1** (`0025_create_or_update_client_from_onboarding.sql`).

**Smoke checkpoint passed 2026-05-05.** Migration applied to cloud via psycopg2; dual-verified (`pg_proc` confirms 8-arg signature; `supabase_migrations.schema_migrations` ledger row registered). RPC smoke probe 13/13 against cloud (synthetic guaranteed-no-match email → `action='created'`, all 7 fields persisted, status_history + standing_history seed rows attributed to Gregory Bot, slack_channels row inserted; client soft-archived in cleanup, history rows preserved). Local harness 74/74 against cloud — covers happy create / update / reactivate, idempotent re-fire, all 7 missing-field permutations, wrong-type, unparseable date, invalid JSON, wrong secret + no-delivery-row check, slack_user_id conflict, slack_channel_id conflict.

**Commit chain:** TBD — held for greenlight at session end.

### M6.1 — CS visibility surfaces (per-call summary + daily accountability notification, shipped 2026-05-05)

Shipped: two CS-visibility features bundled in one session as the first slice of Batch A — CSM accountability visibility (per `docs/future-ideas.md` § Batch A). The two features share infrastructure (a new `shared/slack_post.py` helper extracted from Ella's two-token post path) and audit pattern (`webhook_deliveries` rows with new source labels) but live in separate trigger surfaces.

**Architecture:**

- **Per-call CS summary** — pipeline-hook trigger. Hooks into `ingestion/fathom/pipeline.py:ingest_call` after `_ensure_summary_document` writes the call_summary doc. For `call_category='client'` calls only, calls `agents/gregory/cs_call_summary_post.py:maybe_post_cs_call_summary` which loads the active primary_csm + client name, formats a plain-text Slack message, and posts via `shared.slack_post.post_message` to `SLACK_CS_CALL_SUMMARIES_CHANNEL_ID`. Wrapped in try/except — Slack-post failure NEVER fails the Fathom webhook delivery.
- **Daily accountability notification** — Vercel Cron trigger at `0 12 * * *` (12:00 UTC = 7am EST, 8am EDT during DST). New endpoint `api/accountability_notification_cron.py`. Fetches yesterday's submissions from Airtable (paginated GET with `filterByFormula`), queries Gregory for active accountability-enabled clients with their primary_csm, computes the missing list, groups by CSM, posts one Slack message per CSM to `SLACK_CS_ACCOUNTABILITY_CHANNEL_ID`. Skips entirely if no CSM has missing clients ("no news is good news"). Loud `:warning:` Slack alert on Airtable failure so silent breakage isn't possible.

**Both share:**
- `shared/slack_post.py` — new module exposing `call_chat_post_message(token, body)` (low-level transport, extracted from `api/slack_events.py`'s identical helper) and `post_message(channel, text, *, thread_ts=None, blocks=None)` (high-level wrapper using `SLACK_BOT_TOKEN` only — no user-token fallback because internal CS channels don't need APP-tag suppression). Existing Ella two-token post logic stays in `slack_events.py` and now imports the transport from `shared.slack_post`. 14 Ella post-tests still pass after the refactor (patches updated from `api.slack_events.urllib.request.urlopen` → `shared.slack_post.urllib.request.urlopen`).
- Audit trail via `webhook_deliveries` with distinct source labels: `cs_call_summary_slack_post` and `accountability_notification_cron`. Same lifecycle (received → processed | failed | malformed) as the M5.4 NPS receiver.

Pieces:

- **`shared/slack_post.py`** — new module. Two surfaces: `call_chat_post_message(token, body)` (the transport, formerly `api/slack_events.py:_call_chat_post_message`) and `post_message(channel, text, ...)` (high-level fire-and-forget helper that NEVER raises — returns `{ok, slack_error}` for callers to log + continue).
- **`api/slack_events.py`** — refactored. `_call_chat_post_message` is now an alias re-export from `shared.slack_post.call_chat_post_message` (kept for in-file references and to keep the existing test patches stable in spirit; actual urlopen call is in `shared.slack_post`). Two-token Ella logic unchanged.
- **`tests/api/test_slack_events_post.py`** — 13 patch sites updated from `api.slack_events.urllib.request.urlopen` → `shared.slack_post.urllib.request.urlopen`. 14/14 still pass.
- **`agents/gregory/cs_call_summary_post.py`** — new module, `maybe_post_cs_call_summary(db, *, call_id, call_category, primary_client_id, summary_text, fathom_external_id) → dict`. Skips non-client categories silently. Sentinel labels (`[unassigned]`, `[unknown client]`) for graceful degradation when CSM or client lookups fail. Audit row writer uses the same insert-then-mark pattern as `api/airtable_nps_webhook.py`. Public-dashboard deep-link hardcoded as `https://ai-enablement-sigma.vercel.app/calls/{call_id}`.
- **`ingestion/fathom/pipeline.py`** — one new try/except block in `ingest_call` between the action-items upsert and the IngestOutcome return. Calls the new module; logs + continues on any exception.
- **`api/accountability_notification_cron.py`** — new endpoint. `BaseHTTPRequestHandler` mirroring `gregory_brain_cron.py`. Bearer auth via a per-source-named env var at ship time (consolidated to `CRON_SECRET` in M6.2). Inner function `run_accountability_notification_cron()` is testable independently of the HTTP wrapper — that's what the harness exercises directly. Internal helpers: `_fetch_yesterday_submissions` (paginated Airtable GET), `_fetch_eligible_clients` (Gregory query + primary_csm join), `_select_active_primary_csm_full_name` (mirrors `accountability_roster.py`'s pattern), `_format_csm_message` (first-name extraction via `.capitalize()`, mirrors M5.8), `_post_failure_alert` (loud Slack alert on cron-itself-failed paths).
- **`scripts/test_cs_call_summary_locally.py`** — 6-path / 28-check harness. Self-seeds a test client + CSM + assignment; mocks Slack at the helper level; asserts message format + audit row shape across happy, non-client-skip, no-summary, channel-missing, slack-ok-false, sentinel-label paths.
- **`scripts/test_accountability_notification_cron_locally.py`** — 7-path / 31-check harness. Self-seeds 3 clients + 2 CSMs; mocks Airtable HTTP via `urlopen` patching + Slack at the helper level; asserts happy path / idempotent re-run / no-missing skip / Airtable failure → `:warning:` alert / per-CSM partial failure / channel-missing / auth via real HTTPServer thread.
- **`vercel.json`** — added `api/accountability_notification_cron.py` to functions with `maxDuration: 60`, plus a new `crons[]` entry `{path: "/api/accountability_notification_cron", schedule: "0 12 * * *"}`. Eighth Python serverless function deployed; third Vercel Cron entry alongside fathom_backfill (daily 08:00 UTC) and gregory_brain_cron (Mondays 09:00 UTC). The per-call summary doesn't need a separate function entry — it hooks into the existing Fathom webhook handler.
- **`.env.example`** — five new env vars documented (cron auth token entry was consolidated into the shared `CRON_SECRET` block in M6.2): `SLACK_CS_CALL_SUMMARIES_CHANNEL_ID`, `SLACK_CS_ACCOUNTABILITY_CHANNEL_ID`, `AIRTABLE_ACCOUNTABILITY_PAT`, `AIRTABLE_ACCOUNTABILITY_BASE_ID`, `AIRTABLE_ACCOUNTABILITY_TABLE_ID`.
- **Runbooks** — `docs/runbooks/cs_call_summary.md` + `docs/runbooks/accountability_notification_cron.md`. Same style as `docs/runbooks/airtable_onboarding_webhook.md`.

Spec deviations:

- **Slack-post helper factor-out scope.** The prompt said "if it's inline in the handler, factor it out" — Ella's post code wasn't inline (already a module-level callable in `api/slack_events.py`), it just lived in `api/` rather than `shared/`. Treated this as the spirit of the prompt and moved the low-level transport (`_call_chat_post_message`) to `shared/slack_post.py`; left the two-token strategy (`_post_to_slack`) in `slack_events.py` since it's Ella-specific (user-token fallback for client-channel APP-tag suppression, irrelevant for internal CS channels). Mechanical test-patch update from `api.slack_events.urllib.request.urlopen` → `shared.slack_post.urllib.request.urlopen`; 14/14 Ella tests still pass.
- **No-primary-csm clients silently dropped with audit-row counter.** Per the acclimatization-time decision: clients with `accountability_enabled=true` AND `status='active'` AND no active primary_csm get counted in `payload.unassigned_missing_count` but NOT included in any per-CSM Slack message. Live count at ship: zero (verified via cloud SQL probe — all 91 active accountability-enabled clients have an active primary_csm). The dropped-with-counter pattern is forward-defensive rather than addressing a current gap.
- **"No missing clients" → skip + post nothing.** Per the prompt's lean: no celebration message. Audit row records the clean run with `skipped_reason='no_missing_clients'` so Drake can see the cron fired.
- **Airtable failure → loud Slack alert.** Built per spec. `:warning:` message to the destination channel referencing the audit `delivery_id` so Drake sees the failure within ~24h max.
- **Per-CSM partial failure isolated.** One CSM's post failing doesn't break the others. Audit row's `processing_status` flips to `failed` if any CSM failed (so failed-row queries surface the partial); response payload separately lists `csms_messaged_ok` + `csms_messaged_failed[]`.
- **First-name extraction reuses M5.8's pattern** (`full_name.split()[0].capitalize()`). Same internal-cap mangling caveat (DeShawn → Deshawn). All current CSMs are clean.

**Migration count: 0.** Pure new endpoint + helper module + pipeline hook. No schema work.

**Smoke checkpoints passed 2026-05-05:**
- **Chunk 1 harness:** 28/28 against cloud (with self-seeded fixture client + CSM, hard-deleted in cleanup; Slack mocked at the helper level, no real chat.postMessage fired).
- **Chunk 2 harness:** 31/31 against cloud (3 fixture clients + 2 CSMs; Airtable mocked at urlopen + Slack mocked at the helper level; happy path observed 5 posts because the cloud DB has 91 production accountability-enabled clients in addition to the 3 fixtures, so production CSMs Lou/Nico/Scott also "received" hypothetical messages for their real missing clients in the simulation; no real Slack posts).
- **Ella post-tests:** 14/14 still pass after `shared/slack_post.py` refactor.
- **Full pytest suite:** 381/381 still passing.

**Cron schedule operationally:** at 12:00 UTC daily, the cron fires its first real production run on the next deploy. Live count at first fire will depend on yesterday's actual Airtable submissions; the audit row will surface eligibility/submitted/missing breakdown immediately. If everyone submitted (best case), no Slack posts go out and the audit row records `skipped_reason='no_missing_clients'`. If nobody submitted (worst case — Airtable side broken or a Saturday with zero submissions), every CSM gets a message listing all their active accountability-enabled clients.

**Commit chain:** 4 commits on origin/main (`8c34f9e` shared helper + Ella refactor → `bbfdc4f` per-call summary → `158db17` accountability cron → `8975e90` docs). Pushed 2026-05-05.

#### M6.1 cron auth saga + M6.2 refactor (shipped 2026-05-06)

The M6.1 accountability cron's first deploy hit a 401 saga that surfaced a real architectural finding worth recording.

**The saga.** Drake set `ACCOUNTABILITY_NOTIFICATION_CRON_AUTH_TOKEN` in Vercel Production and redeployed; "Run now" returned 401 with no `Authorization` header visible in Vercel function logs. Diagnosis-only investigation walked the auth path end-to-end and surfaced: Vercel Cron infrastructure ALWAYS sends `Authorization: Bearer <CRON_SECRET>` where `CRON_SECRET` is a project-level env var with a fixed name — not configurable via `vercel.json` or anywhere else. Drake had set the M6.1 custom-named token but `CRON_SECRET` in Vercel was still set to the fathom_backfill value from M1.2.5 (which DOESN'T match the M6.1 token). When Vercel Cron fired, it sent the (stale) fathom value as the Bearer; the M6.1 handler validated against `ACCOUNTABILITY_NOTIFICATION_CRON_AUTH_TOKEN` (a different value); → 401.

The deeper finding: the codebase's "per-source-namespacing for independent rotation" rationale (`FATHOM_BACKFILL_AUTH_TOKEN`, `GREGORY_BRAIN_CRON_AUTH_TOKEN`, `ACCOUNTABILITY_NOTIFICATION_CRON_AUTH_TOKEN`) was **never deliverable** — Vercel only supports ONE `CRON_SECRET` per project, so per-source naming required operators to set BOTH env vars in sync per cron, which silently failed when a new cron deployed and the operator only set the new custom-named token. The fathom_backfill and gregory_brain_cron crons had been working because `CRON_SECRET` happened to match the per-source token at their respective deploy times.

**M6.2 refactor.** Single commit (`a7722e6`): all three cron endpoints now read `CRON_SECRET` directly. Auth-validation function bodies, docstrings, manual-trigger curl examples, runbooks, env.example, CLAUDE.md, test harnesses, build-log + followup references — all updated to the single-var pattern. 11 files changed, 105 insertions, 82 deletions. Final-pass grep returns ZERO references to the three deprecated env var names anywhere in the repo. pytest 381/381; fathom backfill harness auth-subset 3/3; accountability cron harness 31/31; Ella post-tests 14/14 — all unchanged from pre-refactor.

The three custom-named env vars in Vercel become dead weight after this deploy; Drake's manual cleanup is to delete them from Vercel Settings → Environment Variables once the redeploy verifies all three crons auth successfully.

**Architectural finding logged to `docs/followups.md`** so future sessions know why all crons share a single secret: independent per-cron rotation isn't supported by Vercel. If a future use case ever requires true independence (e.g., a third-party caller who shouldn't be able to trigger ALL crons by knowing one secret), it requires a separate auth surface — not solvable via env var naming.
