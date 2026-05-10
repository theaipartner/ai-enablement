# Ella V2 — Batch 1.5: behavioral fixes

**Slug:** ella-v2-batch-1-5-behavioral-fixes
**Status:** in-flight

## Context

The Ella interaction audit (slug `ella-interaction-audit`, shipped 2026-05-10) surfaced a concentrated set of mechanical bugs in Ella's V1 behavior. Content quality is consistently good — the audit confirmed her reasoning, persona, and KB retrieval all work well. The bugs are infrastructure: speaker mis-identification, escalation token leakage, an unhandled bare-mention error case, and an architecture (thread-based responses with no conversational context) that was a necessity in V1 but creates friction now.

This spec fixes all of it in one bundled pass before Ella V2 rolls out beyond the test channel. Drake confirmed in chat that bundling all seven changes into one spec is the right call despite exceeding CLAUDE.md's 3-4 task soft cap, because every change touches `slack_handler.py` / `agent.py` / `prompts.py` and splitting risks merge conflicts between passes.

After this lands, Ella's behavior in `#ella-test-drakeonly` should be the gold-standard pattern she'll exhibit when rolled out to the other 7 pilot channels and beyond. The 7 non-test pilot channels will start receiving responses to new messages automatically once this ships (realtime is event-driven; only new messages fire events; no replay-of-old-messages risk per Drake's verified concern).

## Acclimatization checklist — confirm in 5-6 bullets before starting

1. The current shape of `agents/ella/slack_handler.py` — specifically how `handle_slack_event` dispatches today, where the `app_mention` event is currently the sole trigger, and how `_process_mention` is invoked from `api/slack_events.py`. (Builder reads both files to understand the existing event flow.)
2. The current `agents/ella/agent.py:respond_to_mention` signature — what it takes, what it returns, where `trigger_metadata` is populated. The audit revealed `trigger_metadata.user` is currently set to the channel-mapped client regardless of real author; understand WHERE in the agent code that wrongness is introduced before fixing it.
3. The current `agents/ella/prompts.py:_render_context_section` signature — particularly the unused `thread_history` parameter (per future-ideas V2.2, plumbing exists but is never populated). Understand whether thread_history is the right vehicle for the new "last 10-15 channel turns" context, or whether a new parameter is cleaner.
4. The current `[ESCALATE]` detection logic — where it lives, what string it matches, when stripping happens, whether the structured `escalations` row write is coupled to detection. Per CLAUDE.md § Ella § System Prompt Direction point 10, this is "literal token at the start of response" today; the audit showed two cases where Ella generated `[ESCALATE]` mid-response after client-facing text and the detector missed both.
5. The `slack_messages` table schema — confirm we can query "last N messages in channel X by sent_at desc" cleanly. This will be the data source for the new conversational context window.
6. The current bot user_id (`U0ATX2Y8GTD`) vs Ella's human user_id (`U0B03PTJD3P`) — both must be checked for mention-detection, and Builder confirms via `shared.slack_identity.get_user_id_for_token` against `SLACK_BOT_TOKEN` and `SLACK_USER_TOKEN` respectively. Resolved at handler startup or per-request — see Task 7.

## Seven changes, bundled

Per CLAUDE.md § Bundling escape valve, soft cap is 3-4 tasks; we're at 7 because every change touches the same three files and split execution would create merge-conflict risk + repeated context-acclimatization cost. Builder commits each change as its own logical commit per § Commits. Eight commits total (seven changes + final report commit).

---

### Task 1 — Speaker identity resolution

**Goal.** Resolve the *real* `slack_user_id` of the triggering @-mention to either a `clients` row, a `team_members` row, or "unresolvable." Pass the resolved name + role into Ella's prompt so she can address the speaker correctly.

**Why.** Per the audit's Check B' findings: today every speaker in `#ella-test-drakeonly` gets addressed as "Javi" because `slack_handler.py` uses the channel-mapped client as the speaker identity. Nico, Drake, Scott, Aman, Ellis all got called Javi during V1. Same bug will affect every channel once rolled out beyond the test surface.

**Implementation notes:**

- Extract the triggering user_id from the Slack event payload. For `app_mention` events: `event.user`. For `message` events (Task 7): same field.
- New helper, likely in `agents/ella/identity.py` (Builder's call on the path) or as a method on the existing `agent.py`: `resolve_speaker_identity(slack_user_id: str) -> SpeakerIdentity`. Returns a structured object with: `slack_user_id`, `display_name`, `role` (one of `client | advisor | unresolvable`), `client_id` (if role=client), `team_member_id` (if role=advisor).
- Lookup order: first check `clients.slack_user_id`, then `team_members.slack_user_id`. If `team_members.is_csm = true`, role is `advisor`. If team_member but not CSM (Drake, Lou, etc.), role is still `advisor` (per Drake: "advisor" is the public-facing name for any team_member who'd be talking in client channels).
- Fold the resolved identity into `trigger_metadata` on the `agent_runs` row — replace today's wrong `trigger_metadata.user = channel_mapped_client.slack_user_id` with the correct triggering user_id. Add new fields: `trigger_metadata.real_author_role`, `trigger_metadata.real_author_name`, `trigger_metadata.real_author_id`.

**Acceptance test:** in a synthetic event where the triggering user_id resolves to a `team_members` row (e.g., Nico), the prompt receives `speaker.role = 'advisor'` and `speaker.display_name = 'Nico'`. Where unresolvable, `speaker.role = 'unresolvable'` and the prompt receives a generic "you" fallback (handled in Task 2).

### Task 2 — Audience-aware behavior in the prompt

**Goal.** Update `agents/ella/prompts.py` so Ella uses speaker identity correctly. No structural change to her answers — she still pulls from KB, gives the same depth of response, redirects on out-of-scope topics. What changes is name usage and escalation behavior based on role.

**Why.** From the audit + Drake's chat clarifications:
- Today Ella always addresses speakers as the channel-mapped client. Now she addresses by resolved name.
- Today she escalates to Scott regardless of who's asking. Now: if asker is an advisor, she does NOT escalate — advisors handle their own escalation if needed. If asker is a client, escalation behavior is unchanged from V1 (still gates to Scott on out-of-scope content).
- Today she uses "your advisor" generically. Now: she uses the advisor's actual name. Both directions: when speaking to a client, she says "you should talk to Scott" not "you should talk to your advisor"; when speaking to an advisor, she does NOT say "loop in the client" generically, she uses the client's name.

**Implementation notes:**

- Add a new prompt section: `_render_speaker_section(speaker: SpeakerIdentity, channel_client: ClientRow) -> str`. The prompt receives clear, structured info:
  - "The person asking you this question is `<display_name>`."
  - "Their role is `<role>` (client | advisor)."
  - "This channel is mapped to client `<channel_client.full_name>`."
  - "Their advisor is `<channel_client.primary_csm_name>`." (Pulled from the existing channel-client lookup; this gives Ella the name to use when referring to the advisor by name to the client.)
- Adjust the persona section (existing) to conditionally include behavioral guidance:
  - **If `speaker.role == 'client'`:** existing V1 persona stays as-is, with the substitution that "your advisor" becomes "`<advisor_name>`" everywhere.
  - **If `speaker.role == 'advisor'`:** new persona block: "You are speaking with `<advisor_name>`, an advisor on this team. Address them by name. Do NOT escalate to other advisors or to Scott — advisors handle their own escalation. Answer questions about this client's data, the curriculum, or operational topics directly. If genuinely outside your knowledge, say so plainly without redirecting to anyone else."
  - **If `speaker.role == 'unresolvable'`:** safer fallback: "You don't have a verified identity for the speaker. Treat them politely as a generic asker. Avoid using a name. Do not generate `[ESCALATE]` tokens."
- Names always, not roles. Update any prompt instruction that says "your advisor" → use the advisor's actual name. Update any internal Ella behavior that says "talk to your CSM" → use the CSM's actual name (which is the advisor for that client).

**Acceptance test:** in a synthetic conversation where Nico (advisor) asks Ella in Javi's channel, the prompt section contains "The person asking is Nico" and "Do NOT escalate." When Javi (client) asks in the same channel, the prompt section contains "The person asking is Javi" and the V1 persona is in effect.

### Task 3 — Escalation @-mentions

**Goal.** When Ella does escalate (client asking, out-of-scope content), her response @-mentions the advisor explicitly in the response text using Slack's `<@user_id>` mention syntax. The mention triggers a Slack notification to the advisor.

**Why.** Today the `[ESCALATE]` token is a backend-only signal — it strips before the message posts, an `escalations` row writes, but the advisor doesn't actually get pinged in real time. They only know to look at the escalations table or follow up via separate channel. Per Drake: "Worth checking out, `@Scott`" should appear in the response text itself.

**Implementation notes:**

- The prompt instructs Ella that when she escalates, her client-facing response should naturally include an @-mention of the advisor. Suggested phrasing in the system prompt: "When you decide to escalate to the advisor, your response should naturally @-mention them using Slack syntax `<@<advisor_slack_user_id>>` so they get notified. Example: '...this is worth talking through with `<@U09JYRAENPJ>` — Scott, heads up on this question.' Don't just say 'your advisor' — use their @-mention."
- This works because the advisor's slack_user_id is now in the prompt context (Task 2). Ella has all the info she needs.
- The `[ESCALATE]` token at the END of the response (the backend-routing signal, distinct from the user-facing @-mention) still gets generated per V1 contract — Task 4 handles the detector to ensure it's caught wherever it appears.
- An `escalations` row still writes when escalation fires. Both telemetry (escalations table) and immediate notification (in-message @-mention) work together.

**Acceptance test:** a synthetic escalation scenario produces a response where the advisor's `<@U...>` mention appears naturally in the response text AND the `[ESCALATE]` token appears at the end. After detector processing (Task 4), the token gets stripped and the @-mention stays; Slack delivers the message with the @-mention, advisor gets notified.

### Task 4 — `[ESCALATE]` detector loosening

**Goal.** The current detector only catches `[ESCALATE]` at the start of the response. Audit revealed both leakage cases had the token AFTER client-facing text. Loosen the detector to find `[ESCALATE]` anywhere in the response and strip everything from the token to the end before posting.

**Why.** Defense-in-depth. The Task 2 prompt changes should make leakage rarer, but a detector that only matches at the start has zero robustness. Both audit cases had Ella write client-facing text + `[ESCALATE]` + handoff text — the leaked handoff text was what Drake saw in the message you flagged.

**Implementation notes:**

- Find the existing detector (Builder reads the code to locate it; likely in `agents/ella/agent.py` or `agents/ella/slack_handler.py`). Currently matches `response.startswith('[ESCALATE]')` or similar.
- Replace with: find first occurrence of `[ESCALATE]` anywhere in response. If found, slice response to everything before the token. The handoff content (after `[ESCALATE]`) gets used for the `escalations.context.handoff_reasoning` field — not lost, just not posted to Slack.
- If no `[ESCALATE]` token found, response posts verbatim. Existing behavior.
- The function should be a small helper like `_detect_and_strip_escalation(response: str) -> tuple[str, str | None]` returning the cleaned response and the handoff context (or None). Test exhaustively (Builder writes unit tests).

**Acceptance test:** the two audit-flagged leak patterns — `<client-text>\n[ESCALATE]\n<handoff>` and `<client-text> [ESCALATE] <handoff>` — both produce clean responses with the token + everything after stripped, plus a captured `handoff_reasoning` string.

### Task 5 — Main-channel-only mode with last-N-turns context

**Goal.** Ella stops responding in threads. All responses go to the main channel. Her conversational context is the last 10-15 turns from the same channel's main feed (or as much as fits in a reasonable token budget — see threshold below).

**Why.** Per Drake: threads complicate things and were a necessity for `app_mention`-only triggering. With Batch 2's passive monitoring on the horizon and the new dual-trigger detection (Task 7), main-channel responses are the simpler, more natural pattern. Drake will enforce no-thread usage by CSMs; clients rarely use threads anyway.

**Implementation notes:**

- Remove the `thread_ts` parameter from the chat.postMessage call in `_post_to_slack`. Or rather: never pass thread_ts. Responses always land in main channel.
- New function: `_fetch_recent_channel_context(slack_channel_id, before_ts, n_turns=15, max_tokens=2000)`. Queries `slack_messages` for the last N messages in the channel before the triggering message's `sent_at`. Formats each as `[timestamp] <author_type> <resolved_name>: <text>`. If the formatted total exceeds `max_tokens`, truncate from the oldest end and include a note like "[...earlier messages truncated...]". The threshold pattern: if cum-token-count > 2000, trim. Token estimation can be naive (~4 chars per token); precision isn't critical here.
- Pass the context into the prompt via the existing-but-unused `thread_history` parameter on `_render_context_section`, OR add a new `recent_channel_context` parameter — Builder's call on whether to repurpose or add. If repurposing, rename the parameter to `recent_channel_context` for clarity; the V2.2 "fetch thread history" pattern is being subsumed by this anyway.
- The triggering message itself is the "current question" and goes in a separate section of the prompt (not in the recent-context window). This avoids double-inclusion.

**Acceptance test:** synthetic events with N prior messages in `slack_messages` produce a `recent_channel_context` section in the prompt containing those messages, formatted with resolved names. Responses post to main channel, not thread.

### Task 6 — Bare-mention handling

**Goal.** When the message text after stripping the bot/Ella mention is empty or <5 characters, Ella responds with a warm conversational opener instead of crashing the LLM call.

**Why.** Audit run `88556dea-be8b-4803-afb7-373d9e5c2c64` errored with `messages.0: user messages must have non-empty content` because Drake sent `@Ella` with no follow-up. The current path passes the empty string to the LLM and the API rejects. This is V2.3 in future-ideas.

**Implementation notes:**

- In `agents/ella/slack_handler.py` after `_strip_mentions`, check if the stripped text is empty or <5 characters.
- If yes, skip the LLM call entirely. Return a canned response like "Hey `<speaker_name>` — what's up? What can I help with?" The response goes through the normal posting path (Task 5: main channel) and is logged as a normal `agent_runs` row with `trigger_type='bare_mention'` and minimal token usage.
- Keep the response varied — three or four warm openers in a list, randomly selected, so it doesn't feel scripted. Examples: "Hey `<name>` — what's up?" / "Hi `<name>`, what can I help with?" / "Hey `<name>`, what do you need?" / "Hi `<name>` — fire away."
- Speaker name from Task 1's resolution.

**Acceptance test:** sending `@Ella` (no follow-up) to a synthetic channel produces a canned warm response in main channel, no LLM call, no error. Sending `@Ella hi` (5 chars total but >0 after stripping) also goes through this path. Sending `@Ella how do I X` (substantive question) goes through the normal LLM path.

### Task 7 — Dual-trigger detection

**Goal.** Today only `app_mention` events trigger Ella's response. Add a second trigger: in the `message` event handler (`ingestion/slack/realtime_ingest.py`), detect when Ella's HUMAN user_id (`U0B03PTJD3P` via `SLACK_USER_TOKEN`) appears in the message's mentions, and route to `respond_to_mention` just like an `app_mention`.

**Why.** Clients @-ing Ella's human account is a natural interaction pattern — the human account is the "real" Ella from the client's perspective, especially once the bot is renamed to something benign. Without this, clients @-ing the human account get silence.

**Implementation notes:**

- In `ingest_message_event` (in `ingestion/slack/realtime_ingest.py`), after the existing channel-allowlist and subtype gates, after parsing the message: check if Ella's human user_id appears in the message's text or `blocks.elements` mention syntax (Slack messages contain `<@U...>` mention syntax in the text field — parsing is straightforward).
- If yes, AND the message is from a non-Ella, non-bot author (don't trigger on Ella's own messages or the bot's), invoke a thin wrapper that builds an `app_mention`-shaped event from the `message` event and dispatches to `_process_mention`.
- The two paths converge at `_process_mention`. Identity resolution (Task 1), audience-aware prompt (Task 2), escalation @-mention (Task 3), detector (Task 4), main-channel response (Task 5), bare-mention handling (Task 6) all apply to both triggers uniformly.
- Code-level detection. Do NOT route via system-prompt instructions per Drake's chat clarification (system-prompt routing is brittle for trigger detection).

**Acceptance test:** synthetic `message` events containing `<@U0B03PTJD3P>` (Ella's human user_id) in the text trigger `respond_to_mention` with the same flow as an `app_mention`. Messages without that mention go through ingestion only (no response). Messages where Ella herself or the bot is the author do NOT trigger (no self-response).

---

## Hard stops

- **No changes to V1 `app_mention` event handling flow** beyond what's required by Tasks 1-6. The handler still receives and processes `app_mention` events the same way; the response path internally now consults speaker identity and uses main-channel posting. The event subscription itself stays unchanged.
- **No new env vars or scopes.** All required identifiers (bot user_id, human Ella user_id) are derivable from existing tokens.
- **No changes to `vercel.json` or the function URL.** This is internal logic only.
- **No migration to add an `ella_enabled` gate or any other gating mechanism.** Drake explicitly removed this from scope — realtime is event-driven, new messages only, no replay risk.
- **No changes to the `escalations` table schema.** New handoff_reasoning data fits into the existing `context` jsonb column.
- **No changes to call-summary content, NPS handling, or any other Gregory surface.** This spec is Ella-only.
- **If any task can't complete because of a real schema or runtime constraint** Builder didn't know about (e.g., `slack_messages` doesn't have an index that makes the last-N-turns query fast), stop and surface — don't ship a slow path silently.

## Mandatory doc updates

- **`docs/agents/ella/ella.md`** — significant updates:
  - § Response Location — replace "Always respond in-thread" with main-channel-only behavior; remove the pending `reply_broadcast=true` note (it's been superseded).
  - § Behavior Specification § Trigger — add the dual-trigger mechanism (bot @-mention OR human Ella user_id @-mention in `message` events).
  - § Persona and Voice § Style examples — update at least one example to show advisor-asking case (e.g., "Nico — here's what's in Module 3..." style) so future readers see the new behavior.
  - § Confidence-Based Routing § How escalation works — note that escalation now @-mentions the advisor explicitly in the response text.
  - § System Prompt Direction point 10 — update for the loosened detector.
  - Anywhere "your advisor" is referenced in describing behavior, update to reflect "use the advisor's actual name."
- **`docs/agents/ella/future-ideas.md`** — mark these entries as completed/superseded (use existing pattern like the resolved-entries in `docs/known-issues.md`):
  - V2.1 (reply outside thread when contextually appropriate) — superseded by always-main-channel.
  - V2.2 (read prior thread context) — superseded by recent-channel-context.
  - V2.3 (bare-mention handling) — completed in Task 6.
  - V2.4 (speaker identification) — completed in Tasks 1+2.
- **`CLAUDE.md` § Live System State** — append the Batch 1.5 ship as an entry. Suggested wording (Builder tightens):
  > Ella V2 Batch 1.5 — behavioral fixes (shipped <date>). Speaker identity resolution (real `slack_user_id` lookup → clients or team_members), audience-aware prompt (advisor vs client behavior), explicit advisor @-mention on escalation, `[ESCALATE]` detector loosened to match anywhere in response, main-channel-only responses with last-15-turn context window, bare-mention warm-response handler, dual-trigger detection (bot @-mention OR human Ella user_id mention in `message` events). All seven fixes land in a single bundled session; eight commits total. Ella is now ready for the 7-channel pilot rollout.
- **No `docs/known-issues.md` updates** unless Builder surfaces something unexpected during execution.
- **No new schema docs** — no schema changes.
- **No new runbooks** — operational behavior is captured in `docs/agents/ella/ella.md`.

## What could go wrong

Think this through yourself:

- **The `clients.slack_user_id` and `team_members.slack_user_id` populations may be sparse.** If a real client asks Ella but their `slack_user_id` isn't mapped, the resolver returns `unresolvable` and Ella uses the generic fallback. This is correct behavior but might be unfamiliar — flag in the report if many real production users return unresolvable.
- **`is_csm` flag on `team_members` was added in migration 0022.** Confirm it's populated correctly for all relevant team_members. If Nico/Lou/Aman aren't flagged `is_csm=true`, they'd still resolve to role=`advisor` via the team_member match, but the prompt's "advisor" semantics should work uniformly across CSMs and non-CSM team members anyway.
- **The recent-channel-context query at task-runtime might be slow** if `slack_messages` doesn't have a useful index on `(slack_channel_id, sent_at DESC)`. Builder checks the index situation; if missing, add one in this same change (small migration, low-risk) OR surface as a follow-up if it can wait.
- **A message could contain both an `app_mention` AND a `<@U0B03PTJD3P>` (human Ella) mention.** Slack would fire both an `app_mention` event AND a `message` event. The dual-trigger logic must NOT double-respond. Detection: check whether the message has already triggered an `app_mention` response (event_id deduplication, which the handler already has).
- **The `[ESCALATE]` token might appear in user messages** (e.g., a CSM types "we should `[ESCALATE]` this" in chat). Don't strip it from messages we're storing/ingesting — only strip from Ella's own outbound responses.
- **The Ella-bot's user_id (`U0ATX2Y8GTD`) is what shows up as a Slack mention in old messages.** Mention-detection for Ella the human (`U0B03PTJD3P`) shouldn't double-fire on bot mentions. Distinguish carefully.
- **The token budget for recent-channel-context could collide with the system prompt + KB retrieval budget.** Sonnet's context window is large (200k) but actual prompt assembly should still respect a budget. The 2000-token recommendation in Task 5 is a starting point; Builder uses judgment if the assembled prompt feels heavy.
- **Past tests of Ella in `#ella-test-drakeonly` will surface in the new recent-channel-context query.** This is fine; Ella seeing her own past responses is the intended behavior. But verify the "don't trigger on Ella's own messages" rule in Task 7 prevents response loops if she responds to her own past content.

## Commit + report

Per CLAUDE.md § Commits: seven logical work commits + one report commit. Suggested commit messages (Builder tightens to match):

1. `feat(ella): resolve real speaker identity from slack_user_id`
2. `feat(ella): audience-aware behavior in prompt (advisor vs client)`
3. `feat(ella): @-mention advisor explicitly on escalation`
4. `fix(ella): loosen [ESCALATE] detector to match anywhere`
5. `feat(ella): respond in main channel with last-N-turn context`
6. `fix(ella): handle bare @-mention without LLM call`
7. `feat(ella): trigger on human-account mention via message event`
8. `docs: add report for ella-v2-batch-1-5-behavioral-fixes`

If any of these can split further without losing logical coherence (e.g., the prompt changes for Task 2 vs the resolver work for Task 1 could be separate commits), split. The principle is one logical change per commit.

Report at `docs/reports/ella-v2-batch-1-5-behavioral-fixes.md` per the spec/report convention.

After report lands, Drake tests in `#ella-test-drakeonly` to verify all seven fixes are working as designed. Validation is Drake's gate (c) — post-deploy testing on real surfaces.
