# Ella escalation unification — prompt diff approval + finish remaining wiring

**Slug:** ella-escalation-unify-prompt-approval
**Status:** in-flight

## Context

Addendum to `docs/specs/ella-escalation-unify-and-route-to-scott.md`, which Builder partially executed and halted on per the gate-(b) hard stop for the `prompts.py` edit. The structural work landed cleanly (new `escalation_routing` module, passive path rewiring, `escalations` table symmetry, 524-test suite green). Remaining work is the reactive wiring + the prompt edit + the passive Sonnet-side branch + tests + doc updates.

Builder's partial report at `docs/reports/ella-escalation-unify-and-route-to-scott.md` is the source of truth for what's already done. Read it before starting.

## Decision: prompt diff is approved with specific edits

Builder proposed the diff in their Code chat (Director hasn't seen it directly). Director's independent read of `agents/ella/prompts.py` yielded the diff below, which Drake approved in chat. **This is the canonical diff** — if Builder's earlier proposed diff differs, Builder uses this one.

### Edit 1: `# WHAT YOU ESCALATE` instruction paragraph + example

**Find:**

```
Write the ack naturally and address the advisor by first name when you know it. The WHO IS SPEAKING section gives you the advisor's name and their Slack mention syntax (e.g. <@U09JYRAENPJ>). Include the advisor's Slack mention in the ack itself so Slack notifies them in real time — don't just say "your advisor", use the mention. Keep the ack short. Don't over-apologize.

Complete example shape:

That's a hard place to be — let me loop in <@U09JYRAENPJ> on this one, Scott will follow up with you directly.

[ESCALATE]
Client is feeling stuck on whether to fire their largest account. Asked for a judgment call — handing off so you can talk it through.
```

**Replace with:**

```
Write the ack naturally. Acknowledge the client's question warmly, signal that someone will follow up, and keep it short. Don't over-apologize.

DO NOT include any Slack user mentions (no <@U...> syntax) in escalation acks. Backend routing now handles notifying the right person — your job is the warm acknowledgment to the client only. Don't name the advisor by first name in the ack either; the routing may not always go to the channel's listed advisor.

Complete example shape:

That's a hard place to be — let me make sure the right person sees this. Someone will follow up with you shortly.

[ESCALATE]
Client is feeling stuck on whether to fire their largest account. Asked for a judgment call — handing off so you can talk it through.
```

### Edit 2: `# FIRM AFTER FIRST` cleanup

The FIRM AFTER FIRST section currently references `<@advisor_id>` syntax in its example. Under the new model, no escalation-shaped message from Ella contains an `<@...>` mention. Find:

```
Route harder — something like "worth picking this up with <@advisor_id> directly" — rather than restating the same framework or answer.
```

Replace with:

```
Route harder — something like "worth picking this up with the right person directly" — rather than restating the same framework or answer.
```

### Edit 3: `_render_speaker_section` — advisor Slack mention syntax line

The function currently appends a line like `Advisor Slack mention syntax: <@U09JYRAENPJ>` when an advisor `slack_user_id` is present. Under the new model, Sonnet shouldn't need this mention syntax for escalations. **However**, the mention syntax may still be useful in non-escalation conversational contexts (e.g., "your advisor Lou will reach out about that on your next call" — where Slack syntax could turn the name into a notification ping).

**Decision: leave this line in place.** Sonnet has the data, the prompt body forbids using it in escalation acks, and removing the data entirely risks tripping the case where Sonnet wants to ping the advisor in non-escalation conversation. The prompt's explicit prohibition in `# WHAT YOU ESCALATE` is what enforces the new behavior; the data line stays as available context.

**No edit needed to `_render_speaker_section`.** Builder confirms this is the right call in their report's "Surprises and judgment calls" section if they agree.

## What Builder needs to do (resume from partial)

### 1. Apply the three prompt edits above

Read `agents/ella/prompts.py`. Apply Edits 1 and 2 as `str_replace` calls. Edit 3 is a no-op confirmation.

### 2. Wire reactive `_run` (`agents/ella/agent.py`)

After `escalate()` writes the `escalations` row in the marker-detected branch:

```python
from agents.ella.escalation_routing import fire_escalation_dms, resolve_escalation_recipients

# ... after escalation_id = escalate(...) ...

primary_csm_dict = context.primary_csm  # already available from the retrieval bundle
recipients = resolve_escalation_recipients(primary_csm_dict)
fire_escalation_dms(
    recipients=recipients,
    slack_channel_id=channel_id,
    triggering_message_ts=event_data.get("ts"),
    reasoning=handoff_context or "(no handoff context provided)",
    path="reactive",
)
```

The client-facing post of `client_text` to the channel stays exactly as today — the Slack handler layer posts `EllaResponse.response_text`. The only change is the added DM fan-out and the now-mentionless ack (from the prompt edit).

### 3. Wire passive Sonnet-side escalation (`agents/ella/agent.py:respond_to_passive_trigger`)

In the branch where `handoff_context is not None`, after `escalate()` writes the `escalations` row, fire the same fan-out:

```python
recipients = resolve_escalation_recipients(context.primary_csm)
fire_escalation_dms(
    recipients=recipients,
    slack_channel_id=synthetic_event["channel"],
    triggering_message_ts=synthetic_event["ts"],
    reasoning=handoff_context or "(no handoff context provided)",
    path="passive",
)
```

Keep the `posted=False, slack_error="sonnet_side_escalation"` return — that's correct; this path doesn't post to channel.

### 4. Test updates

- `tests/agents/ella/test_agent.py` — extend the reactive escalation tests to:
  - Mock `fire_escalation_dms` and assert it's called with `path="reactive"`, the right `recipients`, the right `reasoning`.
  - Assert the client-facing `response_text` no longer contains `<@U...>` syntax (use a regex assertion, not an exact string match, since the LLM output varies).
  - Add a test for the passive Sonnet-side escalation branch in `respond_to_passive_trigger` — Sonnet returns text with `[ESCALATE]`, assert `fire_escalation_dms` is called with `path="passive"`, assert `posted=False`.
- All other test files: unchanged.

### 5. Doc updates

- `docs/agents/ella/ella.md` — Escalation behavior section rewritten to describe:
  - Three escalation moments (reactive, passive Haiku-decided, passive Sonnet-decided), all fan out through `fire_escalation_dms`.
  - All three write `escalations` rows.
  - Only the reactive moment posts a client-facing ack; the two passive moments are silent in channel.
  - All DMs go to Scott (via env var) + primary CSM, dedup'd.
  - Safer fallback: env var unset → primary CSM only.
- `docs/runbooks/ella_passive_monitoring.md` — section on escalation DMs updated to reflect the dual-recipient behavior + the renamed `webhook_deliveries.source='ella_escalation_dm'` filter.
- `docs/state.md` — new entry under the most recent dated subsection. Format and length should mirror the surrounding entries; describe what shipped, mention the env var, the three escalation moments, the persistence symmetry, the audit-source rename.

### 6. `.env.example`

Confirm `ESCALATION_RECIPIENT_SLACK_USER_ID` is present (Builder reported it as added in the partial). If not, add it.

## What success looks like

Same as the original spec § What success looks like. Specifically:

1. Reactive @-mention escalation in `#ella-test-drakeonly`: client-facing ack with NO `<@U...>`, DM to Scott, DM to primary CSM, one `escalations` row.
2. Passive Haiku escalation: no in-channel post, DM to Scott, DM to primary CSM, one `escalations` row.
3. Passive Sonnet-side escalation (Haiku said respond, Sonnet said escalate mid-flight): no in-channel post, DM to Scott, DM to primary CSM, one `escalations` row.
4. Env var unset: primary CSM only, logged warning, no errors.
5. `pytest tests/` green.
6. Dashboard `/ella/runs` renders all three shapes identically.

## Hard stops

- **No further prompt edits beyond the three above.** If Builder wants to change anything else in `prompts.py`, surface to Drake first.
- **No migrations.** Same rule as the original spec.
- **No `agent_runs.status` semantic changes** beyond what Builder already landed in the partial (`status='escalated'` for passive escalations, matching reactive).

## What could go wrong

- **Sonnet's ack post-prompt-edit feels cold or robotic.** The new example is "let me make sure the right person sees this — someone will follow up with you shortly," which is intentionally vague. If post-deploy Drake reads acks in production and they feel off, that's a prompt-tuning followup; not blocking.
- **The reactive client-facing ack post no longer has an `<@U...>` notification.** That means the assigned CSM doesn't get a Slack push notification in-channel like they used to. The DM to them replaces that. Verify Slack DM notifications are actually firing for primary CSMs as part of the post-deploy smoke test (gate (c) — Drake's job).
- **Builder applied a slightly different prompt diff in their original proposal.** Confirm the diff applied is the one in this spec, not the earlier proposal.

## Mandatory doc-update list

- `agents/ella/prompts.py` — Edits 1 and 2 applied; Edit 3 is no-op.
- `agents/ella/agent.py` — reactive `_run` + passive Sonnet-side `respond_to_passive_trigger` wired through `fire_escalation_dms`.
- `tests/agents/ella/test_agent.py` — reactive escalation tests extended; passive Sonnet-side escalation test added.
- `docs/agents/ella/ella.md` — Escalation behavior section rewritten.
- `docs/runbooks/ella_passive_monitoring.md` — escalation DM section updated.
- `docs/state.md` — new entry describing what shipped.
- `.env.example` — confirm `ESCALATION_RECIPIENT_SLACK_USER_ID` is present.

## Commit shape

One commit for the code + prompt + tests ("feat: complete Ella escalation unification — wire reactive + Sonnet-side passive paths, drop advisor mentions from prompt"). One commit for docs. One commit for the report. Push at end.

When the work ships, flip both this spec's `Status:` to `shipped` AND the original `ella-escalation-unify-and-route-to-scott.md`'s `Status:` to `shipped` in the same commit.
