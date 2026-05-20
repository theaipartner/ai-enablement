# Known Issues — Gregory

Real bugs and ops gaps for Gregory, with concrete next actions. Distinct from `docs/future-ideas.md` (Gregory V2 batches A–E — deferred features waiting on a trigger) and `docs/decisions/` (architectural decisions, when populated). Ella's bugs and ops gaps live separately in `docs/agents/ella/followups.md` (kept under that name for now; renamed when an Ella-focused sweep happens).

**Entry format.** Short. Four lines:

- **What:** one-sentence description.
- **Why it matters:** consequence if ignored.
- **Next action:** concrete step that resolves it (or a check that answers whether it needs resolving).
- **Logged:** date.

---

## NEXT SESSION FIRST ACTION — verify daily cron fired (one-time gate, REMOVE after running)

**This is a one-time verification gate, not a recurring routine.** First action of the next session, before any planned work. Remove this entry from `docs/known-issues.md` AND the matching pointer from `CLAUDE.md § Next Session Priorities` once the verification has run, regardless of outcome.

**Background.** On 2026-05-08 the gregory_brain cron switched weekly→daily AND gained an `ai_call_signal` freshness filter. The deploy from this session is the first real exercise of both. Tomorrow's 09:00 UTC scheduled fire is the integration smoke; we want to confirm before iterating further.

**Run this query** (against cloud Supabase via `shared.db.get_client()` or psql against the pooler URL):

```sql
SELECT
  count(*) AS total_rows,
  min(started_at) AS earliest,
  max(started_at) AS latest,
  count(*) FILTER (WHERE output_summary LIKE 'skipped%') AS skipped_count,
  count(*) FILTER (WHERE status = 'success') AS success_count,
  count(*) FILTER (WHERE status = 'error') AS error_count
FROM agent_runs
WHERE agent_name = 'gregory'
  AND trigger_type = 'cron'
  AND started_at >= '2026-05-08 09:00:00'
  AND started_at <  '2026-05-08 10:00:00';
```

Note: `output_summary LIKE 'skipped%'` is the cost-rollup split documented in the freshness-filter design — but `output_summary` lives on the `ai_call_signal` child runs, not the parent `gregory` runs. **The query above as written will return 0 for `skipped_count` even on a perfectly healthy sweep.** Re-run the same shape against `agent_name='ai_call_signal'` to get the true skip rate. Both queries together give the full picture.

**Three outcomes — three reads:**

1. **`agent_name='gregory'` total_rows ≈ 188, earliest+latest within 09:00–09:59 UTC AND `agent_name='ai_call_signal'` skipped_count > 150** → Scheduled cron fires correctly, freshness filter is doing its job, fully self-running. End-state achieved. Remove this entry + the CLAUDE.md pointer; proceed with planned work.

2. **`agent_name='gregory'` total_rows = 0** → Scheduled trigger still broken. Same three diagnostic gates from prior cron-firing investigation: schedule not picked up, `CRON_SECRET` mismatch (Encrypted env var masking on `vercel env pull` complicates client-side testing), or silent code-path failure. Pause planned work, diagnose this first.

3. **`agent_name='gregory'` total_rows ≈ 188 but `agent_name='ai_call_signal'` skipped_count is LOW (< 50)** → Cron fired but freshness filter has a bug. Investigate why most clients recomputed when they shouldn't have. Most likely culprits: (a) the `_last_successful_compute_iso` jsonb-key filter not matching as expected (UUID type coercion?), (b) an off-by-one in the timestamp comparison (`>` vs `>=` on `latest_review_iso > last_compute_iso`), (c) the V1.1-transition fallback firing for too many clients because the May 2026 sweep rows have a `factors.signals[]` shape we didn't anticipate. Architecturally non-blocking but worth fixing before the next iteration.

**Logged:** 2026-05-07 (one-time gate added at session-close).

---

## ~~Passive dispatch has no idempotency check against duplicate Slack message delivery~~ — RESOLVED 2026-05-20

Resolved via `ella-realtime-ingest-idempotency` (2026-05-20). The fix lives upstream of the dispatch layer the original entry pointed at — a step-0 dedup gate in `ingestion/slack/realtime_ingest.py:ingest_message_event` uses `webhook_deliveries.webhook_id` (PK) as the dedup primitive. The `webhook_id` is now deterministic per `(slack_channel_id, slack_ts)` (was a per-delivery UUID), and the gate runs via UPSERT-with-`ignore_duplicates=True` (the Fathom-handler pattern) before any side effect fires. A second Slack delivery of the same logical message returns empty data on the upsert → the function short-circuits with `skipped_reason='duplicate'` before `_upsert_message`, the passive-monitor fork, or any escalation dispatch can run. A forensic audit row with `processing_status='duplicate'` + `payload.original_delivery_id` is written for trace-ability. Upstream-gate position satisfies Drake's design call "dedup at the earliest moment" (cheaper than later positions: duplicate costs one UPSERT attempt, zero LLM calls, zero downstream work). See `docs/runbooks/slack_message_ingest.md` § Dedup gate for the operational contract and `docs/agents/ella/ella.md` § @-Mention Handling (Structural) for how this completes the 2026-05-19 EOD misfire triage. Production resume on the 136 paused channels is now unblocked pending Drake's gate (c) smoke validation.

~~- **What:** Realtime ingest forks to `passive_monitor.evaluate_passive_trigger` on every `slack_message_ingest` event. When Slack delivers the same message event twice (retry semantics, `message_changed` events, webhook redelivery during outages), the full pipeline fires twice including the LLM decision and any client-facing dispatch action. `pending_digest_items` has a unique index on `(slack_channel_id, triggering_message_ts)` that prevents double-flagging, but the upstream `acknowledge_and_escalate` dispatch (ack post + `escalations` row + DM fan-out via `fire_escalation_dms`) consults no such guard.~~
~~- **Why it matters:** Caused 2 of the 3 acks in the 2026-05-19 evening misfire — Dhamen's single message at 16:58:14 ET in C0AFEC456JG fired ack #1 and ack #2 from the same `slack_messages` row. Six DMs to Scott + Lou (3× each) when one would have been correct. Production blocker for re-enabling passive monitoring on the 136 channels currently gated off.~~
~~- **Next action:** Add an idempotency check at the dispatch layer reading `(slack_channel_id, triggering_message_ts)` against prior `agent_runs` rows OR a small dedicated dedup table — before the LLM call (cheaper) or before the dispatch action (more conservative). Spec required before production resume.~~
- **Logged:** 2026-05-19 (EOD; surfaced from the C0AFEC456JG misfire diagnostic). Resolved 2026-05-20.

## ~~No firm-after-first / rate-limit on acknowledge_and_escalate path~~ — RESOLVED BY REMOVAL 2026-05-20

Resolved-by-removal via `ella-at-mention-routing-gate-and-advisor-context` (2026-05-20). The 2026-05-19 EOD diagnostic initially framed this as a separate problem; the chat-side re-read showed Dhamen's second message was a fresh routing attempt to a third human (`<@U0AR5684W0Y>` = Nico), not a recurrence of the original escalation. The new Gate 3 in `passive_monitor._evaluate` removes the message class that would have re-triggered the gate: every `<@non-ella>` message is now a pre-LLM skip. No firm-after-first replacement was needed. The rate-limit machinery would still be useful if a future failure mode surfaces messages that legitimately reach `acknowledge_and_escalate` but the same client keeps re-posting equivalents — log a new entry if/when that surfaces.

~~- **What:** The unified-path refactor (2026-05-18 PM) removed the firm-after-first gate the original architecture had, with no replacement on the `acknowledge_and_escalate` decision path. When a stuck client posts multiple messages in quick succession (even seconds apart), each one independently triggers an ack + DM round to Scott + primary advisor. From the system's POV each decision is correct (separate message, separate evaluation, both warrant escalation); from client and advisor POV the thread feels acked-to-death and the DMs duplicate.~~
~~- **Why it matters:** Caused ack #3 in the 2026-05-19 evening misfire — Dhamen's second message at 16:58:59 ET (bare `<@U0AR5684W0Y>` adding another teammate, 45 seconds after the first message) triggered a 3rd independent ack + 3rd DM round. Production blocker for re-enabling passive monitoring at the 137-channel scale; without it, any stuck client posting a multi-message question burst produces the same fan-out.~~
~~- **Next action:** Per-channel rate-limit on `acknowledge_and_escalate` (e.g., one ack per channel per 5 minutes, with the digest item still writing each time so Scott's daily skim isn't impoverished). Implementation can be in-memory cache, DB-backed check against recent `agent_runs`, or Redis if introduced. Spec required before production resume.~~
- **Logged:** 2026-05-19 (EOD; surfaced from the C0AFEC456JG misfire diagnostic). Resolved-by-removal 2026-05-20.

## ~~Decision Haiku has no rule for "client @-mentioned specific humans → Ella stays silent"~~ — RESOLVED 2026-05-20

Resolved structurally via `ella-at-mention-routing-gate-and-advisor-context` (2026-05-20). Rather than adding a soft prompt rule (the original Next-action), the fix is a pre-LLM gate: `ingestion/slack/realtime_ingest.detect_at_mentions` returns `is_routed_to_others=True` whenever the message has at least one `<@U...>` mention and none is Ella, and Gate 3 in `passive_monitor._evaluate` returns a synthetic skip with `digest_flag=True` + `digest_category='other'` before any DB fetch or Haiku call. The decision Haiku never sees routed-to-humans messages, so `acknowledge_and_escalate` is literally unreachable for that input class. Same shape of fix as the 2026-05-19 PM @-mention classifier surgery — make the wrong outcome structurally impossible at the schema layer rather than iterating on prompt copy. See `docs/agents/ella/ella.md` § @-Mention Handling (Structural) § "The routed-to-humans gate."

~~- **What:** When a client explicitly @-mentions one or more team_member users (advisors, Scott, anyone other than Ella) the message is a clear "I'm routing this to these specific humans" signal — Ella should defer. The decision Haiku prompt has no rule covering this case. The only @-mention-related rules in the current prompt covered @-mentions of Ella herself, and even those overlays were removed during the 2026-05-19 evening structural-override surgery (the decision Haiku no longer sees any @-mention overlay because @-mention routing is handled by the structural pre-LLM branch).~~
~~- **Why it matters:** Caused all 3 acks in the 2026-05-19 evening misfire — Dhamen's `<@Scott> <@Lou>` should have read as routing-to-humans → skip, but the decision Haiku saw a generic stuck-client question and chose `acknowledge_and_escalate` based on content alone. This is the part of the misfire that the team's "Ella responded to a message not directed at her" framing zeroes in on; the other two gaps would still fire on a message the client hadn't routed.~~
~~- **Next action:** Add a soft rule to the decision Haiku prompt that detects @-mentions of team_member users in the triggering message and defaults to skip unless the message also has other strong "Ella needed" signals. The detection can be structural (parse `<@U…>` mentions, check against `team_members.slack_user_id`) and pass as a boolean field to Haiku in the user prompt, mirroring how `is_ella_mentioned` is already plumbed. Spec required before production resume.~~
- **Logged:** 2026-05-19 (EOD; surfaced from the C0AFEC456JG misfire diagnostic). Resolved 2026-05-20.

## `getClientsList` open_action_items_count column has the same broken predicate

- **What:** `lib/db/clients.ts:183` embeds `call_action_items!call_action_items_owner_client_id_fkey(...)` in the list-page select. That FK relation only matches action items where the *client* is the assigned doer (`owner_client_id = clients.id`). Items owned by CSMs (most action items extracted from coaching calls) get dropped — same logical bug the 2026-05-13 detail-page fix (`gregory-action-items-transfer-fix`) addressed via a `calls!inner(primary_client_id)` JOIN. As a result, the `OPEN AI` column in the Clients table consistently under-counts open items per client.
- **Why it matters:** CSMs use the list count to triage. Under-counts mean clients with open work appear to have none, hiding urgency. The detail-page fix restored visibility there; the list-page count still lies until this is fixed.
- **Next action:** rewrite the list query's action-items embed to use a `calls!inner(primary_client_id)`-style JOIN instead of the FK-on-owner_client_id relation, OR drop the embed and compute the count via a separate aggregated query keyed on the client's call IDs. Likely 5-10 line change in `getClientsList`. Spec-grade once Drake decides it's worth the cycle.
- **Logged:** 2026-05-13.

## Ella audit dashboard (`/ella/runs`) — 5 follow-up fixes flagged during validation

- **What:** Drake validated the Batch 2.2 audit dashboard in production on 2026-05-11 and flagged five distinct items requiring follow-up fixes. The specific items were not enumerated in the chat session; they'll be captured here when Drake re-engages with the dashboard and writes them up. Five issues total — each gets either its own followup line below this entry, or a single bundled spec, depending on whether they cluster.
- **Why it matters:** the dashboard is shipped but has known rough edges. Without capturing the specific issues, they could get lost in the post-handoff context drop. The 5 flagged items represent the gap between "the dashboard works" and "the dashboard is ready for CSM use beyond Drake."
- **Next action:** Drake fills in the five specific items below this entry when he next engages with the dashboard. If they cluster (e.g., "filter UX issues" + "detail-view rendering bugs" + "performance"), bundle into a single fix spec. If they're independent, capture as individual followups. Either way, the gap closes when the five items are addressed.
- **Logged:** 2026-05-11.

## `/run` slash command requires `/run .` to invoke — bug

- **What:** The `/run` slash command in `.claude/commands/run.md` is designed to find the single in-flight spec under `docs/specs/` without a matching report and execute it. In practice it doesn't fire on `/run` alone or `/run ` (with trailing space); the user has to type `/run .` (with a trailing period or arg) for the command to invoke. Likely cause: the `disable-model-invocation: true` directive in the command frontmatter requires an argument for the command to be recognized as user-invoked vs. model-attempted, but the no-arg invocation path treats it as the latter and silently drops it.
- **Why it matters:** every Builder session adds friction. Drake has to remember to type `/run .` (with the trailing token) rather than `/run`, which is the more natural shape. Doesn't break anything — workaround is known — but compounds over time as the convention scales.
- **Next action:** investigate the command frontmatter. Two likely fixes: (a) remove `disable-model-invocation: true` if model-invocation isn't a real concern for this command, OR (b) make the command accept a no-arg shape by adjusting the command body to handle "no spec specified" cleanly. ~15-min Builder task once someone can read the actual Code-side slash-command runtime to understand why no-arg invocation drops. Drake mentioned in chat he has a fix queued — that note's preserved here as a hand-off pointer.
- **Logged:** 2026-05-11.

## Partial report on Builder hard stop — Builder norm not yet codified

- **What:** Today's Builder behavior on hard-stop is: surface the issue in chat to Drake (since Drake is in the loop on the Code session) and wait. If Drake walks away or aborts, there's no automatic "write what got done so far" step. The work that completed before the hard stop sits as committed code on `main`, but Director has no async-readable artifact describing it. Asymmetric with Builder's end-of-task report flow, which produces a report only when work completes.
- **Why it matters:** Director-and-Drake conversation about what to do next has to be synchronous (Drake summarizes Builder's chat output) instead of async (Director reads a partial report). Cost is real — every hard-stop incident adds Drake-summarization overhead.
- **Next action:** add a paragraph to CLAUDE.md § Director / Builder System § Builder behavior. Suggested wording: "When Builder encounters a hard stop and cannot proceed without Drake or Director input, Builder writes a partial report at `docs/reports/<slug>.md` describing what was completed (with commit hashes), what was attempted and blocked, the specific block (error message, missing schema, unresolvable ambiguity), and what input would unblock it. Then Builder exits cleanly. The partial report uses the same six-section structure as a normal report — the empty sections still get filled with explicit 'none' or 'blocked by X.'" This Builder-norm change is the integration item; the spec itself is the placeholder.
- **Logged:** 2026-05-11.

## File MCP for chat (Director side) — attempted and reverted 2026-05-11

- **What:** GitHub MCP requires Director (chat-Claude) to rewrite full files on every edit. Slow and high-token-cost on a 70KB CLAUDE.md — every small surgical change becomes a full file rewrite. Drake tried wiring a filesystem MCP (live disk access at `/home/drake/projects/ai-enablement` via Claude Desktop with a `wsl.exe -- bash -ic` wrapper) to give Director surgical-edit capability.
- **What broke:** filesystem-MCP writes land on Drake's local disk, GitHub-MCP commits land on `origin`. When Director used both in parallel (write via filesystem MCP, push via GitHub MCP), Drake's later `git pull` aborted with "local changes would be overwritten by merge" — git doesn't recognize the byte-identical match between working-tree and remote. Resolution at the time: `git checkout -- <file>` to discard the local copy, then pull. Painful, repeated multiple times in the same session.
- **Resolution:** revert. Director uses GitHub MCP only (back to the pre-filesystem-MCP state). The full-file-rewrite token cost stays, but it's mitigated structurally — the Director-writes-specs-only rule (also landed 2026-05-11) means Director never edits existing files anyway. New specs are tiny by design. Surgical editing of CLAUDE.md / runbooks / known-issues happens in Builder via the spec, where `str_replace` is cheap.
- **Revisit trigger:** if and when a file MCP for chat lands that handles the local-vs-remote race cleanly (e.g., writes directly to a non-working-tree location, or coordinates with git state) Drake can re-evaluate. No active queue.
- **Logged:** 2026-05-11 (filesystem MCP attempted and reverted same day).

## Repo-root pip-install leak — disk-only, never tracked in git (re-confirmed 2026-05-11)

- **What:** Working-tree at `/home/drake/projects/ai-enablement` currently carries ~75 pip-installed Python package directories (`anthropic/`, `pydantic/`, `openai/`, `supabase/`, `httpx/`, etc.), ~55 `.dist-info` directories, 4 loose `.so` files (`mmh3.*.so`, `_cffi_backend.*.so`, `pyroaring.*.so`, `81d243bd2c585b0f4821__mypyc.*.so`), 3 vendored single-file Python modules (`deprecation.py`, `six.py`, `typing_extensions.py`), and a root `__pycache__/`. All visible in `git status` as `??` (untracked).
- **Diagnostic signature (run the queries; expected output is empty):**
  ```
  git ls-files . | grep -E "\.dist-info/"                       # empty
  git ls-files . | grep -E "\.so$"                              # empty
  git ls-files . | grep -E "^(deprecation|six|typing_extensions)\.py$"  # empty
  git ls-files . | grep __pycache__                             # empty
  git ls-files . | grep -E "^[a-z_]+/" | awk -F/ '{print $1}' | sort -u
  # ↑ should return only legitimate tracked top-level dirs:
  # agents api app components docs ingestion lib scripts shared supabase tests
  ```
- **Why this matters (or doesn't):** the pollution is harmless to git history, deploys, and test runs. `.gitignore` (`__pycache__/`, `*.py[cod]`, `.venv/`, etc.) plus the absence of any `git add .` discipline incidents kept these files out of git entirely. `.vercelignore` + `excludeFiles: "{.next,node_modules}/**"` in `vercel.json` keep them out of Python function bundles too. The disk pollution is purely visual noise in WSL file-tree views and local `ls` output. Drake can `rm -rf` it any time without consequence.
- **Why it keeps re-appearing:** an earlier local invocation of `pip install --target .` (or wheel extraction without `--target .venv`) writes packages to the working directory by default. The 2026-05-08 Phase 3b session deleted 55 such untracked skeletons; by 2026-05-11 a fresh ~75-dir set was back, indicating another local pip operation between those dates. Prevention is "always run pip from the activated `.venv`" — but the recurrence is low-cost since none of it ever reaches git, deploys, or tests.
- **What was cleaned 2026-05-11:** under the `director-docs-topology-and-root-cleanup` spec, only the `hi` file (6 bytes, "hi bot\n") was deleted from git tracking. The spec was written assuming the pip-leak was tracked in git; the discovery queries confirmed it was not, so the bulk-deletion plan collapsed to a single-file `git rm`. The on-disk pollution itself was left alone — out of scope per the spec's "anything on disk but not tracked is out of scope" rule.
- **Detection if it ever does land in git:** run the diagnostic queries above. Any non-empty output means a `git add .` slipped past discipline and tracked something pip-shaped. Recovery: `git rm -r <offending paths>` + commit.
- **Logged:** 2026-04-29 (M3.3 era — original surface); previous sweep 2026-05-08 (Phase 3b — disk cleanup of 55 untracked pkg dirs); re-confirmed disk-only 2026-05-11 (this spec, only `hi` deleted from git).

---

Delivered. `ingestion/fathom/pipeline.py:_ensure_call_review_document` fires automatically after each successful `_ensure_summary_document` for client-category calls with a non-null `primary_client_id`. Three-layer idempotency (existence guard inside the helper + persistence-layer upsert + pipeline-layer non-atomic-but-idempotent invariant) means Fathom retries / dup deliveries / the documented F2.2 re-fire case cost zero LLM tokens. Fail-soft via try/except wrapper mirroring the M6.1 CS Slack post hook — review-generation failure never breaks Fathom delivery; failures land on `IngestOutcome.errors[]` for diagnostic visibility. `review_call` gained an optional `trigger_type` kwarg so pipeline-fired runs tag `agent_runs.trigger_type='fathom_pipeline'` distinct from `'manual_backfill'`.

## Fathom auto-review vs brain-sweep freshness — 24h-max race (accepted)

- **What:** the daily-cron freshness filter (shipped 2026-05-08) reads two timestamps for each client mid-sweep — last successful `ai_call_signal` compute + max `call_review.created_at`. If a Fathom auto-review writes a NEW `call_review` for client X AFTER the brain has read those timestamps but BEFORE the next daily sweep, that review goes invisible to the AI signal until tomorrow morning's cron fires. Bound: 24h max staleness.
- **Why it's accepted, not a bug:** the daily-cron + freshness architecture explicitly trades off this 24h window for a 300s-fitting sweep. Closing the window would require either (a) firing per-call brain recomputes synchronously inside the Fathom pipeline (kills the 60s webhook ceiling) or (b) a queue + worker (defers to V2 of the architecture). The current trade-off is documented in `agents/gregory/ai_call_signal.py`'s docstring + `docs/agents/gregory.md` § "Freshness filter" so the staleness is intentional and visible.
- **Revisit trigger:** any CSM observation that "Gregory's score doesn't reflect what I just talked about" specifically when a brand-new call review just landed AND the next sweep hasn't fired yet. If the friction surfaces, evaluate the queue+worker re-architecture vs accepting the gap.
- **Logged:** 2026-05-08 (paired with the daily-cron + freshness ship).

## `merge_clients` should migrate `client_health_scores` rows on merge

- **What:** the `merge_clients` RPC (migration 0015) reattributes `call_participants`, re-points `calls.primary_client_id`, re-points + reactivates `documents` (call_summary + call_transcript_chunk + call_review by extension), and soft-archives the source — but does NOT touch `client_health_scores`. The source client's historical health scores stay attached to the (now-archived) source `client_id`; the merged-target client gets only its own history, missing whatever signal the source accumulated pre-merge.
- **Surfaced today (2026-05-08):** Salman Rahman duplicate during V2 sweep verification — a target client whose merged-source had two V1.1 health rows that didn't migrate forward. Net effect today is small (V2 brain recomputes from current data on next freshness fire), but the merge contract is asymmetric: documents migrate, scores don't.
- **Next action:** extend `merge_clients` (or pair it with a follow-up RPC) to re-point `client_health_scores.client_id` from source to target. Consider whether to keep all source rows OR collapse to "latest source row + target rows" — the latter avoids confusing per-merge dashboard renderings showing two scores for the same calendar moment. Migration straightforward; ~5-line addition to the existing RPC body.
- **Revisit trigger:** next merge that surfaces a confusing health-score timeline OR any consumer that reads `client_health_scores` history (e.g. cohort analysis, future trend dashboard).
- **Logged:** 2026-05-08.

## Archived clients reachable via dashboard URL — UX gap

- **What:** archived clients (`archived_at IS NOT NULL`) are filtered out of the `/clients` list view via the `getClientsList` query, and `getClientById` returns null for archived rows so `/clients/[id]` 404s. BUT — direct-URL access via `/clients/<archived-client-uuid>` 404s with no breadcrumb back to the canonical row if the archive was a merge target. A reviewer arriving at a stale URL (Slack link, bookmark, calendar invite description) hits a 404 dead-end instead of being redirected to whatever the merge-target row is.
- **Surfaced today (2026-05-08):** during V2 sweep verification investigating the Salman Rahman duplicate — Drake hit a 404 on the archived source row's URL with no signal it had been merged into a canonical row.
- **Next action:** when `getClientById` finds an archived row whose `metadata.merged_into` is set, redirect to `/clients/<merged_into_id>` instead of 404'ing. ~5-line change in `app/(authenticated)/clients/[id]/page.tsx`. For archived rows without `merged_into` (true archive, not merge), keep the 404 — those URLs really do correspond to nothing canonical.
- **Revisit trigger:** any Slack-mention or bookmark-pain about 404s on previously-valid client URLs.
- **Logged:** 2026-05-08.

## Clients list `journey_stage` column sorts alphabetically (not funnel order)

- **What:** the `/clients` list table sorts the Journey stage column alphabetically by underlying value: `business_setup` → `business_setup_activation_done` → `first_closed_deal` → `first_closing_call_taken` → `prospecting` → `ten_k_month`. Funnel order would be: `business_setup` → `business_setup_activation_done` → `prospecting` → `first_closing_call_taken` → `first_closed_deal` → `ten_k_month`. The mismatch matters for at-a-glance reading when CSMs sort by stage to see "where is everyone in the funnel."
- **Why deferred:** the column is rarely the primary sort surface (default is health-score asc, worst first). Custom sort logic adds complexity for a friction that may never bite.
- **Next action:** add a per-stage funnel-position constant to `lib/client-vocab.ts` (e.g. derived from the order in `JOURNEY_STAGE_OPTIONS`) and wire `sortRows` in `app/(authenticated)/clients/page.tsx` to consult it for the journey_stage key only. ~10-line change. Other columns keep alphabetical/numeric semantics unchanged.
- **Revisit trigger:** any CSM Slack-mentioning that the journey-stage sort is confusing OR Drake noticing the order isn't useful during dashboard review.
- **Logged:** 2026-05-08.

## Gregory brain V2 weight calibration

- **What:** V2 starting weights are `ai_call_signal 0.50 + call_cadence 0.20 + overdue_action_items 0.10 + latest_nps 0.20`. Heavy-but-balanced — AI signal at half the weight, deterministic floor handles the rest. Drake's call at V2 ship is "iterate after the rubric meets reality."
- **Why it matters:** the V1.1 weights produced a 93 green / 40 yellow / 0 red distribution that overstated health (zero red was a tell). V2's daily-cron sweep distribution will tell us whether 0.50 on the AI signal is too much (one bad review tanks an otherwise-healthy client) or too little (one bad review barely moves the needle on a structurally green client).
- **Next action:** revisit after 2-3 daily sweeps with the freshness filter. Look at: (a) does the AI signal correlate with intervention decisions CSMs actually make (Slack-able to Lou for spot check)? (b) does the new tier distribution feel realistic — should we expect ~70/20/10 green/yellow/red, or is the AI signal compressing everyone toward yellow? (c) does any signal feel under-weighted (e.g. if cadence at 0.20 isn't penalizing 60+ day silences enough)?
- **Logged:** 2026-05-07.

## ~~Brain run wall-clock duration trending toward Vercel cron ceiling~~ — RESOLVED 2026-05-08

Resolved architecturally, not by ceiling bump. The V2 brain shipped with a weekly cron + 600s bump that Vercel Pro rejected; a 300s cron-bound rebaselined the watchpoint at 240s. On 2026-05-08 the cron switched **weekly → daily** AND added a **freshness filter** to `compute_ai_call_signal` — each daily sweep now only fires Sonnet for clients whose `call_review` data has changed since the last successful compute (~10 clients/day at typical velocity), instead of all 188 every Monday. Sweep duration drops from 426s+ (the timeout-killed weekly attempt observed 2026-05-08) to comfortably under 300s. See `docs/agents/gregory.md` § "Freshness filter".

**Re-watch trigger:** if any daily sweep ever crosses 240s (80% of 300s), revisit. At that point the AI signal's per-client cost has grown faster than the freshness skip rate can offset — likely cause is reviews-per-client growing past 1-2 per 30-day window, which makes single-Sonnet-call payload size blow up. Decision matrix at that point: (a) Vercel plan upgrade, (b) parallelize the per-client loop, (c) move the AI signal to a separate weekly job that updates `factors.signals` post-hoc. SweepResult.duration_ms continues to be the gauge; INFO log line continues to surface it in cron logs.

## Index on agent_runs trigger_metadata.client_id when ai_call_signal volume grows

- **What:** the daily-cron freshness filter (shipped 2026-05-08) reads "last successful ai_call_signal compute timestamp for client X" via `SELECT max(started_at) FROM agent_runs WHERE agent_name='ai_call_signal' AND status='success' AND trigger_metadata->>'client_id' = X` — a jsonb-key filter without an index. Today's scale (~500 ai_call_signal rows total) makes this fine; PostgreSQL filters fast against a small table.
- **Why it matters:** at ~10 clients/day adding ai_call_signal rows on the compute path + ~178 clients/day adding skip-path rows, daily growth is ~190 rows/day. At ~6 months of operation, table will be ~35k rows. Per-client freshness queries on every sweep iterate ~188 clients × 1 query each = 188 jsonb scans per sweep — at 35k rows each, total per-sweep scan cost grows linearly.
- **Next action:** add a partial index `CREATE INDEX agent_runs_ai_call_signal_client_idx ON agent_runs (agent_name, status, (trigger_metadata->>'client_id')) WHERE agent_name='ai_call_signal' AND status='success'` when the row count crosses ~5000. Migration straightforward; no schema change needed.
- **Revisit trigger:** `SELECT count(*) FROM agent_runs WHERE agent_name='ai_call_signal'` exceeds 5000, OR sweep duration trends upward in a way that correlates with table growth.
- **Logged:** 2026-05-07.

## Index on agent_runs trigger_metadata.triggering_slack_channel_id when passive volume grows

- **What:** the firm-after-first gate in `agents/ella/passive_monitor.py:_firm_after_first_match` reads "recent passive runs in channel X that escalated" via `SELECT ... FROM agent_runs WHERE agent_name='ella' AND trigger_type='passive_monitor' AND started_at >= cutoff` then filters on `trigger_metadata->>'triggering_slack_channel_id'` in Python after a date-range filter. Today's scale (zero passive runs at ship) makes this trivial.
- **Why it matters:** at 100+ passive runs/day per channel × 8 active channels, daily growth is ~800 passive_monitor rows. At 6 months the per-channel filter scans ~150k rows. Mirrors the `ai_call_signal` index entry above; same pattern.
- **Next action:** add a partial index `CREATE INDEX agent_runs_passive_monitor_channel_idx ON agent_runs (started_at, (trigger_metadata->>'triggering_slack_channel_id')) WHERE agent_name='ella' AND trigger_type='passive_monitor'` when the row count for that filter crosses ~5000. Migration straightforward.
- **Revisit trigger:** `SELECT count(*) FROM agent_runs WHERE agent_name='ella' AND trigger_type='passive_monitor'` exceeds 5000, OR firm-after-first gate latency surfaces in cron run-times.
- **Logged:** 2026-05-11.

## Passive Haiku prompt — thresholds + categories will need iteration

- **What:** Batch 2.3 ships with Builder-chosen defaults: KB-relevance threshold 0.3, firm-after-first keyword overlap >= 3 content words, Haiku auto-escalate fence covering billing / complaints / advice / emotional / prompt-injection / CSM-directed. Real misses + misfires only surface against production traffic.
- **Why it matters:** wrong thresholds = either too much skip (Ella missing helpable moments) or too much misfire (Ella interjecting where she shouldn't). The audit dashboard at `/ella/runs` surfaces every decision with reasoning; Drake reviews post-launch.
- **Next action:** after the first ~50-100 production passive decisions, review the `/ella/runs` flagged-anomaly view, identify miss / misfire patterns, iterate (`_HAIKU_SYSTEM_PROMPT` and / or `_DEFAULT_KB_RELEVANCE_THRESHOLD` constants in `agents/ella/passive_monitor.py`). Document the iteration history in `docs/agents/ella/ella.md` § Eval Criteria once the eval set bootstraps.
- **Revisit trigger:** post-rollout to `#ella-test-drakeonly`, after 1-2 weeks of decisions accumulated.
- **Logged:** 2026-05-11.

## Call Review V1 has no eval coverage

- **What:** `agents/call_reviewer/` has unit tests covering JSON parse + persistence shapes, but no eval coverage of output quality (does the model surface real pain_points / wins / dodged_questions, or hallucinate / pad / miss obvious signals?). May 2026 backfill produced 31 reviews (smoke + apply); spot-checking is the only quality gate today.
- **Why it matters:** prompt iteration without an eval is iteration in the dark. Once CSMs start using the surface and we get signal on what's wrong (over-flagging dodged questions, under-flagging real pain, generic sentiment_arc), an eval gives us a regression net for tuning.
- **Next action:** add a golden-set eval when output quality becomes an iteration bottleneck (target: 10-20 hand-graded reviews across the call texture, programmatic checks for "does the model find pain points the human grader marked," etc.). Not blocking V1 ship.
- **Logged:** 2026-05-07.

## Promote `call_review` exclusion into `match_document_chunks` SQL function

- **What:** `agents/call_reviewer/persistence.py` writes documents rows with `is_active=False` as the V1 retrieval-side safety net — `match_document_chunks` only returns `is_active=true` rows, so review docs never leak into Ella's retrieval. The SQL function's explicit client-scoped-type exclusion list (`call_summary` / `call_transcript_chunk`) does NOT include `call_review` because the `is_active=false` write-time invariant is sufficient at V1.
- **Why it matters:** the safety gate disappears the moment anything sets `is_active=true` on a review row. V2 will wire review generation into the Fathom ingestion pipeline (likely with a per-call ingest hook), and at that point a small mistake — copy-pasting the summary's `is_active=true` line into the review's INSERT — would silently leak reviews into retrieval. Promote the exclusion into the SQL function via migration so the gate lives in the database, not in caller discipline.
- **Next action:** when V2 generation lands (or before, if anyone else touches the persistence layer): add a migration that extends `match_document_chunks` to also exclude `document_type='call_review'` from global-mode results, and update `docs/ingestion/metadata-conventions.md` §7 in the same commit.
- **Logged:** 2026-05-07.

## Cron auth: all Vercel crons share one project-level CRON_SECRET

- **What:** all Vercel cron endpoints in this project share a single `CRON_SECRET` env var (Vercel project-level convention; Vercel sends this as the `Authorization: Bearer <token>` regardless of which cron entry fires). The env var name is fixed by Vercel's cron infrastructure — not configurable via `vercel.json` or anywhere else. Confirmed empirically during the M6.1 401 saga: a per-cron-namespaced token convention was tried earlier (`FATHOM_BACKFILL_AUTH_TOKEN`, `GREGORY_BRAIN_CRON_AUTH_TOKEN`, `ACCOUNTABILITY_NOTIFICATION_CRON_AUTH_TOKEN`) and required operators to keep `CRON_SECRET` in sync with the custom token, which silently failed at the M6.1 deploy. Refactored to single-source-of-truth in M6.2.
- **Why it matters:** independent per-cron rotation is **NOT supported by Vercel**. Rotating `CRON_SECRET` rotates auth for every cron in the project simultaneously. If a use case ever surfaces requiring true independence (e.g., a third-party caller who shouldn't be able to trigger ALL crons by knowing one secret, or a per-cron rotation cadence the org needs to maintain for compliance reasons), the codebase would need a separate auth surface — likely a per-cron HMAC-signature scheme or a per-cron API gateway in front of the function. Not solvable via env var naming.
- **Next action:** none today. Logged as a constraint to remember when designing future cron endpoints. If Drake adds a new cron, just point its `_verify_auth` at `CRON_SECRET` like the existing three. If a third-party trigger becomes a real requirement, design a separate auth path (this followup is the prompt to remember the constraint).
- **Logged:** 2026-05-06 (M6.2 cron-auth consolidation refactor surfaced the architectural finding via the M6.1 401 diagnosis).

## NPS harness fixture (`Branden Bledsoe`) was archived 2026-05-05

- **What:** `scripts/test_airtable_nps_webhook_locally.py` uses Branden Bledsoe (`brandenbledsoe@transcendcu.com`) as the test fixture for happy-path NPS update probes. Branden was soft-archived 2026-05-05 in the M5 misclassified-client cleanup (he was Isabel Bledsoe's representative, not a real client). The NPS receiver's `update_client_from_nps_segment` RPC filters on `archived_at IS NULL`, so any harness call against Branden now hits the 404 "no active client matches email" path rather than the happy update path. Discovered while writing the M5.9 onboarding harness — that harness initially mirrored the NPS pattern and surfaced the same break.
- **Why it matters:** the NPS harness will start failing on tests 1 and 2 (the two happy paths). Tests 3–8 are negative paths and stay green. CI doesn't run the harness, so silent breakage is the realistic failure mode — Drake or someone running the harness manually will hit it.
- **Next action:** refactor the NPS harness to use a self-seeded fixture (mirror M5.9's pattern in `scripts/test_airtable_onboarding_webhook_locally.py`: per-run unique email, hard-deleted in cleanup, no reliance on production data). One ~30-minute change. Alternatively pick a different stable client, but self-seeding is the more robust fix and matches the new convention.
- **Logged:** 2026-05-05 (M5.9 onboarding receiver build surfaced this).

## Country filter on /clients silently misses non-USA/AUS payload values

- **What:** the M5.7 Country filter dropdown on `/clients` sources its options dynamically from `clients.country` distinct values (USA / AUS / null today). The M5.9 onboarding receiver passes the form's `country` field through to the column as-is, with no validation against a vocab. If Zain's onboarding payload ever sends a value outside `'USA'`/`'AUS'` (e.g. `'United States'`, `'Australia'`, `'UK'`, free-text variants), that client lands in the DB with the new value — then the filter dropdown surfaces it as a separate option, and any pre-existing filter URL bookmarked on `?country=USA,AUS` will silently miss the new client.
- **Why it matters:** the failure mode is "client doesn't appear under a filter the CSM expected to be exhaustive" — soft, not loud. CSMs may not realize their saved-filter view is incomplete. Compounds if multiple variant strings accumulate.
- **Next action:** revisit if it surfaces. Two paths: (a) add a CHECK constraint on `clients.country` enforcing the canonical short codes (USA / AUS / future codes), and have the receiver normalize at the boundary; (b) leave the column free-text but add a normalization layer in the receiver (`country.upper().strip()` plus a known-aliases map: "United States" → "USA", "Australia" → "AUS"). Lean: (b) — cheaper, doesn't require a migration, accommodates future Zain-side CSV drift.
- **Logged:** 2026-05-05 (M5.9 onboarding receiver build).

## Fathom classifier false-positive: hiring interview classified as client

> **Batch D framing:** address only if CSM titling discipline doesn't suppress this pattern; otherwise leave.

- **What:** Andy Gonzalez (DB row was `Andrés González` / `andy@thecyberself.com`) was a hiring-interview series — Scott interviewed him as a potential teammate, NOT a sales prospect. Fathom's classifier auto-created him as a client and tagged 3 calls as `category='client'` because the conversation pattern (1:1 with Scott, professional tone, sales-flavored discussion of work and engagement) matched the client heuristic. Resolved 2026-05-05 via `scripts/archive_misclassified_clients.py` — 3 calls reclassified to `external`, client soft-archived with `metadata.misclassification_type='external_hiring'`.
- **Why it matters:** any Scott-led interview (hiring, podcast guest prep, reverse pitches from vendors) is at risk of the same false-positive. Cost is low (false-positive client rows in Gregory) but pollutes counts and triggers Path 2 outbound roster inclusion if not caught. With the M5.6 cascade, a wrongly-active false-positive client also sits in active counts until manually status-flipped.
- **Next action:** track recurring instances. If 3+ surface in the next quarter, classifier needs a "hiring/recruiting context" signal — could be heuristic (`participant_email_domain` is on a known external recruiting domain, conversation contains words like "interview", "compensation", "benefits") or a re-prompt of the LLM call to consider non-client-but-1:1-with-Scott patterns explicitly. Until then: periodic spot-checks of `clients` rows where `category='client'` calls have been auto-created and the participant is unfamiliar to Scott.
- **Logged:** 2026-05-05 (M5 misclassified-client archive sweep).

## Fathom classifier false-positive: representative-of-existing-client

> **Batch D framing:** address only if CSM titling discipline doesn't suppress this pattern; otherwise leave.

- **What:** Branden Bledsoe joined Isabel Bledsoe's offboarding call as her representative (likely her husband — she had Branden handle the contract review on her behalf). Fathom didn't recognize the relationship and auto-created Branden as a separate client when his email/name appeared as the non-Scott participant. Resolved 2026-05-05 via `scripts/archive_misclassified_clients.py` — 1 call's `primary_client_id` repointed to Isabel; Branden's row soft-archived with `metadata.misclassification_type='representative_of_other_client'` + `rerouted_to_client_id=<Isabel's UUID>`.
- **Why it matters:** every churned-or-leaving client where a spouse / business partner / lawyer / accountant joins a final call is the same shape. Real client conversation; wrong primary attribution. The autocreate clutters Gregory with false rows and breaks downstream client-of-record analytics.
- **Next action:** classifier needs context awareness — "is this participant talking on behalf of an existing Gregory client based on shared last name + conversation context (referring to the existing client by name, using 'her account', 'on Isabel's behalf')?" For V1 a simpler heuristic: if a new auto-created client shares a last name with an existing active client AND the call has only 1 non-Scott participant, flag for review rather than auto-creating. Doesn't catch all cases but catches the common spousal-rep pattern. Track recurring instances meanwhile.
- **Logged:** 2026-05-05 (M5 misclassified-client archive sweep).

## Fathom ingestion: Apple iMIP @imip.me.com email duplicate-create

> **Batch D framing:** address only if CSM titling discipline doesn't suppress this pattern; otherwise leave.

- **What:** Robert Traffie had a duplicate Gregory row created from a calendar invitation routed through Apple's iMIP service — the participant email was `2_<long-token>@imip.me.com` rather than his real personal email. Fathom's resolver didn't recognize this as a forwarding/relay address and created a fresh client row with the iMIP email as primary. Surfaced during the 2026-05-05 needs_review walkthrough; merged via `merge_clients` RPC during that walkthrough.
- **Why it matters:** any iCloud user who accepts a calendar invite from another platform (Outlook, Google, etc.) routes the RSVP through `@imip.me.com`. Recurring pattern for Apple-using clients. Each duplicate auto-create is one more row to merge manually.
- **Next action:** Fathom ingestion classifier should detect the `@imip.me.com` domain and either: (a) skip auto-create entirely on iMIP-only emails, leaving the call with an unresolved participant flag for human review, or (b) auto-merge to an existing-by-name client when the rest of the participant context (full name + concurrent participants) makes the link obvious. (b) is preferable for ergonomics; (a) is simpler. Same fix likely applies to other relay domains (Outlook proxy addresses, Google Calendar generated UIDs that show up as emails, etc.).
- **Logged:** 2026-05-05 (M5 needs_review walkthrough — Robert Traffie merge).

## needs_review tag doesn't auto-clear after manual reconciliation

- **What:** the M3.2 auto-create flow tags new clients with `tags @> ['needs_review']` so the dashboard surfaces them in the Needs Review filter. After Drake reconciled ~13 clients during the 2026-05-05 walkthrough (canonical match confirmed via dashboard merge or simple eye-on-row inspection), the tag had to be manually cleared. No automatic detag on confirm-canonical / merge / primary_csm-assignment / inline-edit.
- **Why it matters:** the Needs Review filter accumulates resolved cases over time and stops being a useful triage queue. CSMs see a stale list and ignore it because most of it is already-handled.
- **Next action:** add automatic tag removal on three trigger events: (a) any call to `merge_clients` RPC (the source row gets archived; the target keeps the tag if it had one — auto-clear if it does); (b) any call to `change_primary_csm` RPC (assigning a primary CSM to a needs_review client implies it's been confirmed and routed); (c) any inline-save via `updateClient` that touches a "real" field (status, csm_standing, notes, etc., as opposed to just a tag edit). All three are RPC- or function-level — single line in each. Or alternatively: add a tracker job that periodically clears the tag on clients with primary_csm assigned + at least one client_status_history row (i.e., touched by a CSM).
- **Logged:** 2026-05-05 (M5 needs_review walkthrough — manual detag pattern observed across 13 clients).

## Signup date timezone display offset (renders 1 day early across all clients)

- **What:** every Gregory client's `start_date` (master sheet's `Date` column) renders one calendar day earlier than the CSV's value across the dashboard. Confirmed across 191+ clients during 2026-05-05 walkthrough — universal pattern. The CSV stores `M/D/YYYY`; `clients.start_date` is a `date` type; the dashboard renders via `Date.toLocaleDateString` or similar that interprets the stored value with timezone-aware locale shift. Drake is in UTC-7; storing `2026-04-23` and rendering it in UTC-7 produces `Apr 22` because the implicit midnight-UTC gets backshifted.
- **Why it matters:** cosmetic but trust-undermining — every client looks like they signed up the day before they actually did. A CSM checking the dashboard against a calendar invite sees a 1-day discrepancy and starts to distrust other dates too. Compounds for clients near month/quarter boundaries.
- **Next action:** display-layer fix only — DB stores correct date. Either: (a) parse as date-only via `new Date(value + 'T00:00:00')` to anchor to local midnight before formatting; (b) use a date-only formatter that doesn't apply timezone shift (e.g. `format(parseISO(value), 'MMM d, yyyy')` from date-fns); (c) explicit `{timeZone: 'UTC'}` option to `Intl.DateTimeFormat`. Cheapest fix is (c) on every `Date.toLocaleDateString` call site that handles a column typed as `date`. Audit all call sites in `app/(authenticated)/clients/[id]/` and `components/client-detail/`.
- **Logged:** 2026-05-05 (M5 needs_review walkthrough — universal pattern confirmed across 191+ clients).

## Aman's pre-team-email period — full_name "Aman Ali" + alternate email backfill

- **What:** Aman is now on `team_members` but his old call (2026-04-19, "30mins with Scott (Aman Ali)") was made before his team_members row existed, with a personal email (`amanxli4@gmail.com`) Fathom auto-created as a client row. The cleanup script (2026-05-05) reclassified the call to `internal` and archived the auto-created client row. Two follow-ups feed off this: (1) the call title `30mins with Scott (Aman Ali)` confirms Aman's full last name is **Ali** — `team_members.full_name` should read "Aman Ali" not just "Aman" (or whatever the current value is); (2) `amanxli4@gmail.com` should be added to Aman's team_members row's `metadata.alternate_emails` (or equivalent — team_members schema may not yet have alternates) so future calls/messages from that email auto-classify as internal without going through the misclassification → archive cycle again.
- **Why it matters:** without the backfill, any future call from Aman's old email re-triggers the same misclassification. Without the full_name fix, dashboard listings show "Aman" instead of "Aman Ali" and any name-based linkage (like the master sheet reconcile's name-fallback resolution) won't match cleanly.
- **Next action:** (1) inspect `team_members` schema — confirm there's an alternate-email storage path. If not, add a `metadata.alternate_emails` jsonb pattern mirroring the `clients` shape, and update the Fathom classifier to consult it. (2) Update Aman's row: `UPDATE team_members SET full_name = 'Aman Ali', metadata = metadata || jsonb_build_object('alternate_emails', jsonb_build_array('amanxli4@gmail.com')) WHERE full_name ILIKE 'Aman%' AND archived_at IS NULL;` — verify the row resolves to a single match before applying.
- **Logged:** 2026-05-05 (M5 misclassified-client archive — full_name surfaced in call title).

## Cleanup completeness — 4 N/A clients autocreated as churned (forensics flag)

- **What:** the M5 completeness pass (2026-05-04) autocreated 4 USA clients whose master sheet status was `N/A` — Vaishali Adla, Scott Stauffenberg, Clyde Vinson, Rachelle Hernandez. Per spec, `N/A` was coerced to `status='churned'` and the literal CSV string preserved on `metadata.original_master_sheet_status='N/A'`. These rows are discoverable via SQL: `SELECT * FROM clients WHERE metadata->>'original_master_sheet_status' = 'N/A';`. Mishank (AUS) also autocreated with `original_master_sheet_status='Churn (Aus)'` (real Churn, not N/A).
- **Why it matters:** `N/A` status in the master sheet is Scott's "I don't know what to do with this client" sentinel. Coercing to churned was Drake's call so they don't pollute Active counts and don't trigger the cascade weirdly. If Scott later wants to revive any of them, the metadata string surfaces the original ambiguity so the dashboard can show "this was N/A — you flipped it to active intentionally?".
- **Next action:** ad-hoc — surface these 4 in Scott's onboarding meeting (under Bucket A of `docs/data/m5_cleanup_scott_notes.md`). If Scott wants any reactivated, manual dashboard flip + the metadata string remains as historical context. If Scott wants the metadata cleaned up later, one-line SQL to remove the key.
- **Logged:** 2026-05-04 (M5 completeness pass).

## Master sheet CSV canonical location

- **What:** Going forward, drop fresh master sheet exports under `data/master_sheet/master-sheet-<MM-DD>/`. `cleanup_master_sheet_reconcile.py` and `cleanup_master_sheet_completeness.py` both default to that location. Prior `/mnt/c/Users/drake/Downloads/` defaults pointed at stale Windows-side downloads — the canonical export superseded that, and the script's path constants are now repointed in-repo.
- **Why it matters:** if a future cleanup pass needs the CSVs, the in-repo location keeps the source-of-truth co-located with the script that consumes it. The `master-sheet-<MM-DD>` subdirectory naming captures "as of which date" for forensics — comparing two exports across a few days surfaces what Scott edited in between.
- **Next action:** when a fresh export is needed, drop `Financial MasterSheet (Nabeel - Jan 26) - USA TOTALS.csv` and `Financial MasterSheet (Nabeel - Jan 26) - AUS TOTALS.csv` (note: spaces + parens in filenames are correct) into a new `data/master_sheet/master-sheet-<MM-DD>/` directory. If the directory naming convention changes (e.g., Scott renames the spreadsheet), update the script's `DEFAULT_USA_CSV` / `DEFAULT_AUS_CSV` constants in `cleanup_master_sheet_reconcile.py`. The completeness script imports those constants so a single edit covers both.
- **Logged:** 2026-05-04 (path repoint during the M5 delta + completeness pass).

## Cleanup pass — toggle re-activation for positive-status transitions

- **What:** the M5 master sheet reconcile (2026-05-04) fired status flips going positive (`ghost→active` or `paused→active`) for 2 clients (Marcus Miller, Allison Jayme Boeshans) and possibly more in future runs. The M5.6 cascade is **one-directional** (off-only) — when those clients moved INTO negative status earlier, `accountability_enabled` and `nps_enabled` got flipped to false, and the cascade does NOT auto-revert on positive transitions. So Marcus Miller is now active but `accountability_enabled=false, nps_enabled=false`. Allison Jayme Boeshans appears to have been manually flipped back to true at some point.
- **Why it matters:** an active client with accountability/nps automation off won't get DMs, nudges, or NPS surveys. If Scott expects these clients to receive automation, the toggles need a manual flip or the cleanup script needs a "positive-transition toggle reset" pass.
- **Next action:** two paths. (a) Add a "positive-transition toggle reset" subsection to `scripts/cleanup_master_sheet_reconcile.py` that flips toggles to true when status goes from negative → active. Risk: makes the apply less idempotent (re-running might flip something Scott explicitly wants off). (b) Surface positive-transition clients in scott_notes Bucket B with their current toggle state and let Scott decide per-client. Lean: (b) — keeps the cleanup script's "respect Scott's explicit CSV values" semantics intact.
- **Logged:** 2026-05-04 (M5 master sheet reconcile — Marcus Miller + Allison Jayme Boeshans surfaced this).

## Cleanup pass — Matthew Gibson is in CSV but not Gregory

- **What:** Matthew Gibson (USA row 180, email `leandeavor@gmail.com`, owned by Nico) is on Scott's master sheet as an active client AND is one of the handover-note targets per Scott's morning message. He doesn't exist in Gregory yet (handover note couldn't apply to him; surfaced to scott_notes A6 + A9). 7 other unmatched-with-email or unmatched-without-email CSV rows are similar candidates — see scott_notes A9 + A10.
- **Why it matters:** these clients are operationally real but invisible to Gregory. Scott's daily Gregory review will miss them. Path 2 outbound roster also doesn't include them.
- **Next action:** for each unmatched-with-email row (Matthew Gibson, Anthony Huang, Melvin Dayal): confirm with Scott whether to create or whether they're duplicates of an existing Gregory client (then add to alternate_emails). For unmatched-without-email rows (5 clients): Scott decides per row. Once Matthew Gibson is created, re-run the cleanup script — the handover-note append is idempotent and will pick him up.
- **Logged:** 2026-05-04 (M5 master sheet reconcile A6/A9/A10).

## Cleanup pass — re-run cadence + idempotency monitoring

- **What:** `scripts/cleanup_master_sheet_reconcile.py` is designed to be re-run as Scott edits the master sheet. The first run (2026-05-04) made 95 explicit DB writes touching ~70 unique clients. Idempotency is achieved per-RPC (no-op when unchanged), per-trustpilot (UPDATE only when value differs), and per-handover-note (gate on literal-text-not-present). But each re-run does fire the cascade trigger for any negative-going status transition that's already true, writing a fresh `client_standing_history` row attributed to Gregory Bot with `cascade:status_to_<status>:by:<gregory-bot-uuid>`. Documented intentional in M5.6, but worth knowing if scanning history.
- **Why it matters:** if Scott's master sheet stops drifting (Path 2 outbound landed yesterday, so Gregory ↔ Make.com automation is closing the loop), this script becomes a periodic sanity check. If it stays drift-y because Scott still edits the master sheet manually, the script becomes a regular sweep tool. Either way: the audit trail builds up `cleanup:m5_master_sheet_reconcile` history rows over time.
- **Next action:** decide cadence after a few runs. Options: (a) ad-hoc when Scott sends a "match Gregory to my sheet please" Slack, (b) weekly cron (would need a Vercel function wrapper or Make.com trigger), (c) deprecate the script entirely once Path 2 + future Path 3-equivalent loops close all the holes. Lean: (a) until the next two cleanup-pass uses tell us whether (b) or (c) is right.
- **Logged:** 2026-05-04 (M5 master sheet reconcile first run).

## Path 2 outbound — slack_channels staleness vs Slack-side archive state

- **What:** the endpoint trusts our `slack_channels.is_archived` column. We have no reconciler that updates that flag when a channel is archived on Slack's side. A channel archived in Slack but still `is_archived=false` in our table will surface a `slack_channel_id` Make.com then fails to post to (Slack API returns `channel_not_found` or similar).
- **Why it matters:** undetected drift = Make.com automation silently failing to deliver to specific clients, with the failure logged on Make.com's side rather than ours. Likely rare today (channels don't get archived often) but the gap is real.
- **Next action:** either (a) add a reconciler that periodically checks Slack `conversations.info` for each non-archived `slack_channels` row and flips `is_archived=true` on Slack-archived channels, OR (b) accept the drift and let Make.com surface "channel not found" failures back to Drake/Zain operationally. (b) is the V1 stance. Trigger to revisit: any reported case of accountability/NPS automation failing to deliver to a specific client.
- **Logged:** 2026-05-04 (Path 2 outbound ship — V1 carve-out, deferred).

## Client→Slack-identity coverage gap — 60 of 188 non-archived clients filtered from Path 2 roster

- **What:** Path 2's deploy-time numbers showed 100 actionable / 195 non-archived = 95 filtered server-side. After M5 cleanup + M5.7 ship the count is 128 / 188 = 60 filtered. Of those 60, the breakdown is some combination of: NULL `clients.slack_user_id`, no row in `slack_channels` matching the client, and (rarely) NULL `clients.email`. CLAUDE.md's prior per-message coverage note (`~94 of 2,914 messages from unknown authors`) is a different angle on the same underlying gap.
- **Why it matters:** these clients can't be acted on by Make.com's accountability or NPS automation until their Slack identity resolves. If most are paused/leave/churned, the gap is mostly cosmetic; if meaningful chunks are active clients, Scott will notice missing rows on his daily check.
- **Next action:** triage SQL — count the 60 by `status`. If active count is meaningful, build a one-shot resolver: hit Slack `users.lookupByEmail` per unresolved `clients.email`, populate `slack_user_id` on hits.
- **Logged:** 2026-05-04 (Path 2 outbound deploy — surfaced the per-client view of an existing gap).

## EditableField `<select>` missing id/name/htmlFor — a11y gap

- **What:** the `<select>` rendered by `components/client-detail/editable-field.tsx` (renderEditor's enum / three_state_bool branch, around lines 280-305 of the post-hotfix file) has no `id` or `name` attribute, and the `<Label>` rendered above it at line ~197 has no `htmlFor` linking the two. Same gap exists on the text/textarea/integer/numeric/date `<Input>` and `<Textarea>` variants. Surfaced during the M5.6 hotfix diagnosis when Drake noticed browser dev tools warning about un-labeled form fields; ruled out as a cause of Bug 1 (silent-click bug) but the a11y problem is real.
- **Why it matters:** screen readers can't announce field labels reliably. Browser autofill heuristics rely partly on `name`/`id` to recognize fields. Form validation tooling (and tests) that reference fields by name don't work. None of these are V1-blocking — the dashboard is internal-only with no screen-reader users today — but the gap will bite the moment Gregory ships beyond the agency.
- **Next action:** thread a stable per-instance id from the `EditableField` props down to the input element and to the `<Label htmlFor=...>`. Either (a) generate via `useId()` if React 18+ is in scope (it is — check `package.json`), or (b) take an `id` prop and have call sites pass slugged labels (e.g. `id="client-status"` for the Status field). Option (a) is more idiomatic and zero-config at call sites. Sweep all input variants in the same pass: `<select>` (line ~280), `<Input>` (line ~349), `<Textarea>` (line ~248). ~20-line refactor; no behavior change. Worth bundling with any other EditableField change.
- **Logged:** 2026-05-04 (M5.6 hotfix surface — diagnosis ruled out as cause of Bug 1 but the underlying a11y issue stands).

## M5.6 silent-toggle backfill — 17 clients flipped accountability/nps without history row

- **What:** the M5.6 migration 0022 backfilled `accountability_enabled` and `nps_enabled` to `false` on 82 negative-status clients. 65 of them got a `cascade:backfill:m5.6` row in `client_standing_history` (those whose `csm_standing` flipped from a non-`at_risk` value or NULL). The other 17 already had `csm_standing='at_risk'` from prior CSM judgment / master-sheet seed, so the backfill flipped the toggles without writing a history row — `csm_standing` didn't change, so the history insert (which is keyed on csm_standing transitions) had nothing to write. There is no `client_accountability_history` / `client_nps_enabled_history` table in V1 either, so the toggle change for these 17 is invisible in the audit trail.
- **Why it matters:** if a CSM later asks "why is accountability off for client X?" and X is one of the 17, the only signal is the migration commit message + this entry. Most queries against the audit trail (e.g. the cascade-attribution query in `docs/schema/client_standing_history.md`) won't surface them. Static snapshot of the 17 client IDs is preserved at `docs/data/m5_6_silent_toggle_backfill.md`.
- **Next action:** if Path 2 audit requirements OR a CSM workflow demands a per-toggle history table, build `client_accountability_history` and `client_nps_enabled_history` (mirror `client_status_history`'s shape: `id, client_id, value boolean, changed_at, changed_by, note`). Backfill from `webhook_deliveries` (post-Path-2 records) plus the 17-client snapshot above. Not urgent — V1 doesn't need toggle-level audit yet.
- **Recovery SQL — identify the silent-toggle 17 post-hoc.** This query mirrors the snapshot file's set as long as none of the 17 has had `csm_standing` cleared+re-set OR a CSM has manually flipped the toggles back on:
  ```sql
  select c.id, c.full_name, c.status, c.csm_standing,
         c.accountability_enabled, c.nps_enabled
  from clients c
  where c.archived_at is null
    and c.status in ('ghost','paused','leave','churned')
    and c.csm_standing = 'at_risk'
    and c.accountability_enabled = false
    and c.nps_enabled = false
    and not exists (
      select 1 from client_standing_history csh
      where csh.client_id = c.id
        and csh.note = 'cascade:backfill:m5.6'
    )
  order by c.status, c.full_name;
  ```
  Cross-check against `docs/data/m5_6_silent_toggle_backfill.md` — divergence means one of: (a) a client had csm_standing cleared and re-set (creating a real history row, removing them from this query's set), (b) a CSM has manually flipped a toggle back to true (the row no longer matches the toggle filter), or (c) a future cascade re-fire wrote a fresh history row. All three are expected lifecycle outcomes; the snapshot file is the immutable "as of M5.6 apply" reference.
- **Logged:** 2026-05-04 (M5.6 close-out — 17 silent toggles accepted per Drake's (a)+(d) call instead of building toggle-level history tables now).

## STATUS_DEFAULT_SELECTED duplicated across client/server boundary

- **What:** the M5.5 filter bar's default-status trio (`['active','paused','ghost']`) is hard-coded twice — once in `app/(authenticated)/clients/filter-bar.tsx` (Client Component, used to pre-check the Status dropdown when the URL param is absent) and once in `app/(authenticated)/clients/page.tsx` (Server Component, used by `readFilters` to inject the same default into the DB query). Both copies are identical; neither imports from the other because the `'use client'` boundary made a shared module path awkward at M5.5 ship time.
- **Why it matters:** if the default trio ever changes (e.g. Scott decides Ghost shouldn't be on by default, or Leave should be), two files need editing. Drift between them produces a silent UX bug — the dropdown UI shows one default while the server query applies a different one, and a fresh page load looks like the filter is "checked but ignored."
- **Next action:** extract to a third file like `lib/clients-filter-defaults.ts` (or fold into `lib/client-vocab.ts` since it's adjacent to the status vocab). Both call sites import the constant. ~5-line refactor, zero behavior change. Worth doing alongside any future filter-default tweak; not urgent on its own.
- **Logged:** 2026-05-03 (M5.5 close-out — intentional defer at ship time).

## ~~NPS backfill — 4 manual-override-sticky divergences worth Scott discussion~~ — RESOLVED 2026-05-08

Resolved by NPS-is-gospel migration 0027. The four "manual judgment trumps NPS" cases (Tina Hussain / Jenny Burnett / Mary Kissiedu / Saavan Patel — all where Scott's read was harsher than the segment) are no longer divergences; on the next NPS submission for each, the segment auto-derives `csm_standing` and overwrites the manual value. Saavan Patel's `'problem'` → `'at_risk'` flip was specifically called out in the 0027 dry-run as the one structural edge case; Drake confirmed master-sheet-seed origin (no human judgment behind it) before commit. Net effect: NPS is now the source of truth for `csm_standing` and any harsher-than-NPS judgment a CSM wants sticky must use `csm_standing='problem'` (the only value that has no segment mapping).

## ~~Master-sheet-import seed treatment for auto-derive eligibility~~ — RESOLVED 2026-05-08

Resolved by NPS-is-gospel migration 0027. The architectural question "should master-sheet-seed `csm_standing` values be auto-derive-eligible?" was effectively answered by removing the gate entirely — every NPS submission now overwrites `csm_standing` regardless of `changed_by` provenance. The 137 master-sheet-seed clients that were "sticky forever" under override-sticky are no longer locked; on their next NPS submission, the segment auto-derives. Drake's NPS-is-gospel decision is path (a) from this followup's two-path framing ("treat master-sheet-seed as auto-derive-eligible") via the simpler-than-anticipated route of dropping the gate entirely rather than retroactively rewriting history rows' `changed_by` attribution.
- **Logged:** 2026-05-03 (M5.4 backfill — exposed the structural implication).

## Airtable NPS Clients name whitespace hygiene

- **What:** multiple rows in Airtable's NPS Clients table have leading/trailing/double whitespace in the Name field — e.g. `' Javier Pena'`, `' Vid'`, `' Marcus Miller'`, `'Edward  Molina'`, `'Jerry Thomas '`. Spotted during the M5.4 backfill dry-run; the script logs them with the exact whitespace preserved.
- **Why it matters:** doesn't affect email-based matching (the receiver's RPC lookup uses `clients.email`, not `clients.full_name`) and doesn't affect Gregory data quality directly. But the Airtable side is messier than ideal — name-based lookups, future Airtable formulas that cross-reference Names, and any human reading the table get noise.
- **Next action:** Airtable-side hygiene pass — Drake or Zain trims whitespace on the affected rows. Or: an Airtable automation that runs `TRIM()` on Name field changes. Low-priority operational hygiene.
- **Logged:** 2026-05-03 (M5.4 backfill dry-run output).

## Receiver-broken-diagnosis — two-step pattern for "is the function actually live?"

- **What:** when a Vercel serverless function appears broken (HTML response on GET instead of friendly JSON, 404 on POST, etc.), there's a two-step diagnostic that catches >90% of cases before deeper investigation: **(1)** `git log origin/main..HEAD` to confirm no unpushed local commits — Code's commits land in local-only state until pushed, and a deploy can't include code that isn't on origin yet. **(2)** Vercel deployment Functions tab — confirm the function actually appears in the build. If absent, either `vercel.json`'s `functions` block is missing the entry, or the file path doesn't match what Vercel expects.
- **Why it matters:** the receiver-shipped-but-broken failure mode tends to look like real code bugs but is usually a deploy/sync gap. Both steps take <30 seconds; either alone catches most cases.
- **Next action:** no code action. Worth referencing in any future "the receiver isn't responding" diagnostic flow — either a runbook addition or a CLAUDE.md operational note.
- **Logged:** 2026-05-03 (M5.4 — captured during deploy verify operations).

## Vercel `auto_derive_applied` response field is best-effort inference — pre-state SELECT could give true precision

- **What:** `api/airtable_nps_webhook.py` returns `auto_derive_applied` by comparing post-RPC `csm_standing` to the segment-mapping. Documented false positive: when a CSM manually set `csm_standing='happy'` (sticky override) and a 'promoter' segment arrives, the RPC skips the auto-derive but the values still match → response says `auto_derive_applied=true`. Verified concretely in the M5.4 backfill: 53 of 59 successes had this false positive (only 2 actual auto-derive writes). The simple comparison was an explicit V1 design choice (accepted by Drake during the receiver chunk).
- **Why it matters:** the response body misleads anyone who reads `auto_derive_applied` as "the auto-derive ran." The source of truth is `client_standing_history.changed_by`. Documented in code comments, gregory.md, and the receiver's response-shape table — but if Make.com or future operators rely on the flag for their own logic, it'll bite.
- **Next action:** if false positives become operationally annoying (someone reads the report wrong, or Make.com tries to route on the flag): add a pre-state `SELECT csm_standing FROM clients WHERE id = ?` before the RPC call, then compute `auto_derive_applied = (pre != post) OR (pre IS NULL)`. One extra round trip, true precision. ~10 lines in the receiver. Defer until needed.
- **Logged:** 2026-05-03 (M5.4 receiver — V1 accepted-imprecision flagged for V2 if it bites).

## `lib/supabase/types.ts` manually edited — next CLI regen will overwrite cleanly

- **What:** The Supabase types regen path is broken in this environment (CLI misroutes per the standing followup; Studio UI's gen-types feature was moved/removed in newer dashboard versions). For new-column work to compile, `lib/supabase/types.ts` is hand-edited each time a migration adds a column. Standing assumption until regen path is restored: every new schema chunk requires a corresponding hand-edit to types.ts in the same commit.
- **Why it matters:** the file was wiped during a regen attempt and recovered via `git checkout HEAD -- lib/supabase/types.ts` before the manual additions. Any further new columns or RPCs added before a working regen path is restored will need the same hand-edit treatment, and the file will gradually drift from cloud reality. CHECK constraints on `clients.status` (M5.3 added `'leave'`) and `clients.trustpilot_status` (M5.3b renamed) didn't need any types-file changes because Postgres CHECK constraints don't lift to TS literal unions in supabase-cli's regen output anyway — those values stay as plain `string`.
- **Next action:** when a working regen path becomes available again (CLI fix, Studio UI restoration, or a new tool), run regen and let it overwrite the manual edits cleanly. Schedule a follow-up regen review at that point.
- **Logged:** 2026-05-03 (M5.4 follow-up — relocation chunk surfaced the gap and accepted the manual-edit bridge).

## Airtable NPS receiver — no idempotency layer; Make.com retries create duplicate writes

- **What:** `api/airtable_nps_webhook.py` ships in V1 without idempotency. Every request gets a unique `webhook_deliveries.webhook_id = "airtable_nps_<uuid4>"`, so duplicate Make.com fires create duplicate audit rows. Worse: if the receiver returns 5xx after the RPC committed (rare race — RPC succeeded, network error before response), Make.com's default retry-on-5xx fires the same webhook again. The 0018 RPC's idempotency on `csm_standing` (no-op when value unchanged → no extra history row) covers most of the damage, but `nps_standing` gets re-written (idempotent value-write, harmless) and a second `webhook_deliveries` row lands.
- **Why it matters:** harmless today (`webhook_deliveries` is just an audit log; csm_standing dedup means no extra history rows on the common path). But once we start querying `webhook_deliveries` for analytics ("how many NPS updates per week?") the duplicate-write inflation matters. Also, if the RPC ever stops being idempotent on csm_standing (e.g. someone adds a side effect), we'd silently get duplicate auto-derived writes.
- **Next action:** add `airtable_record_id`-based deduplication. Two paths: (a) move `airtable_record_id` from `call_external_id` to a dedicated unique partial index, then `INSERT ... ON CONFLICT (airtable_record_id) WHERE source = 'airtable_nps_webhook' DO NOTHING RETURNING ...` and short-circuit on conflict (like the Fathom handler's `webhook-id` dedup); (b) add a small RPC `record_nps_segment_with_dedup(client_email, segment, airtable_record_id)` that wraps `update_client_from_nps_segment` with a "SELECT 1 FROM webhook_deliveries WHERE call_external_id = ? AND source = ?" guard. Path (a) is cleaner. Defer until duplicate-write counts become visible in queries OR until a real retry incident surfaces.
- **Logged:** 2026-05-02 (M5.4 receiver — known V1 gap, surfaced at draft time per Drake's "no idempotency layer in V1" decision).

## ~~`docs/runbooks/apply_migrations.md` is stale around the Studio + ledger workflow~~ — RESOLVED 2026-05-08

Resolved by the Phase 3 fix session (2026-05-08). The runbook was rewritten end-to-end: new § Gate model section anchoring the hybrid Drake-reviews-SQL → Director-applies-and-verifies flow, new § Preconditions section documenting the Docker-must-be-off requirement, new § Apply section with the canonical CLI command pattern + verbatim expected output, generalized § Dual-verify template (replaces the v1-only verification queries that referenced "16 tables" and migrations 0001–0007), § Failure modes covering both CLI happy-path deviations and the documented psycopg2 fallback. Apply log restructured chronologically with the 2026-04-28 → 2026-05-08 CLI-broken era explicit. Reframing required because the CLI is canonical again, not because the runbook still describes the broken Studio + manual-ledger workaround as canonical.

## `alerts` vs. `client_health_scores.factors.concerns[]` — two-table redundancy

- **What:** the original V1 schema designed `alerts` as the table for actionable CSM-facing signals (churn risk, upsell, etc.). The M3 concerns generation work landed inside `client_health_scores.factors.concerns[]` jsonb instead — concerns are tied to the health score computation, the dashboard reads them from the same row, and one jsonb write was simpler than coordinating two-table writes. Functionally these overlap: concerns ARE alerts.
- **Why it matters:** low-stakes today (`alerts` is empty; concerns are the only live signal source), but the fork becomes a real annoyance when CSM Co-Pilot needs a single read source for "things CSMs should care about." Two write paths, two read paths, two staleness questions.
- **Next action:** resolve when CSM Co-Pilot writes to the unified surface. Two paths: (a) promote concerns out of jsonb into rows on `alerts` (or a renamed `client_concerns` table) with a back-reference to the originating health-score run, or (b) retire `alerts` and let `client_health_scores.factors` be the single source. Defer until CSM Co-Pilot needs the unified surface.
- **Logged:** 2026-05-01 (M4 EOD — known design seam captured before CSM Co-Pilot work starts).

## Master sheet importer — three carry-overs from M4 Chunk C apply

These three are byproducts of Drake's M4 Chunk C triage decisions on the master sheet importer. None blocks the dashboard's daily use; all want a manual touch when there's spare capacity.

- **(a) 21 auto-created non-churn clients need cross-check against existing-cloud-data-in-other-forms.** The first dry-run surfaced 21 paused/active rows in the master sheet that had no match in cloud (verified 0/20 sampled emails found anywhere — primary, alternate, or by name). Drake amended the spec's auto-create rule to cover non-churn unmatched rows too (was: churn only). All 21 land as new clients with sheet-side data and primary CSM assignments. **Risk:** any of them might already be in cloud under a different identity (e.g. a personal-email variant that's stored under a work-email primary, or a slightly-spelled-different name). When time permits, walk the 21 names and check for existing duplicates that should be merged. List captured in `data/master_sheet/import_report_*.txt` after apply.
- **(b) 4 Aleks-orphaned clients need primary_csm reassigned.** Aleks is no longer at the company per Drake. The importer sees `Aleks` in the Owner (KHO!) column on 4 rows (Colin Hill — churn auto-create; Ming-Shih Wang, Jose Trejo, Alex Crosby — non-churn auto-creates after Drake's amendment) and skips the assignment per spec. These 4 clients will land in cloud with `primary_csm = NULL`. Drake handles reassignment manually via the dashboard's Primary CSM dropdown.
- **(c) Some auto-creates have placeholder emails.** Rows in the master sheet without an email value get `<slug>+import@placeholder.invalid` synthesized so the migration 0001 NOT NULL email constraint holds. From the first dry-run: 6 churned (Jarrett Fortune, Chris Ferrente, Robert Haskell, Lenrico Williams, Charles Biller, roula deraz) plus Andy V (paused, post-amendment). If real emails surface later for any of them, edit via the dashboard's Email field — `placeholder.invalid` TLD is RFC-reserved so no risk of accidentally emailing the address.
- **Why deferred:** Drake's call: getting these 21 + 4 + 7 visible in the dashboard NOW (so the CSM team can onboard against real data tomorrow) outweighs the cleanup tax. Manual review + reassignment is a ~30 min batch when convenient.
- **Logged:** 2026-05-01 (M4 Chunk C apply triage).

## Auth context not threaded through Server Actions — `changed_by` is always null in B2 history rows

- **What:** the four history-writing flows shipped in M4 Chunk B2 (status, journey_stage, csm_standing, nps_submissions.recorded_by) all accept a `p_changed_by` / `p_recorded_by` argument but the dashboard Server Actions pass null. The Supabase auth user is available via `@supabase/ssr` cookies, but there's no `auth.users.id → team_members.id` resolution layer yet, and Server Actions don't currently read the auth cookie. Every history row in B2 records `changed_by = null`.
- **Why it matters:** the audit trail tells you what changed and when, but not who. Acceptable for a single-CSM V1 (Drake is the only editor today). Becomes a problem the moment Lou / Nico / Scott / others edit alongside each other in the dashboard — the timeline goes anonymous.
- **Next action:** wire a small helper (`getCurrentTeamMemberId()` or similar) that reads the Supabase auth cookie in a Server Action context, looks up `team_members` by email, and threads the resolved id through the existing nullable `p_changed_by` argument. Exists as a hook in `app/(authenticated)/clients/[id]/actions.ts` — replace the literal `null` passed today. ~30 min plus testing.
- **Logged:** 2026-05-01 (M4 Chunk B2 — wired the RPCs, didn't wire auth).

## metadata.profile read-modify-write race — concurrent edits clobber each other

- **What:** Section 5 (Profile & Background) writes go through `updateClientProfileFieldAction` → `updateClientProfileField` (lib/db/clients.ts), which performs a read-modify-write on `clients.metadata`: SELECT current metadata, build a new object with the updated `metadata.profile.<path>`, UPDATE the row. If two CSMs save different `metadata.profile.*` fields concurrently, the later UPDATE wins and clobbers the earlier write. Top-level `metadata.alternate_emails` / `alternate_names` / etc. are preserved by spreading the existing object (so the merge_clients RPC's writes won't be clobbered — that flow modifies different keys), but two concurrent profile edits collide.
- **Why it matters:** fine for V1 (single-CSM-at-a-time editing pattern). Becomes a real issue once concurrent CSM editing is normal — you save the niche, your colleague saves the offer, your save wins, their offer disappears.
- **Next action:** when concurrent editing becomes real, migrate `updateClientProfileField` to a Postgres function using `jsonb_set` so the read-modify-write happens server-side under a row lock. Or add an `xmin`-based optimistic-concurrency check at the application layer. ~1 hour plus testing. No urgency in V1.
- **Logged:** 2026-05-01 (M4 Chunk B2 — design call: simpler-now, debt-later).

## NPS-entry has no duplicate-submission protection

- **What:** the Section 2 "Add NPS score" form invokes `insert_nps_submission` which always inserts a fresh row. A CSM who clicks Save twice (network blip, double-tap, browser back-then-forward) creates two `nps_submissions` rows for the same client at near-identical timestamps. (Note: post-M5.4 the dashboard no longer surfaces a "Latest NPS" field — `nps_submissions.score` is invisible in V1; the duplicate sits in the table without a UI consumer. `latest_nps` stays in the data layer for V1.5 score-piping.) Total count of `nps_submissions` becomes inflated.
- **Why it matters:** low-stakes for V1 — duplicate NPS rows are easy to spot in the table and easy to delete via Studio. But "the duplicate count drifts the more clients you have" is a slow-growing data-hygiene tax.
- **Next action:** options when usage scales: (a) optimistic UI lock — disable the Save button between submit and revalidation; (b) server-side dedup — reject inserts where a row exists for `(client_id, score)` within the last 30 seconds; (c) a uniqueness check by (client_id, submitted_at::date) when manual entries dominate. (a) is the cheapest and probably enough.
- **Logged:** 2026-05-01 (M4 Chunk B2 — known design gap, deferred).

## Cron sweep race condition — concurrent manual triggers can hit unique-key collision

- **What:** M1.2.5 (2026-04-27) saw two manual `curl` triggers fire ~1 minute apart while debugging the auth-rename + X-Api-Key issues. Both sweeps ran concurrently against the same Fathom window. The cron's per-meeting `_call_already_in_db` check returned False on a few overlapping external_ids because the FIRST sweep hadn't yet INSERTed those rows when the SECOND sweep checked. Result: 2 of 31 cron rows landed `processing_status='failed'` with `duplicate key value violates unique constraint "calls_source_external_id_key"` — both calls actually present in DB from the winning sweep, but the losing sweep's row in `webhook_deliveries` is a noise artifact.
- **Why it matters:** with daily Vercel Cron cadence, the 1-second window between `_call_already_in_db` and `INSERT INTO calls` is unreachable in normal operation — there's only one cron sweep per day. The race only surfaces during human-driven debugging where two manual triggers overlap. Not data loss, not blocking. Just visible-in-the-logs noise that looks like a real failure on shallow inspection.
- **Next action:** if we ever move off daily cron cadence (hourly, or sub-hour) — OR if a future operator adopts a "trigger before reading status" pattern that overlaps two sweeps — tighten dedup by moving `_call_already_in_db` + `INSERT` into a single transaction with `ON CONFLICT (source, external_id) DO NOTHING RETURNING id` (same pattern as the webhook handler's `webhook_deliveries` dedup). ~10 lines in `_upsert_call_row`. Defer until needed.
- **Logged:** 2026-04-27 (M1.2.5 — flagged but not fixed).

## API integration discovery — verify auth scheme empirically before declaring done

- **What:** F2.1's discovery session (Fathom webhook intel) thoroughly read the OpenAPI spec, payload schemas, signature verification, retry semantics — but missed that Fathom's external API uses `X-Api-Key: <key>` for outbound auth, NOT `Authorization: Bearer <key>`. F2.1 produced an architecture doc and 8 commits' worth of code on the assumption of Bearer auth; M1.2's `api/fathom_backfill.py:_fetch_meetings_window` shipped with `Authorization: Bearer ${api_key}` and 401'd against Fathom on first real run. M1.2.5 caught it via Drake's manual-curl probe (`curl -H "X-Api-Key: ..." https://api.fathom.ai/external/v1/meetings` → 200). One-line code fix; the lost time was the deploy → 401 → diagnose loop.
- **Why it matters:** every future external-API integration (CRM, Calendar, n8n webhook receivers, future agent integrations) has the same risk — read the spec carefully, miss one detail, ship code that 401s on first real call. The OpenAPI / docs are the *intended* shape but providers don't always document the actual deployed auth scheme accurately, especially when the spec says `securitySchemes: bearerAuth` but the provider's implementation accepts something else.
- **Next action:** before declaring any API discovery session "done," **run one real curl against the production API endpoint with the documented auth scheme.** A 200 confirms the auth shape; a 401 surfaces the gap before code ships. Add this as a step to a future `docs/runbooks/api_integration_discovery.md` runbook (analog to `adding_new_ingestion_source.md`) — written when the second integration starts (CSM Co-Pilot V2 may add CRM API integration; that's the trigger).
- **Logged:** 2026-04-27 (M1.2.5 deploy caught the F2.1 gap).

## Fathom webhook registration UI viewport bug — workaround needed every time

- **What:** Fathom's webhook registration UI (Settings → API Access → Add Webhook) has a viewport rendering bug where the verify/save button renders below the fold without a scrollbar. On a default browser zoom + standard laptop display, you can fill the form but not submit it. M1.1 lost ~3 days to this — registration appeared complete but Fathom never sent deliveries because the registration object hadn't been finalized server-side. **Workaround:** zoom browser out (Cmd-/Ctrl-`-`) until the verify button is visible, then submit.
- **Why it matters:** any future webhook re-registration (secret rotation, URL change, scope change) will hit this same bug. The runbook in `docs/runbooks/fathom_webhook.md` § Rotate Secret depends on the UI working — if Drake's already zoomed out it's a non-issue, but a future operator following the runbook cold could lose another few days.
- **Next action:** add a one-line note to `docs/runbooks/fathom_webhook.md` § Register that says "zoom out before submitting if the verify button isn't visible." Also, the cleanest long-term fix is to skip the UI entirely — Fathom's `POST /webhooks` API endpoint works fine (per F2.1 doc read). For the next rotation, register via API instead of UI.
- **Logged:** 2026-04-27 (M1.1 root cause).

## Fathom API key + cron auth secret — need rotation runbook

- **What:** Two cron-related secrets need documented rotation procedures. (1) `FATHOM_API_KEY` (Fathom team-account API key, used by `api/fathom_backfill.py` to read `/meetings`) — Fathom's API doesn't expose a rotate endpoint, only delete + recreate. (2) `CRON_SECRET` (random secret used by Vercel Cron's `Authorization: Bearer ...` header AND validated by every cron handler in this codebase; consolidated to single-var pattern in M6.2). Rotating CRON_SECRET affects all crons simultaneously since it's the single project-level token.
- **Why it matters:** if either is leaked or a team member with access leaves, we need a known-good rotation path. Doing it under pressure without a runbook is error-prone (cron downtime window between Vercel env update and redeploy).
- **Next action:** when adding the secret-rotation section to `docs/runbooks/fathom_webhook.md` (already an open followup for the webhook secret), extend it to cover both new secrets. CRON_SECRET rotation is now well-documented in `docs/runbooks/accountability_notification_cron.md` § "Rotate the secrets" — could simply cross-reference rather than duplicate. ~30 min to draft. Not urgent — defer until first rotation is needed.
- **Logged:** 2026-04-27 (M1.2 build); updated 2026-05-06 (M6.2 consolidated cron-auth env var to CRON_SECRET).

## PostgREST transient empty-body 400 on count queries — pattern observed multiple sessions

- **What:** Over F1.4, F2.3, and F2.4 the supabase-py client has intermittently failed on `.select("id", count="exact", head=True).execute()` with `postgrest.exceptions.APIError: {'message': 'JSON could not be generated', 'code': 400, 'hint': 'Refer to full message for details', 'details': "b''"}`. The pattern: PostgREST returns an empty response body; postgrest-py tries to parse it as an APIError, fails at pydantic validation, re-raises a synthesized 400. Not a bug in our code — the service itself is returning an empty body. Affects only head-count queries; full SELECT queries are unaffected. Retrying the same query moments later usually succeeds.
- **Why it matters:** test verification scripts that rely on head-count queries flake intermittently, producing false-failure signals when the actual handler + pipeline work correctly. F2.4's test script was patched to use direct psycopg2 queries for count verification (see `scripts/test_fathom_webhook_locally.py` `_count()` helper), which side-steps the issue entirely. Not a production-path concern since the Fathom handler doesn't issue head-count queries, but the Ella agent's retrieval path and future admin queries might.
- **Next action:** none today. Watch for the failure pattern in production code after F2.5 deploys — if it ever hits a user-visible path, file upstream with Supabase + postgrest-py. Until then, any ops script that needs a reliable count should use `.select("id", count="exact")` without `head=True` (returns the data array which the client can `len()` safely) or drop to psycopg2 direct.
- **Logged:** 2026-04-24 (F2.4 — consolidating observations from F1.4 and F2.3 into one entry).

## Fathom webhook — delivery semantics live-test (3 of 4 still open, plan-tier resolved)

- **What:** F2.1 identified four unknowns: (1) `webhook-id` stability across retries, (2) retry count + backoff schedule, (3) summary regeneration firing a second `new-meeting-content-ready`, (4) plan-tier gating. F2.5 (2026-04-24) registered the production webhook via Fathom's UI — **plan-tier (#4) is effectively resolved**: no upgrade prompt, no error, registration succeeded. The other three remain open; they can only be observed once a real delivery (and a retry or regeneration) arrives. Architecture in `docs/architecture/fathom_webhook.md` is defensive on all three so none block production operation.
- **Why it matters:** per-retry behavior (#1, #2) sets expectations for our dedup layer and outage tolerance; summary regen (#3) tells us whether `_sync_summary_content` gets exercised organically. None are blockers — each has a defensible default in the handler — but the actual numbers sharpen operational expectations. If #1 turns out to be unstable, we're already protected by the secondary `(source, external_id)` dedup at the `calls` unique constraint. If #2's retry window exceeds our outage tolerance, that's F2.6 cron backfill's problem to solve. If #3 fires, `_sync_summary_content` updates `documents.content` but doesn't re-embed — see Ella's followups.
- **Next action:** no active work. Observe when first real delivery lands. For #2 specifically, force a retry by returning 500 from the handler briefly (temporarily break the signature verify, say) and observe Fathom's retry cadence — but that's a F2.7 nice-to-have, not a pilot blocker. For #3, wait to see if any delivery shows up with `call_external_id` matching an already-processed call.
- **Logged:** 2026-04-24 (F2.1 discovery); partial resolution 2026-04-24 (F2.5 registration proved plan-tier).

## Fathom webhook secret rotation runbook — needed before first rotation

- **What:** Fathom's API exposes `POST /webhooks` (create) and `DELETE /webhooks/{id}` but no `PATCH`/rotate endpoint. Rotating the production webhook secret requires: (1) create a new webhook at the same URL with a fresh secret, (2) the new webhook's secret is returned in the `POST` response body only once, (3) update the `FATHOM_WEBHOOK_SECRET` env var on Vercel and redeploy, (4) delete the old webhook. Between steps 1 and 3 Fathom may be delivering against both — both must verify against whichever secret was valid at send time. Without a runbook, rotation is error-prone: a mistimed step either drops deliveries (old webhook deleted before new secret is live) or leaks PII (new webhook delivered before env var updated means signature-fail 401s, Fathom retries, eventually dead-letters).
- **Why it matters:** webhook secrets should rotate on suspected compromise (accidental commit, team-member offboarding, vendor breach). Today there's no documented procedure so it'll either be "Drake figures it out at 2am under pressure" or "nobody rotates and we carry a stale secret forever."
- **Next action:** spend an hour drafting `docs/runbooks/fathom_webhook_secret_rotation.md` with the exact command sequence, expected durations, and verification steps. Include the fallback: for a brief overlap window, the handler accepts either of two env-var-loaded secrets (`FATHOM_WEBHOOK_SECRET`, `FATHOM_WEBHOOK_SECRET_PREV`) and verifies against both — that eliminates the racing-deliveries problem. Drop the PREV var 5 min after the new one goes live.
- **Logged:** 2026-04-24 (F2.2 architecture work surfaced the gap).

## Auto-created client review workflow — human-owned queue, dashboard merge surface live

- **What:** the Fathom ingestion pipeline auto-creates a minimal `clients` row when a transcript's non-team participant doesn't match any existing client by email (primary or `metadata.alternate_emails`) or by name (primary or `metadata.alternate_names`). Auto-created rows carry `tags=['needs_review']` and `metadata.auto_created_from_call_ingestion=true` + `auto_created_from_call_external_id` + `auto_created_from_call_title` + `auto_create_reason` + `auto_created_at` breadcrumbs (see `ingestion/fathom/pipeline.py:_build_auto_create_metadata`). Their associated `calls` land medium-confidence and their `documents` land `is_active=false` — chunks exist but are invisible to `match_document_chunks` until promoted. Promotion (merging into a canonical row, flipping retrievability, reactivating the document) happens via the Gregory dashboard's "Merge into…" flow on the Clients detail page (M3.2 — atomic via `merge_clients` RPC, migration 0015). **There is no agent reviewing these rows; Drake or a CSM does it by hand via the dashboard.** Live cloud state post-M5 cleanup: a manageable handful of `needs_review` rows; the M5 walkthrough closed 12 merges + 13 detags.
- **Why it matters:** unreviewed `needs_review` rows leave real coaching call context in the KB but invisible to Ella (because `is_active=false` gates the transcript_chunk documents). That's the desired safety behavior for ambiguous matches, but the cost is invisible-until-reviewed content. If auto-create volume climbs (new client roster churn, parser false negatives), the hand-review workflow starts to cost real time. See `docs/known-issues.md` § "needs_review tag doesn't auto-clear after manual reconciliation" for the related auto-detag automation gap.
- **Next action:** the dashboard merge surface exists. Drain queue when convenient. If hand-review starts feeling heavy, design a grouping / fuzzy-match overlay on top of the existing dashboard that surfaces inferred canonicals (name fuzzy-match, email domain, co-occurrence on same call) and lets a human one-click merge.
- **Logged:** 2026-04-24 (expanded post-F1.4 with actual queue size + in-queue duplicate list; pruned 2026-05-05 after M5 cleanup walkthrough drained most of the queue).

## 9 client-category calls landed with NULL primary_client_id — orphan transcript chunks

- **What:** F1.4 post-ingest verification surfaced 9 `calls` rows with `call_category='client'`, `classification_method='title_pattern'`, confidence 0.60, AND `primary_client_id IS NULL`. Each has a `call_transcript_chunk` document (is_active=false, chunk counts 2–16 each, ~88 chunks total) with `metadata.client_id=null`. Affected titles: `30mins with Scott (The AI Partner) (...)` for Allison Boeshans, Cindy Yu, Connor Malewicz, King Musa, "Musa  Elmaghrabi " (with trailing/double spaces), Owen Nordberg, Shivam Patel (two variants: trailing-space and clean), tina Hussain. Curious because (a) "King Musa" and "Musa  Elmaghrabi " are the pilot Musa — who F1.2 preloaded and who *did* resolve correctly for his other 3 calls; (b) these landed without also triggering an `AutoCreateRequest`, so the auto-create fallback was bypassed in the classifier.
- **Why it matters:** Ella retrieval is safe (all 9 docs are `is_active=false`, so chunks are invisible to `match_document_chunks`), but those ~88 chunks are orphaned — no canonical client row to promote them to, no auto-row to merge into. A pilot client's calls are among them (Musa × 2), meaning Ella can't surface those two coaching calls to Musa's pilot channel until the underlying classifier issue is fixed and the calls are re-ingested. Additionally this is a symptom of a real classifier edge case — the path through `_classify_by_title` where title_pattern matches but the participant identity on the call is malformed enough that neither resolver hit works AND the AutoCreateRequest path is skipped.
- **Next action:** (1) query sample the underlying transcripts to see what the participant field looks like on one of these calls — specifically the "King Musa" call (external_id 134757219) and "Musa  Elmaghrabi " (134393413) vs Musa's resolved call "30mins with Scott (The AI Partner) (King Musa) Mar 19 2026" to understand the classifier branch that's dropping the auto-create; (2) if the fix is straightforward (e.g., strip whitespace before name-lookup, or ensure `_classify_by_title` always emits AutoCreateRequest when no client resolves), patch `ingestion/fathom/classifier.py` and re-run ingestion for just the 9 affected external_ids via `--only-category client` filter (pipeline upsert will re-process); (3) if complex, leave the orphans as-is and document — pilot rollout isn't blocked since the 9 calls are already absent from retrieval.
- **Logged:** 2026-04-24 (from F1.4 post-ingest verification).

## `call_participants` unique on `(call_id, email)` admits NULL-email duplicates

- **What:** F1.1 audit confirmed the only unique constraint on `call_participants` is `(call_id, email)` (btree). Postgres treats `NULL` as distinct in unique indexes by default, so two rows on the same call with `email IS NULL` would not violate. The Fathom pipeline's `_upsert_participants` always calls `pt.email.lower()`, so a `None` email would raise `AttributeError` rather than silently insert — but a parser change or a new ingestion path that inserts `NULL` emails would bypass the constraint without warning.
- **Why it matters:** minor today (TXT parser always produces an email string per participant), but it's a latent footgun for future ingestion paths — webhook-based, CRM-based, or any path where a participant could legitimately lack an email.
- **Next action:** no action today. If/when we add a non-TXT participant ingestion path, either (a) require email on participants in the schema (`NOT NULL`), or (b) change the unique to `(call_id, coalesce(email, ''))` via an expression index. Flag during that future feature's design, not now.
- **Logged:** 2026-04-24.

## PostgREST 1000-row page cap — use `count='exact', head=True`

- **What:** `db.table("x").select("id").execute()` against cloud silently caps at 1000 rows — PostgREST's default page size. `len(resp.data)` in that case is the page size, not the row count. For accurate counts, always use `db.table("x").select("id", count="exact", head=True).execute().count`.
- **Why it matters:** caught once on 2026-04-23 while building the `CLAUDE.md` snapshot — I reported `document_chunks: 1000` and `slack_messages: 1000` when the actual counts were 4,179 and 2,914. A silent undercount that gets into a doc or a Slack status message is worse than an obvious error, because the number looks plausible at a glance.
- **Next action:** no one-time fix; this is a behavioral reminder for anyone writing ops scripts or quick counts. If we end up writing enough count-queries to want a shared helper, add one to `shared/db.py` (something like `row_count(table_name)`) that always uses the `count='exact', head=True` shape. Until then, be explicit at every call site.
- **Logged:** 2026-04-24.

## RLS revisit trigger for Gregory dashboard

- **What:** Row-Level Security policies for the dashboard. Per gregory.md's locked V1 spec, RLS is "off for V1" — meaning V1 ships with RLS *enabled* on every public table but *zero policies*, plus the dashboard's data layer (`lib/db/clients.ts` and the page-entry `team_members` lookup) using the **service role key** to bypass RLS entirely. The auth client (`lib/supabase/server.ts`, anon key + cookies) is used only to verify the user's session in the auth-gate layout. This split was forced into existence mid-M2.3b after the first deploy returned 0 clients despite 134 in cloud — RLS deny-default was the cause; the data-layer-via-service-role pattern was the resolution. V2 needs proper RLS policies on `clients`, `client_team_assignments`, `calls`, `call_action_items`, `client_health_scores`, `nps_submissions` so CSMs see only their assigned clients (joined via `client_team_assignments` where `role='primary_csm'` and `unassigned_at is null`); at that point the dashboard data layer can move back to the anon client (or keep the service-role split where admin operations like merge tooling still need to bypass).
- **Why deferred:** premature for current 2-user model (Drake + Zain admin). App-level auth gate is sufficient at this scale.
- **Revisit trigger:** first non-admin CSM gets dashboard access.
- **Logged:** 2026-04-28; expanded with V1 service-role-split detail and V2 implementation specifics 2026-04-28 during M2.3b housekeeping.

## ~~Supabase CLI default routing is broken in this environment~~ — RESOLVED 2026-05-08

Resolved by Phase 3 discovery (2026-05-08). Root cause: CLI v2.90.0's write path silently misroutes `db push --linked` when both a linked-cloud project AND a reachable local Docker stack are present. The CLI has a "is local stack reachable?" branch that overrides the `--linked` flag in that situation. Today's environment has Docker WSL integration disabled — the CLI has no local target to misroute to, so `db push` correctly falls through to the linked cloud target.

Empirical no-op `0029_phase3_cli_routing_test.sql` apply on 2026-05-08 confirmed `supabase db push` lands in cloud cleanly (verbatim output: "Connecting to remote database..." → "Applying migration..." → "Finished supabase db push." with exit code 0; pre/post snapshot showed +1 ledger row at version 0029, zero rogue schema changes; cleanup restored exact baseline).

The CLI-broken era ran 2026-04-28 to 2026-05-08; migrations 0011–0028 (18 migrations) shipped via Studio + manual ledger insert as the workaround. Operational layer of migrations now sits with Director per the hybrid gate model in CLAUDE.md § Director / Builder System § Gate trajectory; canonical command pattern is documented in `docs/runbooks/apply_migrations.md` § Apply.

Resolution is durable as long as Docker WSL integration stays off. The Docker-must-be-off precondition is documented in `apply_migrations.md` § Preconditions as the explicit guard if integration ever gets re-enabled.

## ~~Studio + manual ledger registration is the temporary canonical migration pattern~~ — RESOLVED 2026-05-08

Resolved by Phase 3 discovery (2026-05-08). The CLI is canonical again — `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes` is the working command pattern Director uses. The Studio + manual ledger workaround (active 2026-04-28 to 2026-05-08, covering 18 migrations) is no longer the canonical path. It remains a valid emergency fallback if the CLI ever silently misroutes again — diagnostic playbook in `apply_migrations.md` § Failure modes covers the recovery path. See `apply_migrations.md` for the canonical operational layer and CLAUDE.md § Director / Builder System § Gate trajectory for the gate model.

## Migration application requires dual verification (schema reality AND ledger)

- **What:** every migration apply must verify BOTH (a) schema reality against cloud explicitly via `to_regclass('public.<table>')` / `information_schema.columns` / `pg_proc` queried through a connection that's *known* to target cloud (psycopg2 via the pooler URL is canonical; Studio SQL Editor is acceptable as a fallback), AND (b) ledger registration via `select version from supabase_migrations.schema_migrations where version = '<NNNN>'`. If either returns 0 rows, the migration didn't fully apply — recover before declaring done. Defense in depth: single-query verification can pass against the wrong database, and any migration tool (CLI, future `scripts/apply_migration.py` wrapper, manual SQL via Studio) can in principle drift in ways the user wouldn't catch with a single check.
- **Why permanent:** process discipline, not a bug. Surfaced 2026-04-28 by the M2.2 CLI silent-misroute incident (the originating concrete example), but the lesson generalizes — applies even when the CLI is working correctly (post-Phase-3 reality, 2026-05-08 onward) and would apply equally to a future tool change.
- **Next action:** every migration apply, perpetually. Director's `docs/runbooks/apply_migrations.md` § Dual-verify carries the canonical templated queries; CLAUDE.md § Working Norms § Operational patterns anchors the principle.
- **Logged:** 2026-04-28; reframed 2026-05-08 (Phase 3 fix session) to remove CLI-broken-era specifics now that the CLI is canonical again.

## PostgREST stale-cache symptom can mask deeper issues

- **What:** when `npx supabase gen types` returns schema that doesn't match expectations, the first instinct (flush PostgREST cache via `notify pgrst, 'reload schema'` or Studio's "Reload schema cache" button) addresses only one possible cause. Equally likely: the migration didn't actually apply (see CLI routing bug above). M2.3b lost ~30 minutes chasing a "cache lag" that turned out to be three migrations never having landed in cloud. Diagnostic order: (1) verify the schema object actually exists in cloud via `information_schema` / `to_regclass`, (2) verify ledger registration, THEN (3) flush PostgREST if both pass.
- **Why deferred:** process discipline change, no code work.
- **Revisit trigger:** next time `gen types` returns unexpected results.
- **Logged:** 2026-04-28.

## `psql` not available in Drake's WSL — install errored

- **What:** Drake tried `sudo apt install postgresql-client` to get `psql` for ad-hoc queries; the install errored. For now, ad-hoc cloud queries go through Supabase Studio's SQL Editor; any Code-side query needs to use the existing Python connection patterns (`scripts/*.py` via psycopg2 with `SUPABASE_DB_PASSWORD` from `.env.local`).
- **Why deferred:** working around it via Studio is fine for now. Install fix isn't blocking any feature work.
- **Revisit trigger:** when Drake has 10 minutes between sessions to debug the apt errors, OR when a workflow genuinely requires `psql` available in terminal (e.g., a runbook that assumes it).
- **Logged:** 2026-04-28.

## SearchableClientSelect fetch-all-on-mount — fine for V1, watch growth

- **What:** the merge dialog (M3.2) and the upcoming Calls page primary-client-id picker (M3.3) both render a client dropdown by fetching the full eligible-client list server-side on mount and filtering client-side as the user types. ~188 clients today; the round trip is one cheap PostgREST query and the rendered list fits comfortably in a 64-row scroll container. No keystroke-driven DB calls.
- **Why it matters:** the pattern has a soft ceiling. At ~500–800 clients the dialog open will start to feel sluggish (network + client-side initial-render cost); at ~5000+ rows the JS-side filter cost on every keystroke becomes visible. Neither limit is anywhere near today's scale.
- **Revisit triggers:** (a) `select count(*) from clients where archived_at is null` crosses ~800, (b) anyone reports the merge dialog or the Calls primary-client picker feeling slow on dialog open. Resolution path: server-filtered query bound to debounced search input — ~30 lines of refactor, no API change at the consumer level. Until then: the current implementation is correct for V1 scale.
- **Logged:** 2026-04-29 (M3.2 build).

## `merge_clients` transcript-doc query is whole-table filter — fine at current scale

- **What:** the `merge_clients` plpgsql function (migration 0015) reactivates transcript_chunk documents by querying `documents where document_type = 'call_transcript_chunk' and metadata->>'call_id' = any(<source's call ids as text[])`. Mirrors the Python script's "fetch all transcript chunks, filter on metadata.call_id in Python" approach, but server-side via the PostgREST equivalent. There's no index on `documents.metadata->>'call_id'` because that filter has only ever been used by the merge path.
- **Why it matters:** scan cost is proportional to total transcript_chunk doc count. Today: ~3000 documents in cloud, scan is fast. As ingestion grows past ~50k transcript_chunk docs the scan starts to become the merge bottleneck; a partial index `on (metadata->>'call_id') where document_type='call_transcript_chunk'` would fix it cleanly. Not a correctness issue — just a perf one.
- **Revisit triggers:** (a) `select count(*) from documents where document_type='call_transcript_chunk'` crosses ~50k, OR (b) merge dialog spinner ever takes more than ~2s on submit. Resolution: add the partial index in a small migration. Until then: status quo.
- **Logged:** 2026-04-29 (M3.2 build).

## Surface `alternate_names` on Clients detail page

- **What:** Section 1 (Identity) on the Clients detail page renders `full_name` but not `metadata.alternate_names`. After a merge, the absorbed display-name variants live in that field and are invisible to dashboard reviewers without opening Studio. Fix: display as a read-only "Display name variants: Name A, Name B" line below the full_name field. Source data is on the client row itself; no new query needed — the page entry already pulls full `metadata` via `getClientById`.
- **Why it matters:** not blocking, no behavior bug. Both fields are correctly populated by the M3.2 merge RPC. The data is correct; only the dashboard's read-back is missing.
- **Revisit triggers:** (a) next Clients detail page polish pass, (b) a reviewer asks "what merged into this client?" and Studio is the only answer, (c) audit needs surface for understanding why a given client matched a participant by an alt-name.
- **History:** the `alternate_emails` half of this entry was resolved 2026-05-06 — Section 1 now exposes `metadata.alternate_emails` as an editable comma-separated text input (no dedup / no validation by design).
- **Logged:** 2026-04-29 (M3.2 live verification).

## `calls.summary` column is unused — cron path writes to `documents` instead

- **What:** the `calls.summary` text column (migration 0003) is empty for all cloud rows. Fathom cron-ingested summaries land as `documents` rows of `document_type='call_summary'` keyed on `metadata.call_id`. The Calls detail page Section 4 (M3.3) was originally spec'd to read `calls.summary`; it now reads from `documents` instead, matching reality.
- **Why deferred:** no behavior bug. The dashboard renders the right content; the redundancy is just a column that's never written. Two clean fixes exist; neither is urgent.
- **Resolution options:**
  - **(a) Backfill `calls.summary` at ingest time.** When the Fathom pipeline writes a `call_summary` document, also UPDATE the `calls.summary` column with the same content. Reads then have one source. Costs: write amplification, drift risk if the document is regenerated and the column isn't.
  - **(b) Drop `calls.summary` in a small migration.** Acknowledge that summaries are documents, not call attributes. Costs: nothing — no live reader of the column.
- **Revisit triggers:** (a) we add a query that wants `calls.summary` indexed (rare — summaries are read-once-per-detail-view, not bulk-queried), (b) someone is surprised by the empty column during schema review and wants the redundancy resolved. Until then: status quo, dashboard reads from `documents`.
- **Logged:** 2026-04-29 (M3.3 build).

## ~~Vercel build cache can carry forward bloated function bundles, surfacing as 250 MB errors on git-push deploys~~ — RESOLVED 2026-05-08

Resolved 2026-05-08 by Phase 3b fix session. Root cause: Vercel's per-deployment build cache had been seeded with contaminated function bundles (likely from a `vercel deploy` from local that uploaded the working dir's untracked Python pkg dir skeletons into each `@vercel/python` function bundle, around 2026-04-28). Every subsequent git-push deploy restored the contaminated cache and failed the 250 MB unzipped per-function size check during the "Deploying outputs" phase. Resolution sequence on 2026-05-08: (1) dashboard "Redeploy" with **Use existing Build Cache** unchecked uploaded a clean replacement cache; (2) prevention work landed in the same session (55 untracked Python pkg dir skeletons deleted from repo root + `data/` added to `.vercelignore`); (3) Phase 3b close commit pushed via git-push, auto-deploy succeeded without intervention — confirming the clean cache held and the bug doesn't recur on subsequent pushes.

Diagnostic signature kept below as future reference if a similar pattern ever recurs:

- **Failed build (cache-contaminated):** `Restored build cache from previous deployment (<cache-id>)` early in the log; build itself "Completes" successfully; failure surfaces during "Deploying outputs..." with the literal `'A Serverless Function has exceeded the unzipped maximum size of 250 MB'`.
- **Successful no-cache redeploy:** `Skipping build cache, deployment was triggered without cache.` early in the log; full fresh `npm install`, fresh `@vercel/python@4.3.1` builder install; deploy completes; uploads a fresh `[~120 MB]` build cache that replaces the contaminated one.
- **Recovery if it recurs:** Vercel dashboard → click "Redeploy" on the failed deployment → **uncheck "Use existing Build Cache"** in the dialog. The successful no-cache redeploy uploads a fresh cache; subsequent git-push deploys restore the now-clean cache and succeed without intervention.

Prevention landed 2026-05-08:

- 55 untracked, non-functional Python pkg directory skeletons at the repo root (`anthropic/`, `openai/`, `pyiceberg/`, `cryptography/`, `pydantic/`, `hive_metastore/`, plus 49 more — none had `__init__.py`, all dated `Apr 28 15:54`, ~37 MB combined) deleted. Almost certainly left over from an interrupted `pip install --target .` or wheel extraction. Uploaded by `vercel deploy` from local but not by git push (untracked).
- `data/` (~13 MB of ingestion run logs) added to `.vercelignore` so it can't be uploaded by `vercel deploy` from local even though it's already gitignored from git push.

Earlier-symptom note kept for the future-Director: the 2026-04-29 M3.3 push exhibited a different surface symptom (`status ● Error` with empty Builds tree, no error message in the log, production alias unchanged) that resolved by a same-commit redeploy. May or may not share this root cause; insufficient evidence to confirm. If the empty-builds-tree symptom recurs, suspect cache contamination first and try the no-cache redeploy before opening a Vercel support ticket.

**Logged:** 2026-04-29 (M3.3 — original empty-builds-tree symptom); rewritten 2026-05-08 (Phase 3b discovery — root-caused via build-log diff of commit d14770e's failed git-push vs successful no-cache redeploy); resolved 2026-05-08 (Phase 3b close — validation deploy on the four-commit fix session pushed cleanly without manual redeploy, confirming the clean cache held).

**See also:** § ~~Vercel auto-deploys silently failed on recent pushes to main (intermittent)~~ — RESOLVED 2026-05-11. That entry covers the second occurrence of the same 250 MB error message, with a different root cause (Vercel-build-created `.next/` and `node_modules/` slipping past `.vercelignore` into every Python function bundle, growing the bundle close to and then past the 250 MB cap as we added more Python functions / heavier deps). Resolution path was per-function `excludeFiles` in `vercel.json` rather than cache eviction. Future Director / Builder should see both contamination-and-bundle-size issues as related-but-distinct: contamination is "wrong stuff in the cache"; bundle-size is "bundle is right around the limit." When the 250 MB error next recurs, check `vercel.json` first for missing `excludeFiles` entries on any newly-added Python function.

## ~~Ella V2 Batch 1 — realtime live ingestion not operational (Slack-app-config gap)~~ — RESOLVED 2026-05-10

Resolved 2026-05-10 — root cause was a missing `message.groups` event subscription. Client channels are private (🔒), and `message.channels` alone fires only for public (`#`) channels; `message.groups` is what fires for private channels. Drake added the subscription, reinstalled the Slack app, and retested end-to-end with a fresh post in `#ella-test-drakeonly` — `webhook_deliveries` and `slack_messages` rows landed within seconds. Both `channels:history` and `groups:history` scopes are now active on the bot token. The original entry is preserved below for diagnostic reference (the symptom signature plus the four-step Slack-app-config checklist remains useful if any future event-subscription change leaves the path silently broken in the same way).

- **What:** Backfill works (3,641 rows across 8 channels as of 2026-05-10), but `webhook_deliveries WHERE source='slack_message_ingest'` is still 0 — Slack isn't reaching `/api/slack_events` for `message`-type events. A 2026-05-10 test message in `#ella-test-drakeonly` (C0AUWL20U8J) landed in Slack and the bot is a confirmed member of the channel, but produced zero audit rows. The endpoint itself is alive (GET → 200; unsigned POST → 401, correct signature behavior). The `app_mention` path was wired up in the same `event_callback` dispatcher and the `message` branch sits right next to it; the dispatcher is fine, so the cause is upstream of the request reaching us.
- **Why it matters:** Batches 2/3 (passive monitoring, delayed response, team-response cancellation) all depend on a live store of every Slack message. Until the realtime path is on, the only Slack data we have is whatever backfill catches at run time — there's no path for "Ella sees a message in real time."
- **Next action:** Drake checks the Slack app config (gate d) in this order: (1) Event Subscriptions → confirm `message.channels` AND `message.groups` are subscribed and the Request URL `https://ai-enablement-sigma.vercel.app/api/slack_events` shows "Verified"; (2) OAuth & Permissions → confirm `channels:history` + `groups:history` scopes are granted; (3) confirm the app was reinstalled in the workspace after the most recent scope/event-subscription change; (4) compare the Slack app's signing secret against Vercel's `SLACK_SIGNING_SECRET` env var (a mismatch would 401 every delivery, which never reaches the audit-write code so it stays invisible from the cloud side — only `vercel logs` would show it). Once any of those flip, a follow-up test post in `#ella-test-drakeonly` should produce a fresh `webhook_deliveries` row + a fresh `slack_messages` row within ~10 seconds.
- **Logged:** 2026-05-10 (Ella V2 Batch 1 finish-rollout Task 3 finding); resolved 2026-05-10 (root cause `message.groups` subscription missing).

## ~~Vercel auto-deploys silently failed on recent pushes to main (intermittent)~~ — RESOLVED 2026-05-11

Resolved 2026-05-11 by the `vercel-python-bundle-size-diagnose-and-reduce` spec. Root cause was different from the 2026-05-08 cache-contamination signature: every Python function bundle was sitting at **exactly 253.42 MB** (3.42 MB OVER the 250 MB cap), where the dominant contributor was `.next/cache/webpack: 129.73 MB` AND `node_modules/` (Next.js production deps — swc-linux-x64-gnu, typescript/lib, lucide-react, lightningcss, ts-morph). Both are Vercel-build-phase artifacts: `.vercelignore` filters the initial upload, but Vercel's build creates `.next/` and `node_modules/` AFTER the ignore is applied, so they slip into every `@vercel/python` function bundle.

The intermittent vs reliable pattern was bundle size oscillating right at the limit — sometimes the transitive-dep resolution produced bundles fractionally under 250 MB (build passes); sometimes slightly over (build fails). Manual Redeploy "worked" because cache state varied between invocations.

Resolution: add `"excludeFiles": "{.next,node_modules}/**"` to every Python function entry in `vercel.json`. Drops bundle size from 543 MB (after fresh build) → ~123 MB. 127 MB of headroom under the cap. Validated via preview deploy (`ai-enablement-i664mcjog`, succeeded) + production auto-deploy on commit `3e71753` to `main`.

**Diagnostic signature kept for future-Builder reference:**

Pre-fix (failed deploys):
```
Error: 9 functions exceeded the uncompressed maximum size of 250 MB.
Large dependencies:
• .next/cache/webpack: 129.73 MB
• node_modules/@next/swc-linux-x64-gnu: 125.32 MB
• node_modules/next/dist: 82.61 MB
• node_modules/typescript/lib: 22.48 MB
• node_modules/lucide-react/dist: 19.87 MB
• cryptography/hazmat/bindings: 13.28 MB
• zstandard/_cffi.cpython-312-x86_64-linux-gnu.so: 11.58 MB
• zstandard/backend_c.cpython-312-x86_64-linux-gnu.so: 11.02 MB
• pyroaring.cpython-312-x86_64-linux-gnu.so: 7.59 MB
• pydantic_core/_pydantic_core.cpython-312-x86_64-linux-gnu.so: 4.53 MB
```

Note that pyiceberg / pyroaring / zstandard / hive_metastore are dead-code from `supabase -> storage3 -> pyiceberg` — we never call Storage. Excluding those would shave another ~25 MB but adds ImportError-risk; current headroom doesn't need it.

**Revisit triggers:** (a) adding a new Python function — copy the existing `excludeFiles` pattern; (b) adding a new heavy dep to `requirements.txt`; (c) upgrading `@vercel/python` builder version (4.3.1 → 4.x.x); (d) the 250 MB error message appears again — check `vercel.json` first for missing `excludeFiles` entries.

**Logged:** 2026-05-10 (intermittent-failure observation, no root cause); rewritten 2026-05-11 (root-caused via `vercel inspect --logs` on a failed deploy showing per-function bundle composition + iterative preview deploys); resolved 2026-05-11 (production auto-deploy on commit `3e71753` succeeded after `excludeFiles` glob landed; full diagnostic + fix in `docs/reports/vercel-python-bundle-size-diagnose-and-reduce.md`, runbook in `docs/runbooks/vercel_python_bundle_size.md`).

## Backfill `--channel-id` flag doesn't strictly scope when a client has multiple channels

- **What:** `scripts/backfill_slack_client_channels.py --channel-id <X>` filters the `slack_channels` lookup by channel id, but `run_ingest` takes `client_full_names` and `_resolve_client_target` picks the FIRST channel returned for that client. So if client Y owns channels X1 and X2, passing `--channel-id X2` ingests X1 (whichever is first in the `slack_channels` row order) and silently leaves X2 at zero rows. Caught 2026-05-10 when `--channel-id C0AUWL20U8J` (ella-test-drakeonly, mapped to client Javi Pena) re-hit `C09GA380JRM` (Javi Pena's main) instead.
- **Why it matters:** Today only one client (Javi Pena) has multiple mapped channels (`#ella-test-drakeonly` lives in Javi's workspace), so blast radius is small. Will grow if more co-tenant test channels are added or any other client picks up a second mapped channel.
- **Next action:** Either (a) plumb a real channel-id filter into `run_ingest` and add `--channel-id-strict` to the script, or (b) document `extra_channel_names=[<name>]` as the canonical way to backfill a specific channel and leave the existing `--channel-id` flag as "filter the listing for display only" semantics. Working example of the `extra_channel_names` workaround is in `docs/reports/ella-v2-batch-1-finish-rollout.md`.
- **Logged:** 2026-05-10 (Ella V2 Batch 1 finish-rollout Task 2 finding).

## Gregory brain golden eval harness deferred — same V1 carve-out as Ella

- **What:** M3.4 ships without a formal eval harness. The unit tests cover signal math, scoring rubric, JSON parsing, and end-to-end wiring (37 tests), but there's no golden dataset of "client X should land in tier Y because of reasons Z" that gates rubric changes.
- **Why deferred:** the rubric is iterative — V1.1 is starting points, not locked. Building golden cases against numbers we expect to change wastes effort. Once the rubric stabilizes (~3-6 cron runs in, Drake reviews and tunes), build a 20-case golden dataset that covers the four signal-availability matrix corners (everything-known / cadence-only / action-items-only / nothing-known) plus tier-boundary cases.
- **Revisit triggers:** (a) Drake tunes the rubric in scoring.py and wants regression coverage on the change, (b) a brain run produces a tier that's clearly wrong (a green client who should be red, or vice versa) and we want a fixture to pin that case forever. Aligned with Batch B work.
- **Logged:** 2026-04-29 (M3.4 ship).
