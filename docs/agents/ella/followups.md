# Ella — Followups

Ops reminders and known gaps specific to Ella that aren't "ideas to build" (those live in `docs/agents/ella/future-ideas.md`).

For Gregory's known issues see `docs/known-issues.md`. For Ella's deferred work see `docs/agents/ella/future-ideas.md`.

**Entry format.** Short. Four lines:

- **What:** one-sentence description.
- **Why it matters:** consequence if ignored.
- **Next action:** concrete step that resolves it (or a check that answers whether it needs resolving).
- **Logged:** date.

---

## Co-edit risk on Ella's split prompts (@-handler vs passive decision Haiku)

- **What:** The 2026-05-23 split has two prompts that jointly determine Ella's @-mention vs passive behavior — the @-handler's appended `_AT_MENTION_EXTENSION` in `agents/ella/agent.py` and the passive decision Haiku's `_HAIKU_SYSTEM_PROMPT` in `agents/ella/passive_monitor.py`. Both reference the same content domains and escalation rules, but they're edited independently. The 2026-05-18 unified-rewrite drifted in exactly this way: `_BASE_PROMPT` retained "what a module covers" as answerable while the mention classifier prompt added a contradictory "what module is Y in → escalate" rule. Cost: an entire production regression cycle.
- **Why it matters:** any future tightening of the four escalation categories or any addition of a new "don't answer this" rule needs to happen in BOTH prompts (or it'll drift). The next time a similar contradiction lands, the diagnostic chain (Director + Drake spent ~half a session on it this round) replays.
- **Next action:** when editing either prompt, grep the other and reconcile. Stronger: consider extracting the shared escalation-categories text into a constant both prompts import (would require restructuring both system prompts, deferred). Or: add a CLAUDE.md note that any escalation-rule edit requires touching both files.
- **Logged:** 2026-05-23.

## Status-honesty fix: failed LLM calls now visible on /ella/runs

- **What:** Folded into the 2026-05-23 split. The `agent_runs` rows from failed Sonnet (@ handler) and failed decision Haiku (passive) calls now land with `status='error'` and `error_message` populated, instead of the prior silent `status='success'` with the failure buried in `output_summary`. The 2026-05-21 → 2026-05-23 Anthropic-cap incident logged 181 silent-fail rows; that diagnostic took a Vercel-log dive to root-cause because the database showed nothing wrong. Post-fix, the same incident would be visible with `SELECT count(*) FROM agent_runs WHERE agent_name='ella' AND status='error' AND started_at >= now() - interval '1 hour'`.
- **Why it matters:** observability for the "Ella's gone quiet" failure mode. Resolved.
- **Next action:** none — closed. Listed here as a record so the next observability gap surface knows what the prior shape looked like.
- **Logged:** 2026-05-23.

## Ella user-token posting (M1.4) — DEPLOYED, awaiting Nabeel feedback before pilot rollout

- **What:** M1.4.1 (discovery) → M1.4.2 (operational setup) → M1.4.3 (code change + 14 tests) all shipped 2026-04-27 in commits up to `751cb38`. `api/slack_events.py:_post_to_slack` now uses a two-token strategy: try `SLACK_USER_TOKEN` (xoxp-, posts as @ella user, no APP tag); fall back to `SLACK_BOT_TOKEN` (xoxb-, with APP tag) on any failure. Smoke-tested in `#ella-test-drakeonly` — replies render with no APP tag. Operational rollback (unset `SLACK_USER_TOKEN` + redeploy) takes ~30 sec, no code change. Pinned by `test_no_user_token_uses_bot_directly`.
- **Known constraint surfaced post-deploy:** the *@-mention to invoke Ella* still targets the bot, because Slack's `app_mention` event subscription is bound to the bot user — that's a Slack architectural constraint, not a code choice. The reply renders cleanly as the user; the mention does not. Whether this addresses Nabeel's "looks unprofessional" feedback is open — pending his read.
- **Why it matters:** if Nabeel says current state addresses the ask → invite @ella user to the 6 remaining pilot channels (M1.4.5) and ship. If not → workaround design needed (e.g., custom mention pattern, slash command, accept-and-document the constraint).
- **Next action:** Nabeel feedback first. Then either M1.4.5 pilot rollout (~30 min: invite @ella to each of Fernando G / Musa / Jenny / Dhamen / Trevor / Art channels via the channel UI) OR M1.4.6 design session for the mention constraint. Step-by-step in `docs/architecture/ella_user_token.md` § Deploy + smoke-test runbook.
- **Logged:** 2026-04-27 (M1.4.1 → M1.4.3 implementation + deploy in one day; pilot rollout gated on Nabeel).

## Slack AI/impersonation policy — Drake elected NOT to add "(AI)" suffix; revisit on signal

- **What:** Slack's App Developer Policy prohibits "impersonation of Users or otherwise allow[ing] for false representations within the Application." M1.4.1 read this clause carefully. The intended scope is impersonating a human user without consent — not a dedicated automation account. Many workspaces have non-human user accounts (Zapier, n8n, internal scripts) without policy issues. M1.4.1 *recommended* including "(AI)" in Ella's display name as a cheap defense. **Drake elected not to** — Ella ships as just `Ella` / `@ella` (no AI suffix in the visible display name).
- **Why it matters:** the recommended disclosure was belt-and-suspenders, not strictly required. Drake's call is informed: clients were already announced "Ella, an AI assistant" in the rollout, so the persona is positioned as AI even without the display-name suffix. If Slack ever flags the account, OR if a client expresses confusion about whether Ella is human, the disclosure can be added in seconds via Slack profile settings — no code or token change.
- **Revisit triggers:** (a) Slack support contacts the workspace about the account, (b) a pilot client asks "is Ella a person?" in a way that suggests genuine confusion (vs casual curiosity), (c) any external Slack policy update that tightens the AI-account requirements. Until then: status quo.
- **Logged:** 2026-04-27 (M1.4.1 discovery + post-M1.4.2 Drake decision to skip the suffix).

## `agent_runs.duration_ms` never written — latency observability gap

- **What:** every Ella `agent_runs` row has `duration_ms = NULL`. The column exists, `shared.logging.end_agent_run` accepts the kwarg, but no agent currently times the turn or passes the value through. Cross-logged as a deferred idea in `docs/agents/ella/future-ideas.md` § "`duration_ms` instrumentation on agent_runs" with the full fix plan.
- **Why it matters:** we can't answer "is Ella getting slower over time?" or "which pilot channel is hitting the worst cold-start latency?" from the rows we have. Tokens and cost land correctly (`shared.claude_client.complete()` writes those via its own UPDATE), so the "is she expensive?" question is covered; latency is the observability hole.
- **Next action:** resolution lives in `docs/agents/ella/future-ideas.md`. This followup is the awareness reminder — until that lands, any latency concern needs to be diagnosed from Vercel request timings, not from the DB.
- **Logged:** 2026-04-24.

## Fluid Compute on Vercel — sub-3s user-visible latency path

- **What:** Ella's webhook is synchronous because Vercel's Python runtime kills background threads at response time. Fluid Compute is Vercel's opt-in runtime setting that would let the handler return 200 fast and keep the Python process alive to finish `chat.postMessage` after the response is sent. With Fluid Compute on, we could revert to an ack-then-work pattern and cut user-visible latency back under 3 seconds on cold starts.
- **Why it matters:** current cold-start experience is a 5–10s gap between @mention and reply — acceptable for V1 pilot volume, will get noticeable if pilot usage climbs. The retry-skip branch in `api/slack_events.py` keeps the architecture correct either way; Fluid Compute would just make it feel faster.
- **Next action:** revisit when (a) pilot users flag the lag explicitly, (b) pilot volume makes cold starts visible several times per day per channel, or (c) we're adding a second agent on the same Vercel project and want the runtime choice unified. Toggling Fluid Compute is a project-level setting; enabling it means reverting the sync path in `api/slack_events.py` to the ack-then-thread pattern that was originally designed.
- **Logged:** 2026-04-24.

## Slack signal ingestion to cloud — same gap as NPS for the brain

- **What:** `slack_messages` cloud table is empty (local-only ingestion per `docs/agents/ella/future-ideas.md`). The M3.4 brain V1.1 intentionally omits a Slack-engagement signal because the data doesn't exist server-side; adding the signal in code would just be neutral-for-everyone, no behavior win. Once cloud Slack ingestion lands, add a fifth signal to `agents/gregory/signals.py` (e.g. messages-in-last-14-days, sentiment trend) and re-balance weights.
- **Why deferred:** cloud Slack ingestion has its own followup (`docs/agents/ella/future-ideas.md`); not driven by Gregory.
- **Revisit triggers:** (a) cloud Slack ingestion goes live, (b) a CSM asks for "engagement" as a health signal explicitly. Resolution path: add `compute_slack_engagement(db, client_id)` to `signals.py`, add a weight constant, plumb into `compute_all_signals`, re-balance other weights to keep total at 1.0.
- **Logged:** 2026-04-29 (M3.4 ship).

## Summary chunk embedding goes stale when Fathom regenerates a summary

- **What:** `pipeline._sync_summary_content` updates `documents.content` when Fathom re-delivers a call with an updated `default_summary`, but does NOT re-embed the existing chunk (chunk row is left intact, `embedding` column unchanged). The retrieval index therefore carries an embedding for the OLD summary text while the doc+chunk content column shows the NEW text. Retrieval quality on re-summarized calls may drift.
- **Why it matters:** unknown frequency — F2.1 live-test unknown #3 ("does Fathom ever re-fire `new-meeting-content-ready` with updated summary?") is still open. If Fathom never re-fires, this is a non-issue. If it does, retrieval for re-summarized calls could miss relevant content because the embedding is semantically attached to the prior summary text.
- **Next action:** two tiers: (a) cheap — when `_sync_summary_content` detects a content change, DELETE the summary's chunks so the next ingest pass re-chunks + re-embeds (pipeline's existing `_count_chunks == 0` branch handles the re-insert). One extra embedding call per re-delivered summary. Wire up during F2.4 or as a small follow-up. (b) If live-test reveals re-fires never happen, this entry gets closed with no code change.
- **Logged:** 2026-04-24 (F2.3 architecture nuance).

## Single-chunk summary ceiling at embedding model's input limit

- **What:** F2.3's summary path writes one chunk per call regardless of summary length. `text-embedding-3-small` accepts ~8192 tokens per input (~6000 words) — plenty of headroom for typical Fathom summaries (200–500 words). But a transcript of a 3-hour workshop might produce a 2000+ word summary; near the ceiling but still OK. A future unexpected input shape (e.g., Fathom shipping a full meeting notes doc as the "summary") could overflow.
- **Why it matters:** unlikely today; embedding call would raise `openai.BadRequestError` on overflow, which the pipeline's `except Exception` in the chunk loop catches but logs as a chunk-insert failure. We'd notice only via `webhook_deliveries.processing_status='failed'` rows with a specific error pattern, not via data loss (call still lands; summary just stays empty).
- **Next action:** no action today. If/when a failed delivery traces to "summary too long," add paragraph-aware chunking to `_ensure_summary_document` — split on `\n\n` boundaries, target ~500 words per chunk, same pattern as `chunk_transcript` but for text-shaped input. Estimated ~30 lines of code.
- **Logged:** 2026-04-24 (F2.3 capacity forecast).
