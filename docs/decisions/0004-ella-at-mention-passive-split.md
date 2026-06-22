# ADR 0004: Ella @-mention / passive-monitoring split (synchronous @-handler, observation-only passive)

**Date:** 2026-05-23
**Status:** Accepted
**Decision makers:** Drake (with Director)

## Context

The 2026-05-18 unified-path refactor collapsed Ella's @-mention handling and the passive-observation pipeline into one Haiku-driven classifier. The intent was simplification. The 2026-05-19 evening introduced a separate "mention classifier" (`mention_classifier.py`) whose `acknowledge_and_escalate` shape carried a *navigation* rule — "if the client asks 'what module is X in', that's navigation, escalate." That rule fired on curriculum content questions: a client asking "what module covers cold opens" got an ack-and-escalate ("let me get Scott on this") instead of the curriculum answer Ella has the KB to give. Drake hit it in production within a day.

Three rounds of prompt iteration (`lean toward respond` → `escalate is FORBIDDEN` → `escalate is NEVER allowed plus worked examples`) all failed — the classifier kept rationalizing through the constraint. The 2026-05-21 → 2026-05-23 Anthropic-usage-cap incident compounded it: 181 Haiku calls failed silently with `status='success'` and the failure buried in `output_summary`, masking that Ella had gone quiet on real client questions.

A five-spec diagnostic chain over 2026-05-22 → 2026-05-23 (warm-opener / runs diagnostic → BadRequestError-log investigation → KB retrieval diagnostic → @-mention archaeology against `0347f51^` → the split itself) refuted the retrieval-layer hypotheses and pinned the cause to the classifier's over-aggressive `acknowledge_and_escalate` shape *combined with* the unified-path collapse making `@` and passive share a single decision surface that was tuned wrong for `@`.

Two failure modes were on the table: (i) keep the unified path and iterate the prompt yet again; (ii) split @-mention and passive into structurally separate paths so neither side's tuning could break the other. The team had already burned a session on prompt iteration; the operational pattern "structural fixes beat prompt iteration when an LLM keeps rationalizing through an enumerated decision" (§ Working Norms › Operational patterns) was already documented and applies directly here.

## Decision

**Split the two paths structurally.** They share no decision surface; they share only the underlying retrieval helpers.

### @-mention handler (synchronous, in `agents/ella/agent.py:handle_at_mention`)

The path that fires when Slack delivers an `app_mention` or a `<@Ella>` mention in a channel message:

- **One Sonnet call.** Retrieve KB chunks for the channel-mapped client → one Sonnet 4.6 call with chunks visible in the prompt → structured-JSON output `{response_text: string, escalate: bool, handoff_reasoning: string | null}`. No intermediate classifier, no separate "should I escalate" pre-pass — Sonnet sees the question, sees the retrieved curriculum content, and either answers or escalates in a single pass.
- **Four escalation categories, explicit + bounded** (`AT_MENTION_EXTENSION` in `agents/ella/agent.py`): judgment-call / emotional / money / no-good-context. **No navigation-escalation rule** — the classifier's "what module is X in → escalate" reasoning is structurally absent because there's no separate classifier to host it.
- **Recent-conversational-context plumbing** — the last 3 @-mention exchanges in this channel (`fetch_recent_at_mention_exchanges`, paired by `user_id` not author_type) are appended to the prompt as discrete user/ella pairs. Replaces the prior 15-turn `fetch_recent_channel_context` for the @ path (too broad; brought passive-channel noise into the @ reasoning).
- **Bare-mention short-circuit.** Messages under 5 chars with no other content (`@Ella` alone) get a warm-opener canned response — no LLM call. Pre-LLM gate that handles the common "ping to wake me up" case without spending a Sonnet call to decide it's not a real question.
- **Status honesty.** If the Sonnet call raises, the handler posts a canned graceful line ("I hit a hiccup answering that — let me get your advisor on this one") AND closes the `agent_runs` row with `status='error'` + `error_message`. The 181-silent-failures incident showed that `status='success'` on a failed call is worse than a visible error — operational observability requires that LLM-call failures land as errors, not buried-in-output successes.
- **Identity at the Slack post.** Replies route through `shared.slack_post.post_message_as_user_first` (user-token first via `SLACK_USER_TOKEN`, bot-token fallback) — the M1.4 two-token strategy. Restores @Ella's reply rendering as a human-account post (no APP tag), with automatic fallback if the user token is unset or fails.

### Passive observation path (in `agents/ella/passive_dispatch.py`)

Fires on every client message in a `slack_channels.passive_monitoring_enabled=true` channel that isn't an @-mention of Ella:

- **Observation-only.** Every passive outcome (`respond` / `acknowledge_and_escalate` / `skip` from the decision Haiku) collapses to the same dispatch shape: write `agent_runs` row + (if `digest_flag=true`) write `pending_digest_items` row. **Nothing posted in-channel. No DMs fired.** The decision Haiku's `decision` value is preserved in `trigger_metadata.haiku_decision` for audit but the dispatch layer no longer acts on it differently — the Haiku now exists purely to drive the digest signal.
- **Feeds two downstream surfaces:** the daily digest cron (Slack DM to Scott summarizing flagged client messages) + the unanswered-message flagger (separate cron). No real-time client-facing voice.
- **Deleted code (proof of the split):** `agents/ella/mention_classifier.py` and `agents/ella/digest_response.py` were deleted in the same spec — the unified-path artifacts they represented are structurally gone.

### Architectural-pattern reference

This decision is a direct application of the operational pattern documented in § Working Norms › Operational patterns: *"Structural fixes beat prompt iteration when an LLM keeps rationalizing through an enumerated decision."* The pattern's prescription (bypass the model entirely for the wrong-subset via a pre-LLM structural check OR split the decision into a smaller classifier whose output enum literally cannot fill the wrong value) maps onto this split directly: the @ path no longer has access to the passive decision Haiku's mis-tuned `skip` / `acknowledge_and_escalate` shapes; the passive path no longer has access to client-facing posting. The wrong outcome on either side became *structurally impossible* on the other.

## Consequences

### Positive

- **@-mentions answer curriculum questions again.** The whole point. Tested manually + via the bare-mention warm-opener path; the structural-JSON output contract makes "did the LLM escalate or respond" a simple field-read, not a string-parse.
- **Passive is silent-but-observing.** Drake gets digest visibility without Ella having an in-channel voice that can misfire. The 2026-05-19 regression cannot recur on the @ path because there's no separate classifier to host the broken rule.
- **Status honesty for LLM failures.** Future Anthropic-cap incidents (or any LLM-call failure) land as `agent_runs.status='error'` queryable via SQL; no more 181-silent-failures pattern.
- **Operational observability via SQL.** With the `/ella/runs` audit page since removed (spec `remove-ella-runs-page`, 2026-05-24), `agent_runs` is the durable telemetry surface — the structured-JSON output on the @ path means escalation-category counts are direct `trigger_metadata->>'handoff_category'` queries.
- **Reduced surface area.** Two deleted files (`mention_classifier.py`, `digest_response.py`) + the deleted `/ella/runs` audit page = significant net code removal alongside the behavior fix.

### Negative / accepted

- **The @ dispatch is currently gated behind `passive_monitoring_enabled`.** A channel that has the passive flag OFF won't fire the @ handler either, because the realtime-ingest fork that routes to either path checks the channel toggle first. Accepted: passive is now left on for every Ella-monitored channel (the per-channel toggle exists for explicit opt-out, not default-off), so the gating is a non-issue in practice. If a channel ever needs @ but not passive, the dispatch fork needs a small rework — flagged but not built.
- **Two prompts to keep in sync** — `_AT_MENTION_EXTENSION` in `agents/ella/agent.py` and `_HAIKU_SYSTEM_PROMPT` in `agents/ella/passive_monitor.py`. Any future tightening of the four escalation categories or any addition of a new "don't answer this" rule has to land in both. Mitigated by the `docs/archive/historical/ella-followups.md` reminder; harder mitigation (extract shared escalation-categories constant) is deferred — would require restructuring both system prompts and isn't worth the churn yet.
- **The split doubled the agent-code surface for @ vs passive.** What was one path is now two — more code, more tests, more places to drift. Accepted: the alternative (one shared decision surface) was the design that broke. Structural correctness is worth the surface-area cost.

## Known deviations + status

None at decision time. Future drift would look like: a new "escalate on X" rule landing in only one of the two prompts (mention-side vs passive-side). The grep-the-other-and-reconcile reminder in `docs/archive/historical/ella-followups.md` is the current mitigation.

## Implementation pointers

- **@ handler:** `agents/ella/agent.py:handle_at_mention` (synchronous, structured-JSON output, four escalation categories in the appended `_AT_MENTION_EXTENSION`).
- **Recent-context helper:** `agents/ella/retrieval.py:fetch_recent_at_mention_exchanges` (pairs by user_id, scoped to this channel, last 3 @-exchanges, char-capped per-message and whole-block).
- **Passive dispatch:** `agents/ella/passive_dispatch.py:persist_passive_evaluation` (observation-only writes; no in-channel posts, no DMs).
- **Passive decision Haiku:** `agents/ella/passive_monitor.py:evaluate_passive_trigger` + `_HAIKU_SYSTEM_PROMPT` (decides digest-flag + category; never client-facing).
- **Slack identity routing:** `shared/slack_post.py:post_message_as_user_first` (user-token first, bot fallback, fire-and-forget on a transport exception or Slack `ok=false`).
- **Daily digest consumer:** `api/ella_daily_digest_cron.py` (reads `pending_digest_items` populated by the passive path).
- **Operational runbook:** `docs/runbooks/ella_passive_monitoring.md` (passive-side ops; SQL-only post `/ella/runs` removal).
- **Agent doc:** `docs/agents/ella.md` (behavior spec, both paths, status-honesty + identity-routing sections).
- **Source specs (deleted EOD 2026-05-23):** `ella-at-mention-passive-split` + `ella-at-mention-recent-context` + `ella-reply-as-human`. Recover from git history: `git log --diff-filter=D -- docs/specs/ella-at-mention-passive-split.md`.

## Review

Revisit if: the @ path's structured-JSON output starts mis-parsing at meaningful rate (parser is in `agent.py`; tighten the JSON contract or fall through to a safer default); the passive path needs a real-time voice for any reason (would re-introduce a class of failure modes — needs explicit re-decision, not drift); a new client-facing surface needs a different identity-routing strategy than user-first / bot-fallback; OR the two-prompts-to-sync drift produces a real production miss (then extract the shared constant per the followup).
