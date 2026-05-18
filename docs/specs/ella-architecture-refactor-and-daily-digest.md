# Ella Architecture Refactor + Daily Digest

**Slug:** ella-architecture-refactor-and-daily-digest
**Status:** in-flight

## Context

This spec does two things at once because they're architecturally inseparable: (1) refactors Ella's passive-monitor decision pipeline into a single-Haiku unified-decision model with a much narrower gate set, and (2) introduces a new daily digest DM to Scott (head of fulfillment) + Drake covering every message Ella flagged across all monitored channels.

The motivating context: Scott wants visibility into client-channel activity that's worth a second look — not every message, not just CSM-action-grade escalations, but a curated daily skim of "things worth Scott's eyes." The booking-link case from the weekend of 2026-05-17 is the diagnostic — a client message that wasn't a crisis but went unanswered for 48 hours, costing Scott Monday-morning recovery time. The current CSM-targeted escalation path is too narrow for this purpose; the digest is the right surface.

In parallel, the existing passive-monitor architecture has accumulated several gates (KB-relevance with keyword bypass, CSM-directed, firm-after-first) that were each added for sound reasons but collectively make the system harder to reason about and harder to improve. Drake's call: let Haiku decide more, let pre-LLM gates do less. This spec collapses the gate set to two (kill switch + author type) and gives Haiku the full decision authority.

Drake also wants Haiku to take on some response-generation duties — answering simple program questions directly rather than always paying for Sonnet — with Sonnet as the quality-fallback when Haiku is uncertain.

The new flow runs one decision Haiku call per message (now passing 2-gate filter instead of 5), then conditionally a second response Haiku call when Haiku is going to answer. Decision and response are split into two prompts because conflating "decide what to do" and "generate Ella's voice" in one call degrades both — separate concerns, sharper outputs.

CSM-facing real-time DMs go away on the passive path entirely. The reactive (@-mention) path keeps real-time CSM DMs when Haiku decides the message needs a human, because @-mentions create explicit client expectations that passive observation does not.

The change is significant but the surfaces it touches are well-bounded: `agents/ella/passive_monitor.py` (rewritten), `agents/ella/passive_dispatch.py` (rewritten), `agents/ella/agent.py` (reactive path's escalation routing replaced with new Haiku-decided flow), one new module for the digest cron, one new migration, prompt updates in `agents/ella/prompts.py`, and tests across all of the above.

## Acclimatization checklist

Builder reads these files first and confirms understanding in 4-5 bullets in the report's "What I did" section. Builder also calls out any place where the spec contradicts what these files describe — the spec is the source of truth for this change, but reality-check is load-bearing.

- `CLAUDE.md` § Working Norms, § Director / Builder System, § Critical Rules
- `docs/state.md` § Live System State — current Ella architecture state
- `agents/ella/passive_monitor.py` — the file being substantially rewritten
- `agents/ella/passive_dispatch.py` — the file being substantially rewritten
- `agents/ella/agent.py` — reactive path; the `[ESCALATE]` detector and `fire_escalation_dms` call sites are being replaced
- `agents/ella/prompts.py` — voice prompt to derive trimmed Haiku-response version from
- `agents/ella/escalation_routing.py` — stays in place, but only the reactive path will continue to call into it (passive path's escalation outcome is renamed to `digest_only` and stops calling it)
- `ingestion/slack/realtime_ingest.py` — the `_maybe_dispatch_passive_monitor` function — fork point stays, what it dispatches changes
- `api/faq_digest_cron.py` — pattern to mirror for the new digest cron (CC env var fan-out, audit ledger source, Slack post via `shared.slack_post.post_message`)
- `vercel.json` — cron schedule + function entry pattern

## What's changing — overview

### Gate set (passive path)

Today: kill switch → author type → CSM-directed → KB-relevance (with keyword bypass) → firm-after-first → Haiku → 4 outcomes.

After: kill switch → author type → Haiku → 4 outcomes (different outcomes than today).

The KB vector search itself stays — it just stops being a gate. KB results are passed to Haiku as context. The `_ESCALATION_BYPASS_KEYWORDS` list goes away entirely (it was a patch on the KB-relevance gate, which is gone). The CSM-directed gate is replaced by Haiku's judgment. The firm-after-first gate is removed without replacement — if a message re-mentions a previously-flagged topic, it still flows through normal decision logic and lands in today's digest. Repeat exposure is desirable for Scott's purposes.

### Haiku decision outcomes (passive path)

Today's outcomes: `respond_substantive`, `respond_general_inquiry`, `skip`, `escalate`.

New outcomes: `skip`, `respond_haiku_self`, `respond_via_sonnet`, `digest_only`.

Mapping at a glance:
- Old `respond_substantive` → split into `respond_haiku_self` (Haiku-handled) and `respond_via_sonnet` (Sonnet-handled). The decision Haiku picks which.
- Old `respond_general_inquiry` → removed. Haiku's response prompt handles the "warm acknowledgment when KB is thin" case directly with a short ack; the canned-opener path is no longer needed.
- Old `escalate` → replaced by `digest_only`. The `escalations` table row is NOT written on passive path anymore. The CSM DM is NOT fired on passive path anymore. The message lands in the digest, that's it.
- Old `skip` → same meaning. Most skips are "directed at someone else" or "not a program question."

### Digest flag (independent of decision)

The decision Haiku returns `digest_flag: bool` independently of the decision. Every outcome can flag. The flagging criteria are deliberately permissive — Scott is fine with false positives, the digest is for skimming, not for triggering action.

Always flag when the message involves:
- Emotional content: frustration, overwhelm, defeat, panic, fear, anger
- Refunds, billing, cancellations, contracts, money/commitment topics
- Complaints or dissatisfaction
- Confusion about anything (the program, instructions, expectations, terminology)
- Anything that reads like a human needs to handle it (not Ella)
- Re-occurrence of a previously-flagged topic — flag every time

Flag when in doubt. Don't flag pure non-signal (greetings, acknowledgments, casual chitchat) or clean program questions Ella handles confidently.

The `digest_only` decision auto-implies `digest_flag=true`. Other decisions can flag or not independently.

### Reactive (@-mention) path

Same decision Haiku call as passive. Different routing per outcome:

| Decision | Client-facing | Real-time CSM DM | Digest |
|---|---|---|---|
| `skip` | "Hey [name], I think this one's for [advisor]" + generic ack | no | flagged if `digest_flag=true` |
| `respond_haiku_self` | Haiku's response | no | flagged if `digest_flag=true` |
| `respond_via_sonnet` | Sonnet response | no | flagged if `digest_flag=true` |
| `digest_only` | "Let me grab someone for this one — your advisor will take care of you" | **yes — DM Scott + primary CSM via `fire_escalation_dms`** | always flagged |

Reactive `digest_only` is the only path that fires real-time CSM DMs in the new architecture. This is the deliberate asymmetry — @-mention creates a client expectation of response that passive observation does not.

The existing `[ESCALATE]` token detection in `agent.py:_run` and `agent.py:respond_to_passive_trigger` (Sonnet-side escalation during response generation) is REMOVED. Sonnet no longer emits `[ESCALATE]`. The decision Haiku is now the only escalation decider. Reasoning: dual-decider paths (Haiku decides one way, Sonnet decides another) are confusing and create the failure mode where Haiku said "respond" but Sonnet decided mid-generation that escalation was needed. With Haiku now the single decider, Sonnet's job is response generation only.

The `agents/ella/escalation_routing.py` module stays in place — the reactive `digest_only` outcome calls `fire_escalation_dms` exactly the way the existing reactive `[ESCALATE]` path does today. The `escalations` table row write also stays for reactive `digest_only` (calls `agents.ella.escalation.escalate()` same as today).

### Response Haiku (new)

When the decision Haiku returns `respond_haiku_self`, a second Haiku call generates the response. The response Haiku uses a trimmed version of the existing Sonnet system prompt — same Ella voice, same KB-grounding discipline, same Slack formatting rules, but tightened for shorter outputs and explicit instruction to fall back to Sonnet on any uncertainty.

If the response Haiku returns the literal token `[FALLBACK_TO_SONNET]` anywhere in its output, the dispatch layer detects it, discards the Haiku response, and queues Sonnet via the existing `pending_ella_responses` path. Sonnet generates the response on the per-minute cron tick.

This fallback is the quality insurance. Drake's explicit guidance: keep good quality is the number-one priority; fall back to Sonnet when Haiku is even slightly unsure.

### Cost-handling pattern

Two Haiku calls per message (decision + sometimes response) vs one today is roughly 1.5-2x Haiku spend per message at current decision-rate. Response Haiku replaces some Sonnet calls; Sonnet cost goes down on that subset. Net change: likely flat or slightly up. Current Ella spend is ~$1.25/month total — well under the $200/month watchpoint at any realistic near-term scale.

### Daily digest

New cron at `api/ella_daily_digest_cron.py`. Fires daily at 16:30 EST (20:30 UTC during EDT, 21:30 UTC during EST — pick the EDT mapping since we're currently in DST; document the EST mapping per ADR 0003).

Reads from a new `pending_digest_items` table (added by migration). Each row was inserted when the decision Haiku set `digest_flag=true` on a passive- or reactive-path message. The cron drains all unsent rows in the last 24h, groups by client, formats a digest body, posts to Scott + Drake via `shared.slack_post.post_message`. Per-recipient audit rows under `webhook_deliveries.source='ella_daily_digest'`.

Manual curl with `?since=<iso_timestamp>` overrides the default 24h window for backfill scenarios. First production fire is via manual curl on the spec-completion day.

Recipients:
- Primary: Scott Wilson, resolved at runtime from `team_members` where `access_tier='head_csm'` AND `archived_at IS NULL` (returns one row today — Scott). This mirrors the FAQ digest pattern and auto-handles any future `slack_user_id` change. Spec hard stop: if the query returns zero or multiple rows, the cron writes an error audit row and continues — the spec assumes exactly one head_csm exists, but a future second head_csm would silently get added to the recipient list, which is correct behavior.
- CC: env var `ELLA_DAILY_DIGEST_CC_SLACK_USER_ID=U0AMC23G1SM` (Drake). Optional — unset = Scott only. Gate (d).

Empty-day digest: still fires with body `Ella's daily flags — <date>` `No flags today.` Silent failure (cron didn't run) is worse than empty success.

### What's NOT in this spec

- No changes to the reactive (@-mention) pre-LLM gates beyond what's described (the existing `_handle_bare_mention` short-circuit stays, channel-client resolution stays).
- No changes to the `pending_ella_responses` cron drain path or the per-minute cron itself. The dispatch flow into `pending_ella_responses` works exactly the same way; only the upstream decision tree changes.
- No changes to the existing `/ella/runs` audit dashboard's read path. Builder ensures the dashboard's `extractChannelId` / `extractAuthorRole` / `extractAuthorName` adapters in `lib/db/ella-runs.ts` still cover the new `trigger_metadata` shape (described below). If new fields need surfacing, that's a follow-up spec.
- No changes to the existing `escalations` table or its schema. Reactive `digest_only` writes to it; passive path no longer does.
- No removal of the existing `pending_ella_responses` table. The substantive-response path still uses it.
- No changes to the Slack ingest pipeline (`ingestion/slack/realtime_ingest.py`) other than what the new passive monitor's signature requires. The fork point itself stays.

## What changes — by file

### New: `supabase/migrations/0040_pending_digest_items.sql`

Migration number assumed (`0040`) since `0039` is the most recent per `docs/state.md`. Builder verifies the actual next number against `supabase/migrations/` before writing the file.

Table:

```sql
CREATE TABLE pending_digest_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id uuid REFERENCES agent_runs(id) ON DELETE CASCADE,
  slack_channel_id text NOT NULL,
  triggering_message_ts text NOT NULL,
  triggering_message_slack_user_id text,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  message_text text,
  haiku_decision text NOT NULL,
  haiku_reasoning text,
  digest_category text,
  ella_responded boolean NOT NULL DEFAULT false,
  sent_in_digest_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX pending_digest_items_dedup_idx
  ON pending_digest_items (slack_channel_id, triggering_message_ts);

CREATE INDEX pending_digest_items_unsent_idx
  ON pending_digest_items (created_at)
  WHERE sent_in_digest_at IS NULL;

-- updated_at trigger not needed — rows are insert-once + sent_in_digest_at update.
```

Notes:
- `agent_run_id` FK CASCADE because the digest item is dependent on its source run; if the run is deleted (rare — typically only in test cleanup), the digest item goes with it.
- `client_id` FK SET NULL because the digest needs to survive a client deletion (digest is an audit-shaped surface; the row stays even if the client doesn't).
- Unique index `(slack_channel_id, triggering_message_ts)` is the dedup key — same shape as `pending_ella_responses`. A message that's re-processed (Slack event redelivery, etc.) doesn't double-flag.
- Partial index on unsent rows is what the cron's drain query hits. Filtered by `sent_in_digest_at IS NULL` so the index stays small as historical rows accumulate.
- No `digest_run_id` field — keep the table single-purpose. If we later want per-digest grouping for analytics, add it then.
- Auto-derive `digest_category` from the decision Haiku's output (`question_program | emotional_human_needed | confusion | money_commitment | complaint | other | null`). Free-text column rather than enum CHECK so we can add categories without a migration.

**Hard stop:** Builder runs the apply via the documented path (`supabase db push --linked --dns-resolver https --password "$DB_PW" --yes`) AFTER Drake has reviewed the SQL diff. Gate (a) — SQL review portion.

**Dual-verification post-apply:** Schema reality (`SELECT to_regclass('public.pending_digest_items')` returns non-null; `pg_indexes` shows both indexes) AND ledger registration (`SELECT version FROM supabase_migrations.schema_migrations WHERE version = '0040'`). Public table count goes from 26 → 27.

Schema doc at `docs/schema/pending_digest_items.md` (new) covers purpose, columns, relationships, what populates it (`agents/ella/digest_dispatch.py`), what reads from it (`api/ella_daily_digest_cron.py`), and example queries.

### Rewrite: `agents/ella/passive_monitor.py`

Rewrite the module. Functionally most of the code is being deleted; what remains is restructured around the new decision contract.

Public entry point stays `evaluate_passive_trigger(payload: PassiveTriggerPayload) -> PassiveEvaluation`. Caller (`ingestion/slack/realtime_ingest.py`) doesn't change.

**Inner pipeline:**

1. **Gate 1: Global kill switch.** `ELLA_PASSIVE_MONITORING_ENABLED != 'true'` → silent return. Per Drake's call, no `agent_runs` row when killed — saves DB writes when Ella is globally off and reduces audit noise.
2. **Gate 2: Author type.** Not in `(client,)` unless `test_mode=True` in which case `(client, team_member)`. Skip with synthetic decision + reasoning.
3. **KB vector search.** Top-k=8, same call as today (`search_for_client(..., include_global=True)`). Result is context, not a gate. Empty result is allowed.
4. **Recent channel context fetch.** Last 5 turns via `fetch_recent_channel_context`. Same as today.
5. **Decision Haiku call.** Inputs: triggering message + recent context + KB chunks + speaker info (channel-mapped client name, primary advisor name).
6. Return `PassiveEvaluation` with the decision.

**New `PassiveDecision` dataclass:**

```python
@dataclass(frozen=True)
class PassiveDecision:
    decision: str  # 'skip' | 'respond_haiku_self' | 'respond_via_sonnet' | 'digest_only'
    digest_flag: bool
    digest_category: str | None  # 'question_program' | 'emotional_human_needed' | 'confusion' | 'money_commitment' | 'complaint' | 'other' | None
    reasoning: str
    haiku_cost_usd: Decimal = Decimal("0")
    haiku_input_tokens: int = 0
    haiku_output_tokens: int = 0
```

The four decisions:
- `skip` — directed at advisor by name, conversational chitchat, not a program-related question.
- `respond_haiku_self` — KB has clean direct anchors; Haiku can paraphrase the answer in a single short response.
- `respond_via_sonnet` — KB has anchors but the answer needs nuance, conversational threading, or careful handling.
- `digest_only` — message warrants a human's eyes but Ella shouldn't take the lead (emotional, money/commitment, complaint, confusion, judgment call). No client-facing response from Ella on the passive path; the digest is the surface.

**New Haiku system prompt (decision):**

Below is the working prompt. Builder treats this as authoritative — copy it into the module verbatim. Iteration happens in follow-up commits informed by real-fire data, not at spec-write time.

```
You are Ella's passive-monitoring decision gate. You decide what Ella does when a client message lands in a Slack channel — without anyone asking her directly. Your output is structured JSON, NOT a response to the client.

# WHO ELLA IS

Ella is the AI assistant for clients of The AI Partner, a coaching agency that helps founders build AI-native businesses. Clients have a dedicated Slack channel, a curriculum, and a 1:1 advisor (referred to internally as their CSM, but always called "advisor" with clients).

Ella's job is to be the first line of support — answering program/curriculum questions Ella can answer well, and flagging anything else to a human.

# THE FOUR DECISIONS

You return exactly one decision. Pick the most fitting:

- "skip" — Don't respond. Use this for:
  - Messages directed at the advisor or another team member (by @-mention or by name).
  - Casual chitchat, acknowledgments, emoji reactions.
  - Status updates, screenshot shares, thinking-out-loud posts.
  - Anything where responding would be intrusive or unhelpful.

- "respond_haiku_self" — A different model (also you, but in a separate response-generation call) will answer this. Use ONLY when:
  - The message is a clean, direct, factual question about the program / curriculum / process.
  - The retrieved KB chunks below directly address the question.
  - A short paraphrase-the-KB answer would land well.
  - There's no emotional charge, no judgment call, no money/commitment topic.

- "respond_via_sonnet" — A larger model will generate a thoughtful response. Use when:
  - The message is a program/curriculum question but needs nuance, context, or careful framing.
  - The message references prior conversation that needs threading in.
  - The question is answerable but the right answer has texture Haiku might flatten.

- "digest_only" — Don't respond at all. The message goes to a daily digest for human review. Use when:
  - The message involves emotional content (frustration, overwhelm, fear, anger).
  - The message touches money or commitments (refunds, billing, cancellations, contracts).
  - The message is a complaint or expresses dissatisfaction.
  - The message asks for a personal judgment call about the client's specific situation.
  - The message expresses confusion about the program, process, expectations, or anything that suggests the client is stuck.
  - The KB has nothing useful and the question isn't a simple chitchat — let a human handle it.

# THE DIGEST FLAG (INDEPENDENT)

In addition to the decision, you return a digest_flag boolean. This flag controls whether the message is surfaced in the daily digest to Scott (head of fulfillment) and Drake. The decision and the flag are independent — Haiku can answer a message AND flag it for digest visibility.

ALWAYS set digest_flag=true when the message involves ANY of:
- Emotional content (frustration, confusion, fear, overwhelm)
- Money / commitments (refunds, billing, contracts, cancellations)
- Complaints or dissatisfaction
- Confusion about anything (program, instructions, expectations, terminology)
- Anything that reads like a human needs to handle it
- A previously-flagged topic recurring — flag every time

When in doubt, flag. False positives are explicitly fine.

Set digest_flag=false ONLY for:
- Casual chitchat, greetings, acknowledgments.
- Clean program questions that Haiku or Sonnet will answer confidently.
- Pure non-signal.

Note: digest_only ALWAYS implies digest_flag=true. The flag can also be true on respond_haiku_self / respond_via_sonnet / skip decisions when the message involves any of the above categories.

# THE DIGEST CATEGORY

When digest_flag=true, also return a digest_category string. One of:
- "question_program" — program-related question the human should know was asked
- "emotional_human_needed" — emotional content or a situation needing human handling
- "confusion" — client is confused about something
- "money_commitment" — refund / billing / contract / cancellation topic
- "complaint" — explicit complaint or dissatisfaction
- "other" — flagged but doesn't fit the above

When digest_flag=false, return null.

# DEFAULT STANCE

Skip if uncertain about whether to respond. Flag if uncertain about whether Scott would care.

These two stances are independent because they're answering different questions. "Should Ella speak?" defaults to no. "Should Scott see this?" defaults to yes.

# OUTPUT FORMAT

Return a strict JSON object. No prose around it, no code fences, no commentary.

{
  "decision": "<skip | respond_haiku_self | respond_via_sonnet | digest_only>",
  "digest_flag": <true | false>,
  "digest_category": "<question_program | emotional_human_needed | confusion | money_commitment | complaint | other | null>",
  "reasoning": "<1-2 sentence string explaining the decision, max 300 chars>"
}
```

User prompt template stays the existing shape — triggering message, recent context, KB chunks block.

**Removed from this module:**
- `_ESCALATION_BYPASS_KEYWORDS` constant (gone with the KB-relevance gate)
- `_DEFAULT_KB_RELEVANCE_THRESHOLD` and `_kb_relevance_threshold()` (no longer a gate)
- `_has_escalation_bypass_keyword()` function
- `_is_directed_at_csm()` and the `_SLACK_MENTION_RE` regex (Haiku decides this now)
- `_firm_after_first_match()` and `_content_words()` and `_iso_days_ago()` and `_FIRM_AFTER_FIRST_DAYS` / `_FIRM_AFTER_FIRST_MIN_OVERLAP` / `_STOP_WORDS` (firm-after-first removed entirely)
- `_PASSIVE_DECISIONS` frozenset (updated to new decisions)
- `PassiveEvaluation.bypass_keyword` field

**Kept (rewritten as needed):**
- `PassiveTriggerPayload` dataclass — unchanged
- `_global_kill_switch_on()` — unchanged
- `_fetch_primary_csm()` — unchanged
- `decide_passive_response()` — rewritten with new prompt + new output parsing
- `_parse_haiku_output()` — rewritten to parse the three new fields (decision, digest_flag, digest_category, reasoning)
- `_render_kb_block()` — unchanged

`PassiveEvaluation` dataclass updates:
```python
@dataclass(frozen=True)
class PassiveEvaluation:
    payload: PassiveTriggerPayload
    decision: PassiveDecision
    skip_reason: str | None = None  # 'kill_switch' | 'non_client_author' | 'haiku_skip' | None
    kb_chunks: list[Chunk] = field(default_factory=list)
    recent_channel_context: str = ""
    primary_csm: dict[str, Any] | None = None
```

`skip_reason` vocabulary trimmed — only the two pre-Haiku skips (`kill_switch`, `non_client_author`) and `haiku_skip`. Old `csm_directed`, `no_kb_match`, `firm_after_first`, `exception` are gone (`exception` becomes the safer-fallback in the outer try/except, which still exists for fail-soft).

### Rewrite: `agents/ella/passive_dispatch.py`

Module-level docstring rewritten to reflect new decisions.

**Side effects per decision:**

- `skip` → `agent_runs` row with `status='success'`, `output_summary='skipped (<reason>): <reasoning_truncated>'`. If `digest_flag=true`, ALSO insert a `pending_digest_items` row. (Yes — even skipped messages can be digest-flagged. Example: a refund mention buried in casual chitchat — Haiku skips the response because the message isn't actually a question, but flags for Scott's visibility.)

- `respond_haiku_self` → call new `agents/ella/digest_response.py:generate_response` (the response Haiku). If the response contains `[FALLBACK_TO_SONNET]`, fall through to `respond_via_sonnet` path. Otherwise post the response via `shared.slack_post.post_message` directly. Write `agent_runs` row with `status='success'`, `output_summary=<response truncated>`, full cost accounting (decision Haiku + response Haiku tokens both counted). If `digest_flag=true`, insert `pending_digest_items` row with `ella_responded=true`.

- `respond_via_sonnet` → insert `pending_ella_responses` row exactly as today. Write `agent_runs` row with `status='success'`, `output_summary='queued (respond_via_sonnet); pending_id=<id>'`. If `digest_flag=true`, insert `pending_digest_items` row with `ella_responded=true` (Sonnet hasn't actually responded yet but it will when the cron drains — the digest reads `ella_responded` to mean "Ella is going to respond to this," not "Ella has already responded at this exact moment").

- `digest_only` → no client-facing response, no `escalations` row, no DM. Write `agent_runs` row with `status='success'`, `output_summary='digest_only: <reasoning_truncated>'`. Always insert `pending_digest_items` row (the decision implies digest_flag=true). NO call to `fire_escalation_dms`. NO call to `agents.ella.escalation.escalate`.

**Removed from this module:**
- `_RESPOND_AFTER_DELAY` and the `_insert_pending` 4-minute / 1-minute delay logic for non-Sonnet decisions (Sonnet path keeps it).
- `_write_passive_escalations_row()` — entire function gone.
- All `escalate` / `fire_escalation_dms` / `resolve_escalation_recipients` imports.
- `_format_escalation_summary()` — entire function gone.

**Added to this module:**
- New helper `_insert_pending_digest_item(run_id, payload, decision, evaluation, ella_responded) -> str | None` mirroring `_insert_pending` shape but writing to `pending_digest_items`.
- New helper `_post_haiku_response(payload, response_text) -> dict` calling `post_message` and returning the result dict (success/error). Pattern mirrors the existing `_post_to_slack` shape from `agent.py` if there is one; otherwise straight passthrough.

**`trigger_metadata` shape updates:**

```python
trigger_metadata = {
    "triggering_slack_channel_id": payload.slack_channel_id,
    "triggering_message_ts": payload.triggering_message_ts,
    "triggering_message_slack_user_id": payload.triggering_message_slack_user_id,
    "channel_client_id": payload.channel_client_id,
    "author_type": payload.author_type,
    "haiku_decision": decision.decision,
    "haiku_reasoning": decision.reasoning,
    "digest_flag": decision.digest_flag,
    "digest_category": decision.digest_category,
    "skip_reason": evaluation.skip_reason,
}
if payload.test_mode:
    trigger_metadata["test_mode_run"] = True
```

Removed: `kb_relevance_bypass_keyword` field (was tied to the now-removed bypass list).

### New: `agents/ella/digest_response.py`

New module. Owns the response Haiku call.

```python
"""Response Haiku for Ella's passive-monitor `respond_haiku_self` decision.

Public entry: `generate_response(payload, kb_chunks, recent_context, primary_csm, channel_client)`.

Returns a `DigestResponseResult` carrying the response text + token
counts + cost. The caller (`passive_dispatch`) detects the
`[FALLBACK_TO_SONNET]` token and routes to Sonnet when present.
"""
```

System prompt: a trimmed version of `agents/ella/prompts.py:_BASE_PROMPT`. Trimming guidance:

1. **Keep:** WHO YOU ARE (full), HOW TO FORMAT YOUR REPLY (full — Slack mrkdwn rules are load-bearing for client-facing output).
2. **Keep:** "When you refer to a client's CSM in conversation with them, you call them 'your advisor'" — single most important voice rule.
3. **Replace the WHAT YOU ESCALATE section with:**
   ```
   # WHAT YOU DO IF YOU CAN'T ANSWER

   If you're uncertain about the answer, can't paraphrase the KB cleanly, the question has emotional weight, or anything feels off — return the literal token [FALLBACK_TO_SONNET] anywhere in your response. The backend detects it and hands the question to a larger model. The client never sees the token.

   Better to fall back than to give a weak answer. Quality is the priority. When in doubt, fall back.
   ```
4. **Drop:** WHAT YOU CAN HELP WITH section (collapses to: "Answer questions about the curriculum, process, methodology, onboarding logistics, or the client's own past calls. Lean on the retrieved KB chunks below.")
5. **Drop:** FIRM AFTER FIRST section (no longer relevant — passive responses are stateless single-message answers).
6. **Drop:** WHAT YOU DECLINE section (Haiku-response calls are scoped to questions the decision Haiku already validated as answerable; the decision Haiku enforces the decline criteria).
7. **Drop:** HOW YOU USE THE CONTEXT BELOW section (Haiku's context is simpler; just embed it directly).

The full trimmed prompt is Builder's job to assemble. Builder writes it, includes it verbatim in the report's "What I did" section, and Drake reviews it post-deploy as gate (b)-adjacent — not blocking deploy, but worth a careful read.

User prompt:

```
{triggering_message}

# CONTEXT

Client: {channel_client_name}
Their advisor: {advisor_first_name}

# RECENT CHANNEL TURNS (oldest first; may be empty)

{recent_context}

# KB CHUNKS

{kb_block}

# YOUR REPLY

Reply to the client directly, in Ella's voice. Use Slack mrkdwn. Address the client by first name when natural. Keep it short — paraphrase the KB rather than quoting. If you're uncertain, return [FALLBACK_TO_SONNET].
```

Response Haiku uses model `claude-haiku-4-5-20251001` same as decision Haiku. `max_tokens=800` (room for a real response).

Returns:

```python
@dataclass(frozen=True)
class DigestResponseResult:
    response_text: str
    fallback_to_sonnet: bool  # True if [FALLBACK_TO_SONNET] detected
    cost_usd: Decimal
    input_tokens: int
    output_tokens: int
```

Caller in `passive_dispatch` detects `fallback_to_sonnet=True` and routes to the `respond_via_sonnet` path (insert `pending_ella_responses` row).

### Modify: `agents/ella/agent.py`

The reactive (@-mention) path needs to flow through the same decision Haiku before generating a response.

Current flow: `respond_to_mention` → `_run` → KB retrieval → Sonnet call → `[ESCALATE]` detection → split + DM fan-out OR plain response.

New flow:

1. `respond_to_mention` → bare-mention short-circuit (unchanged) → `_run`.
2. `_run` → resolve speaker + channel client (unchanged).
3. `_run` → KB retrieval (unchanged) + recent channel context (unchanged).
4. **New step: call decision Haiku.** Reuses `agents.ella.passive_monitor.decide_passive_response` with the same prompt and same shape. Reactive messages benefit from the same judgment layer.
5. Route on decision:
   - `skip` → Post a polite generic ack to channel ("Hey [name], I think this one's for [advisor]"). Write `agent_runs` row. Return `EllaResponse(escalated=False)`.
   - `respond_haiku_self` → Call `digest_response.generate_response`. If `[FALLBACK_TO_SONNET]`, fall through to Sonnet path. Otherwise post Haiku response, write run row, return.
   - `respond_via_sonnet` → Call Sonnet via existing `_call_claude` path. Post response, write run row, return. NOTE: `_call_claude` no longer needs `[ESCALATE]` detection because Haiku already made that call.
   - `digest_only` → Post polite ack ("Let me grab someone for this one — your advisor will take care of you"). Call `escalations.escalate()` (writes `escalations` row, this stays on reactive). Call `fire_escalation_dms()` (DMs Scott + primary advisor, this stays on reactive). Insert `pending_digest_items` row (so Drake's digest also sees @-mention escalations). Write `agent_runs` row with `status='escalated'`. Return `EllaResponse(escalated=True)`.
6. Independent of decision: if `digest_flag=true`, insert a `pending_digest_items` row.

**Removed from agent.py:**
- `_ESCALATION_MARKER` constant (Sonnet no longer emits it).
- `_detect_and_strip_escalation()` function.
- All `[ESCALATE]` handling in `_call_claude` (the function still exists for Sonnet generation, just simpler now).
- The Sonnet-side escalation branch in `respond_to_passive_trigger` — Sonnet on passive path is now pure response generation, no mid-generation escalation. If Sonnet wants to fall back, it doesn't get to — the decision is the decision Haiku's, not Sonnet's. (This is a small loss of capability vs today, but the gain in architectural simplicity is worth it. Note in the report's Surprises section.)

**Updated `EllaResponse`:**
Keep the existing dataclass. The `escalated` and `escalation_id` fields stay meaningful on the reactive path (set when `digest_only` fires the DM + writes the row).

**Updates to `respond_to_passive_trigger`:**
- Remove the `[ESCALATE]` detection block (Sonnet no longer escalates mid-generation).
- Remove the `escalate` / `fire_escalation_dms` calls within this function (already gated by decision Haiku upstream).
- Otherwise unchanged.

### Modify: `agents/ella/prompts.py`

Touch this file lightly. Three changes:

1. **Update `_BASE_PROMPT`** to remove the WHAT YOU ESCALATE section (and its `[ESCALATE]` token instructions) and the FIRM AFTER FIRST section. Replace with a much shorter section reflecting the new architecture:

```
# WHAT YOU DO WHEN THE CONVERSATION NEEDS A HUMAN

The system you're part of decides upstream whether a message needs Ella's voice or needs to route to a human. If you're answering, the upstream call decided this is yours. Answer it.

If during your response you find you can't actually answer well — the KB doesn't cover it, the question turns out to have emotional weight, the right answer would require a judgment call about the client's specific situation — STOP generating the response and emit the literal token [FALLBACK_TO_SONNET] (this overrides the Haiku-response path) or just hand off gracefully (the system handles the escalation routing).

Don't try to invent answers. Don't pad with hedges. Better to be honest about the limit than to ship a weak response.
```

2. **Update the WHO IS SPEAKING block's advisor-role variant** to remove the `[ESCALATE]` instructions (advisors never escalated anyway, but the instructions referenced the token).

3. **The `_render_speaker_section`** function's `[ESCALATE]` literal references — the lines that say "Do NOT emit the {_ESCALATE_LITERAL_FOR_PROMPT} token" — remove since the token no longer exists. Replace the constant `_ESCALATE_LITERAL_FOR_PROMPT` with `_FALLBACK_LITERAL_FOR_PROMPT = "[FALLBACK_TO_SONNET]"` and update the references to match the new instruction (advisors don't use the fallback either — they just answer or say "I don't know").

### Modify: `agents/ella/escalation_routing.py` and `agents/ella/escalation.py`

No changes. The reactive `digest_only` path still calls these. Passive path stops calling them.

### Modify: `ingestion/slack/realtime_ingest.py`

The fork point in `_maybe_dispatch_passive_monitor` stays. The functions it calls (`evaluate_passive_trigger`, `persist_passive_evaluation`) have new signatures internally but the same external shape — the fork code doesn't change.

Builder verifies no behavioral drift here. If there's a typed signature mismatch, fix it; if not, leave the file alone.

### New: `api/ella_daily_digest_cron.py`

Mirror the shape of `api/faq_digest_cron.py`. Key differences:

1. **Schedule:** `30 20 * * *` UTC (16:30 EDT during DST). Document the EST mapping (`30 21 * * *` UTC = 16:30 EST after DST falls back) in `docs/runbooks/cron_schedule.md` per ADR 0003. Today is in DST; spec uses the EDT mapping.
2. **Auth:** `CRON_SECRET` validation (same pattern as faq_digest).
3. **Manual override:** Optional query param `?since=<iso_timestamp>` overrides the default 24h window.
4. **Query:** `pending_digest_items` rows where `sent_in_digest_at IS NULL` AND `created_at >= <since>`. JOIN to `clients` for name + primary CSM. JOIN to `slack_messages` (or read from `triggering_message_ts` field) for the message text and Slack permalink resolution.
5. **Format:** Group by client (alphabetical), chronological within client. Each line:
   ```
   • <time HH:MM ET> — <one-line message snippet, max 100 chars>
     Ella's read: <digest_category> — <haiku_reasoning, max 150 chars>
     <permalink> [→ Ella responded if ella_responded=true]
   ```
6. **Empty day:** Body is `Ella's daily flags — <date EST>` `No flags today.` Still fires.
7. **Recipients:** Resolve Scott from `team_members` WHERE `access_tier='head_csm' AND archived_at IS NULL`. If zero or multiple rows, write error audit + continue (zero = no primary recipient, send to CC only; multiple = send to all). Add CC from env var `ELLA_DAILY_DIGEST_CC_SLACK_USER_ID` if set.
8. **Per-recipient audit:** `webhook_deliveries.source='ella_daily_digest'`, one row per recipient, payload includes recipient slack_user_id + cron_run_id + message_count.
9. **Post-send:** Mark all sent rows by updating `sent_in_digest_at = now()` in a single UPDATE. Builder uses a single UPDATE keyed by id list rather than per-row updates (efficiency + atomicity).
10. **Failure isolation:** If one recipient send fails, the other still goes (FAQ digest pattern).

**Permalink format:**
```
https://<workspace>.slack.com/archives/<channel_id>/p<ts_no_dot>
```
Where `<ts_no_dot>` is the `triggering_message_ts` with the period removed. Builder confirms the workspace prefix by checking how existing escalation DMs format permalinks (`agents/ella/escalation_routing.py:fire_escalation_dms` should have a working pattern — copy it).

### Modify: `vercel.json`

Add new function entry for `api/ella_daily_digest_cron.py` with `maxDuration: 60`. Add cron schedule `30 20 * * *` pointing at `/api/ella_daily_digest_cron`.

### Modify: `.env.example`

Add `ELLA_DAILY_DIGEST_CC_SLACK_USER_ID` with a comment explaining it's optional (unset = primary recipient only, Scott).

### Migration: data backfill / cleanup

None. The new tables start empty; old tables stay where they are. No retroactive escalation suppression — the existing 7 client channels' passive monitoring keeps running through the day, today's data lands in the old format, tomorrow's data lands in the new format.

**Operational note:** Builder's deploy goes out on the next push to `main`. Drake will not flip the kill switch — `ELLA_PASSIVE_MONITORING_ENABLED=true` stays as-is. The first message after deploy goes through the new pipeline. There's a brief moment (~10s during the Vercel deploy swap) where in-flight events might land on either side; both sides are correct, so no data loss either way.

### Documentation updates (Builder writes these in the same commit-sequence)

- `docs/state.md` — add a new entry under the dated section for today's date covering this spec's shipped state (full architecture description, migration count bumped to 40, public table count 26 → 27, mention CSM-DM dormancy on passive, mention the digest cron count adds one more Python serverless function bringing the count to 12 from 11).
- `CLAUDE.md` — no changes expected. The Director / Builder topology and core principles are untouched.
- `docs/agents/ella/ella.md` — substantial update. The "Triggers" section, the "Response Location" section, the gate-pipeline description, and the System Prompt Direction section all need rewriting to match the new architecture. Builder rewrites these sections in place.
- `docs/runbooks/ella_passive_monitoring.md` — update Gate pipeline section to reflect 2-gate architecture. Update troubleshooting section to reflect new skip reasons and the `digest_only` outcome. Remove references to escalation DMs on passive (move to a "deprecated behavior" subsection if useful for historical context, or delete outright — Builder's call).
- `docs/runbooks/cron_schedule.md` — add `30 20 * * *` UTC → `16:30 EDT` / `30 21 * * *` UTC → `16:30 EST` for the new digest cron.
- `docs/runbooks/ella_daily_digest.md` (new) — full runbook covering trigger, schedule, recipients, audit SQL, failure modes, manual curl format. Mirror the FAQ digest runbook structure.
- `docs/schema/pending_digest_items.md` (new) — schema doc.
- `docs/known-issues.md` — no expected entries from this spec, but Builder logs anything surfaced.
- `docs/future-ideas.md` — no expected entries unless something gets explicitly deferred.

## Tests

Builder writes tests for each new or modified surface. Target: 90% coverage of the new decision tree's branches. Specific tests required:

**`tests/agents/ella/test_passive_monitor.py`** (rewrite):
- Kill switch off → no `agent_runs` row, returns synthetic skip.
- Author type non-client (no test_mode) → skip with reason.
- Author type team_member with test_mode → proceeds to Haiku.
- Decision Haiku returns each of the four decisions → routes correctly.
- Decision Haiku returns malformed JSON → defaults to skip with reasoning preserving raw response.
- Decision Haiku returns out-of-enum decision → defaults to skip.
- `digest_flag=true` plumbs through to PassiveEvaluation correctly for each decision.
- `digest_category` plumbs through correctly.
- Haiku cost is accurately captured in `PassiveDecision.haiku_cost_usd`.

**`tests/agents/ella/test_passive_dispatch.py`** (rewrite):
- `skip` decision with `digest_flag=false` → agent_runs row, no pending_digest_items.
- `skip` decision with `digest_flag=true` → agent_runs row + pending_digest_items row.
- `respond_haiku_self` decision → calls response Haiku, posts to Slack, writes agent_runs.
- `respond_haiku_self` with `[FALLBACK_TO_SONNET]` → falls through to `respond_via_sonnet` path.
- `respond_via_sonnet` decision → inserts pending_ella_responses row (existing path).
- `digest_only` decision → no client-facing post, no escalations row, no DM, pending_digest_items inserted.
- `digest_only` + ANY decision with `digest_flag=true` → exactly one pending_digest_items row per message (dedup via unique index).
- `pending_digest_items` insert idempotency (re-fire of same message doesn't double-insert).

**`tests/agents/ella/test_digest_response.py`** (new):
- Response Haiku call returns clean response → `fallback_to_sonnet=False`.
- Response Haiku includes `[FALLBACK_TO_SONNET]` token anywhere → `fallback_to_sonnet=True`.
- Response Haiku call errors → safer-fallback returns fallback=True (the dispatch layer then routes to Sonnet).
- Cost accounting captured correctly.

**`tests/agents/ella/test_agent.py`** (modify existing):
- @-mention with decision `skip` → posts generic ack, no escalation.
- @-mention with decision `respond_haiku_self` → posts Haiku response.
- @-mention with decision `respond_haiku_self` + fallback token → posts Sonnet response instead.
- @-mention with decision `respond_via_sonnet` → posts Sonnet response.
- @-mention with decision `digest_only` → posts polite ack, writes escalations row, fires DMs.
- @-mention with `digest_flag=true` on any decision → inserts pending_digest_items row.
- Bare-mention path still short-circuits before the decision Haiku call (unchanged).
- Sonnet response no longer triggers `[ESCALATE]` detection (the path is gone).

**`tests/api/test_ella_daily_digest_cron.py`** (new):
- Happy path: 5 pending items across 3 clients → digest body formatted correctly, both recipients DMed, all rows marked sent.
- Empty day: 0 pending items → digest still fires with "No flags today" body.
- Scott not found in team_members → error audit, CC-only send.
- Multiple head_csm rows → send to all, log warning.
- CC env var unset → primary-only send.
- Manual curl with `?since=<iso>` → uses that window instead of 24h.
- Auth: missing/wrong `CRON_SECRET` → 401.
- One recipient send fails → other recipient still gets DM, error audit row for the failure.

**`tests/ingestion/slack/test_realtime_ingest.py`** (verify, modify if needed):
- The passive-monitor fork still dispatches correctly with the new `PassiveEvaluation` shape.

Total expected test additions: ~50-60 tests across the above files. Existing test count is 607 passing (per `docs/state.md`); target post-spec is ~650-670 passing.

## Hard stops

Builder STOPS and surfaces to Drake when any of the following occur:

1. **Pre-apply: Drake reviews the migration SQL.** Gate (a). Builder writes `supabase/migrations/0040_pending_digest_items.sql`, runs a dry-read (no apply), surfaces the SQL diff to Drake in the report's "What I did" section, and waits for explicit confirmation before applying.

2. **Migration apply discrepancy.** If dual-verify post-apply shows schema reality and ledger registration don't match (e.g., table exists but no ledger entry), STOP. Don't continue with the rest of the spec.

3. **Existing escalation count exceeds 5 in last 7 days.** Before deleting the passive-path escalation code, Builder runs:
   ```sql
   SELECT COUNT(*) FROM escalations e
   JOIN agent_runs ar ON ar.id = e.agent_run_id
   WHERE ar.agent_name = 'ella'
     AND ar.trigger_type = 'passive_monitor'
     AND ar.started_at >= now() - interval '7 days';
   ```
   If the count exceeds 5, STOP and surface the rows to Drake. Reasoning: if passive escalations were firing this week, the dormant change is suppressing real signal Scott was relying on, and Drake needs to weigh whether to ship the digest first (parallel) and dormant escalations later (sequential). If the count is ≤5, proceed.

4. **Test suite regression.** If running `pytest tests/` post-implementation shows fewer tests passing than the 607 baseline, STOP. Identify whether the failures are from the architectural change (expected to update some tests) or from new bugs (not acceptable). Distinguish in the report.

5. **`tsc --noEmit` or `npm run lint` regression.** Builder verifies both pass post-implementation. Any new TypeScript errors or ESLint warnings → STOP and surface.

6. **Hard-numerical threshold: `pending_digest_items` insert failure rate >1% in test traffic.** When Builder runs the spec's smoke test (described below), the insert path must succeed >99% of the time. A higher failure rate indicates a schema or concurrency bug worth surfacing before deploy.

## Smoke test gate (post-deploy, pre-Drake-flip)

After Builder pushes and Vercel deploys, before Drake does anything operationally:

1. **Verify Vercel build succeeded** — check the deploy status via the Vercel dashboard.
2. **Smoke-test the digest cron via manual curl with `?since=<isoT-1h>` against the deploy preview** (or production if no preview is built — confirm before running). Expected outcome: zero rows in `pending_digest_items` from the last hour (the new pipeline hasn't run yet at this point), digest body says "No flags today," both recipients receive the DM, audit rows land.
3. **Smoke-test the new passive pipeline.** Drake posts a test message in `#ella-test-drakeonly` (test_mode=true) covering each decision branch:
   - "How do I find the lesson on sales calls?" → expect `respond_haiku_self` decision, Haiku response posts.
   - "I'm really frustrated with the program lately" → expect `digest_only` decision, no response, `pending_digest_items` row.
   - "Hey Scott, can you check on X" → expect `skip` decision, no response, no flag (unless flag fires on something Scott-related).
   - "What's the meaning of life" → expect `skip` decision, no response.
4. **Verify `/ella/runs` dashboard** shows the new runs correctly. The `extractChannelId` / `extractAuthorRole` adapters should handle the new shape. If they don't, Builder logs as a follow-up in `docs/known-issues.md` (NOT a blocker — the read path is best-effort during this transition).
5. **Manual curl the digest cron to fire an end-of-day digest.** Verify the smoke-test messages from step 3 appear correctly in the digest body for Scott and Drake.

The smoke test is gate (c) — Drake's eyeballs on real surfaces. Builder writes the report after smoke succeeds; if smoke fails, Builder writes a partial report and surfaces.

## What could go wrong

Think this through yourself, what could go wrong. The specific cases Builder must consider and either handle or surface:

1. **Decision Haiku returns malformed JSON.** Already handled in spec — `_parse_haiku_output` defaults to skip. Verify the parsing handles all of: missing fields, wrong field types, JSON-with-prose-prefix, JSON-in-code-fence.

2. **Response Haiku returns a response that's actually bad even without the fallback token.** Risk: Haiku confidently answers wrong because the KB anchors were misleading. Mitigation: the response Haiku prompt explicitly instructs fallback-on-uncertainty. Acceptable residual risk: some Haiku responses will be mediocre vs Sonnet's would-have-been version. Drake monitors via `/ella/runs` and tunes the prompt or raises the fallback bar in follow-ups.

3. **`pending_digest_items` unique constraint fires on legitimate re-fires.** If a Slack `message_changed` event for an existing flagged message comes through, the dedup index prevents a second insert. This is correct behavior — the digest entry stays as-is rather than mutating with each edit. Document this in the runbook.

4. **Digest body length exceeds Slack's 40k character limit.** Unlikely at current volume (5-15 flags/day, each ~200 chars = 1-3k chars total). Belt-and-suspenders: if the formatted body exceeds 35k chars, truncate with a "(... N more flagged messages, see `/ella/runs` for full list)" footer. Surface this safety in the report.

5. **Reactive `digest_only` ack posts but DMs fail to send.** The escalation row writes, ack posts, but Scott/CSM don't get pinged. Risk: client expects follow-up that never comes. Mitigation: per-recipient audit row makes this visible; runbook documents the recovery query. Acceptable residual risk; no code change.

6. **Race condition: decision Haiku decides `respond_haiku_self`, response Haiku decides fallback, but in the meantime client follows up with new message.** Edge case. Acceptable today — the per-minute Sonnet cron handles ordering. Document in known-issues if Builder hits it during tests.

7. **Removed code being referenced elsewhere.** Grep for `[ESCALATE]`, `fire_escalation_dms`, `_ESCALATION_BYPASS_KEYWORDS` to ensure all call sites are updated. Specifically check `lib/db/ella-runs.ts`, `scripts/*`, any test helpers.

8. **Drake reads this and disagrees with a design call.** Builder surfaces points of doubt in the report's Surprises section even when proceeding.

## Mandatory doc updates

Listed above in the per-file section. Restated for clarity — Builder updates ALL of:
- `docs/state.md` (today's entry)
- `docs/agents/ella/ella.md` (substantial rewrite)
- `docs/runbooks/ella_passive_monitoring.md` (substantial rewrite)
- `docs/runbooks/cron_schedule.md` (one-line addition)
- `docs/runbooks/ella_daily_digest.md` (NEW)
- `docs/schema/pending_digest_items.md` (NEW)
- `.env.example` (one new var)

If Builder determines a doc doesn't need updating after all (e.g., the gate-pipeline section of the runbook was already minimal), Builder says so explicitly in the report's relevant section rather than silently skipping.

## Done means

- Migration 0040 applied, dual-verified, ledger registered.
- All file changes pushed to `main`, Vercel deploy successful.
- `pytest tests/` passes with ~650+ tests, no regression from baseline.
- `tsc --noEmit` + `npm run lint` clean.
- Smoke test in `#ella-test-drakeonly` passes for all 4 decision branches.
- Manual curl of the digest cron produces a correctly-formatted DM to both Scott and Drake.
- Spec status flipped to `shipped` in the same Builder commit-sequence that lands the report.
- Report at `docs/reports/ella-architecture-refactor-and-daily-digest.md` follows the 6-section structure.

Spec hard stops + gate (a) + gate (c) all honored. Drake's gates:
- (a) SQL review for migration 0040 — pre-apply.
- (b) Any genuinely context-confusing decision Builder hits — surface immediately.
- (c) Smoke test in `#ella-test-drakeonly` + manual digest curl verification — post-deploy.
- (d) `ELLA_DAILY_DIGEST_CC_SLACK_USER_ID=U0AMC23G1SM` set in Vercel Production env vars — Drake handles pre-Builder-deploy.
