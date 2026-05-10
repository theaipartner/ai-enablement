# Ella — Future Ideas

Ella-specific deferred work. Active focus is Gregory; Ella's V2 polish + ingestion-layer + retrieval-layer ideas live here. Per the agency's V2 priorities, Ella resumes once Gregory's CSM-focus pivot stabilizes.

For Gregory's V2 batches see `docs/future-ideas.md`. For Ella's known bugs and ops gaps see `docs/agents/ella/followups.md`.

**Entry format.** Short. Four lines:

- **What:** one-sentence description.
- **Why deferred:** what made this not-now.
- **Revisit trigger:** the concrete event that should pull it back onto the table.
- **Logged:** date.

---

## Repo split when Ella reaches independent-deploy-cycle threshold

- **What:** today's repo holds Ella (Slack agent + ingestion + retrieval), Gregory (dashboard + brain + Path 1 receiver), and shared infrastructure (Supabase migrations, types, the shared validators / claude_client / kb_query / hitl / logging modules, and the unified Vercel project that bundles 5 Python serverless functions + the Next.js dashboard). Splitting into separate repos is a future possibility once friction signals justify it. Ella is the most extractable thing — clear boundaries (its own `agents/ella/` directory, its own webhook function `api/slack_events.py`, its own ingestion pipelines under `ingestion/`, its own Slack-specific schema lookups), clear deploy unit (Slack webhook + an ingestion cron), clear dependency surface (Supabase via `shared/db.py` + Anthropic via `shared/claude_client.py`).
- **Why deferred:** today's friction signals are mostly absent. `next build` runs in ~30s, the Python test suite (381 tests) runs in well under a minute, and there's only one deploy unit so deploy coupling between agents is theoretical. Mental-model overhead is real but bounded — Drake works on one agent at a time, the file tree separates the two cleanly, and CLAUDE.md is the single canonical "where does this fit?" reference. Operational simplicity of one repo + one Vercel project + one CLAUDE.md is real value worth holding onto until something specifically pushes back.
- **Revisit triggers (any one):**
  - Build/test times cross 5 minutes for either agent.
  - Shipping a Gregory dashboard fix has triggered an Ella regression twice (or vice versa) — concrete deploy-coupling cost in incidents, not just theory.
  - Mental-model overload during navigation becomes daily friction (e.g., Drake regularly opens the wrong agent's docs by mistake, or Code-acclimatization-checklist file lists routinely miss the right context because both agents' files compete for relevance).
  - Permissioning needs diverge: a non-Drake team member needs to work on one agent but shouldn't see the other.
  - Deploy lifecycles diverge meaningfully: one agent needs frequent iterative deploys while the other needs change-controlled deploys (e.g., Gregory becomes Scott-facing-stable while Ella is in active iteration on a different agent flavor).
- **Logged:** 2026-05-04.

## Ella V2 — conversational behavior

Four upgrades to how Ella handles Slack conversation flow, all surfaced during pilot testing 2026-04-27. None are bugs in V1 scope; all are "she's correct but feels stiff." Grouped here so they get picked up together, since each one's testing surface (the `#ella-test-drakeonly` channel + the pilot 7) is the same — easier to validate as a batch than one at a time.

**Common revisit trigger for all four: after CSM Co-Pilot V1 ships.** CSM Co-Pilot is the next agent build and the higher business priority. Ella's V2 polish waits for that to land so we don't fragment focus.

### ~~V2.1 — Reply outside thread when contextually appropriate~~ — SUPERSEDED 2026-05-10

Superseded by Batch 1.5's main-channel-only response decision (Task 5). Drake's V2 direction is "always main channel, last-N-turns context window replaces threading as the conversational scaffold." The mixed in-channel-vs-in-thread heuristic this entry proposed is no longer needed — the answer is just "always main channel." Original entry preserved below.

- **What:** today Ella always replies in-thread via `thread_ts` (set in `agents/ella/slack_handler.py` to the original mention's `ts` or thread root). Want her to sometimes reply in the main channel instead — quick acknowledgments ("got it, looking now") in channel; longer / multi-paragraph responses in thread. Today's threading is correct-but-stiff: a "yes" answer in a thread feels weirdly formal.
- **Why deferred:** the rule for in-channel-vs-in-thread isn't crisp. Picking wrong is worse than always-thread. Needs either a heuristic (response length? whether the question itself was threaded?) or a content classification step. Both are V2 territory.
- **Why this matters:** pilot clients are getting tone-perfect content from Ella but the conversational shape feels like a chatbot. Mixing channel + thread replies based on context is what a human teammate does.
- **Revisit trigger:** after CSM Co-Pilot V1 ships.
- **Logged:** 2026-04-27 (M1.3 testing in `#ella-test-drakeonly`); superseded 2026-05-10 (Batch 1.5 ship).

### ~~V2.2 — Read prior thread context when @-mentioned mid-thread~~ — SUPERSEDED 2026-05-10

Superseded by Batch 1.5's recent-channel-context window (Task 5). Instead of fetching thread history per mention, Ella now sees the last 15 messages in the channel before the trigger — sourced from `slack_messages` (cloud-mirrored realtime ingestion) via `agents.ella.retrieval.fetch_recent_channel_context`. Doesn't require a Slack API call per mention; doesn't depend on thread structure; uses the same data Batch 2's passive monitoring will use. Original entry preserved below.

- **What:** when Ella is @-mentioned inside an existing Slack thread (not at thread root), she only sees the mentioning message — the thread's prior turns are invisible to her. The agent should fetch the full thread history via Slack's `conversations.replies` API, format the turns into the existing `thread_history` plumbing in `agents/ella/prompts.py:_render_context_section` (which already accepts a `thread_history` arg, currently unused), and include it in the system prompt so she has conversational context.
- **Why deferred:** requires a Slack API call (`conversations.replies` with `channel` + `ts`) on every mid-thread mention, plus token-budget management for long threads. Scope-wise it's ~50 lines but it's surface area we don't need for the V1 pilot use case (most pilot mentions are at thread root).
- **Why this matters:** as pilot adoption grows, threaded back-and-forth conversations will become normal. Today, asking Ella "and what about Y?" in a thread where she just answered about X gets a confused response because she doesn't see the X exchange.
- **Revisit trigger:** after CSM Co-Pilot V1 ships, OR a pilot client visibly hits the "Ella forgot the thread" failure mode.
- **Logged:** 2026-04-27 (M1.3 testing); superseded 2026-05-10 (Batch 1.5 ship).

### ~~V2.3 — Respond to bare @-mentions~~ — COMPLETED 2026-05-10

Completed in Batch 1.5 Task 6. `agents/ella/agent.py:_handle_bare_mention` branches when stripped text is <5 chars, picks a randomized warm opener from `_BARE_OPENERS_WITH_NAME` (or `_NO_NAME` for unresolvable speakers), and logs an `agent_runs` row with `trigger_type='bare_mention'` and no token consumption. Original entry preserved below.

- **What:** today, mentioning `@Ella` alone (no follow-up message) produces no reply — the agent extracts an empty string after `_strip_mentions` and presumably the LLM returns nothing useful. Should respond to bare pings with a friendly conversational opener like "Hey, what's up?" or "I'm here — what do you need?" so the interaction doesn't feel dead.
- **Why deferred:** trivial fix (~10 lines: detect empty stripped text in `agents/ella/slack_handler.py`, return a canned warm response without going through the agent). But "trivial" multiplies fast — there's no reason to ship this in isolation when V2.1/V2.2/V2.4 all touch the same module.
- **Why this matters:** a Slack ping with no reply feels broken even when nothing was technically wrong. Pilot clients will mention Ella out of curiosity ("hey @Ella"); a silent response erodes trust.
- **Revisit trigger:** after CSM Co-Pilot V1 ships, batched with the rest of V2.x.
- **Logged:** 2026-04-27 (M1.3 testing); completed 2026-05-10 (Batch 1.5 ship).

### ~~V2.4 — Speaker identification beyond the channel's mapped client~~ — COMPLETED 2026-05-10

Completed in Batch 1.5 Tasks 1 + 2. New `agents/ella/identity.py:resolve_speaker_identity` looks up the real `slack_user_id` against `clients` and `team_members` independently of the channel mapping; `agents/ella/prompts.py:_render_speaker_section` renders an audience-aware persona block (client vs advisor vs unresolvable). The audit (`docs/reports/ella-interaction-audit.md`) surfaced that the bug was wider than first thought — `agent_runs.trigger_metadata.user` was itself wrong-by-construction (V1 handler impersonated the channel client) — so Batch 1.5 also stamped `real_author_role/name/id` into trigger_metadata for honest analytics. Original entry preserved below.

- **What:** Ella currently treats every speaker in a pilot channel as the channel's mapped client. In `#ella-test-drakeonly` (mapped to Javi Pena per the test fixture), she addresses Drake as "Javi" because the channel→client resolution defaults to the channel's mapped row. In real client channels with multiple participants (Scott + the client + maybe a partner or assistant), she'd mis-attribute every non-client message as the client. The fix: resolve each Slack message's `user` field to the right `clients` or `team_members` row via `slack_user_id`, and pass that resolved identity into the prompt's "who is asking right now" section.
- **Why deferred:** plumbing change across `slack_handler.py` (asker resolution lookup), `agent.py` (asker context passed through), `prompts.py` (new section for the asker if they're not the channel's mapped client). Not hard but touches multiple files and has prompt-engineering implications (how does Ella address a non-client speaker in a client channel? "Scott, I see Javi is asking..."?). V2 scope.
- **Why this matters:** as soon as a pilot channel has more than one human participant, mis-attribution is visible and weird. Today this doesn't happen because most pilot mentions come from the mapped client themselves. The day Scott jumps into a pilot channel to clarify something and Ella calls him "Javi," credibility takes a hit.
- **Revisit trigger:** after CSM Co-Pilot V1 ships, OR first time a non-mapped-client human messages Ella in a pilot channel and the mis-attribution is visible.
- **Logged:** 2026-04-27 (M1.3 testing — observed Drake being addressed as "Javi"); completed 2026-05-10 (Batch 1.5 ship).

---

## Coaching moments / playbook document type

- **What:** a new `document_type = 'coaching_moment'` (or `'playbook'`) for curated cross-client insights distilled from call summaries — high-signal patterns, scripts, objection handlers — promoted to globally retrievable documents so Ella can surface them to any client who asks.
- **Why deferred:** we need meaningful call volume before the mining is worth doing. Raw calls stay client-scoped by design; the value here is deliberate curation on top, not automatic cross-client leakage.
- **Revisit trigger:** week 6–8 of Ella in production, once there's enough call history that a reviewer can spot recurring themes worth promoting.
- **Logged:** 2026-04-20.

## Explicit metadata conventions for documents and chunks

- **What:** a pinned list of the `metadata` jsonb fields we'll capture at ingestion time for each `document.source` — keyed fields (e.g. `drive_url`, `author`, `module`, `section`, `client_id` for call summaries) versus what stays in a general bag. Chunk-level metadata rules too.
- **Why deferred:** doing this on the fly means re-ingesting docs when conventions shift. Doing it once, up front, saves that pain.
- **Revisit trigger:** before the first Drive ingestion run. Must be resolved before any production ingestion touches `documents`.
- **Logged:** 2026-04-20.

## Re-ranking and hybrid search (BM25 / RRF)

- **What:** layer BM25 (or equivalent keyword search) on top of the current pure-vector retrieval in `match_document_chunks`, combined via Reciprocal Rank Fusion. Improves recall when a query's keyword match is obvious but meaning-match misses it (proper nouns, exact module names, rare jargon).
- **Why deferred:** current retrieval is simple, debuggable, and sufficient for V1. Adding BM25 now trades complexity for speculative gains. V1 beta will surface where pure vector actually falls down.
- **Revisit trigger:** Ella V1 beta shows a clear pattern of retrieval misses that keyword match would have caught — review after the first ~50 production queries and the first 10 `agent_feedback` corrections.
- **Logged:** 2026-04-20.

## Internal assistant agent ("Scout" working name)

- **What:** a second agent configuration of the same shared layer that powers Ella, but with team-wide access — internal call recordings, cross-client call history, team-only documents. Runs in team Slack channels, not client channels. Use cases: team-meeting recall, cross-client pattern detection, institutional memory queries ("what did we decide about X in the Monday sync two weeks ago?").
- **Why deferred:** client-facing Ella V1 is the business priority. The shared layer needs to prove out on the lower-risk client surface before we expose it on the higher-risk internal surface. Internal Scout has broader data access; confidently wrong answers have larger blast radius (strategy, personnel, unfinished decisions).
- **Revisit trigger:** Ella V1 has been in client beta for 2+ weeks with acceptable retrieval and escalation metrics. Internal Scout is likely ~1 focused week of work from there — same agent skeleton, different retrieval filters, different Slack surface.
- **Logged:** 2026-04-21.

## Topic-based chunking for call transcripts

- **What:** chunk transcripts on semantic topic boundaries (detected via a small LLM call per transcript) instead of fixed word windows. More expensive per ingest, potentially better retrieval relevance because chunks align to "what the call was about at this moment" rather than to arbitrary word counts.
- **Why deferred:** requires an extra LLM call per call during ingestion. The current word-window-with-speaker-boundary approach (see `docs/ingestion/metadata-conventions.md` §3) is sufficient for V1 and lets us see real retrieval failures before spending the complexity.
- **Revisit trigger:** Ella V1 beta shows retrieval misses that a topic-aligned chunk would have caught — e.g. a query lands on a half-chunk mid-topic because the word boundary cut through a discussion.
- **Logged:** 2026-04-21.

## match_document_chunks: enforce calls retrievability via SQL join

- **What:** migration `0011` extending `match_document_chunks` to join `calls` on `documents.metadata->>'call_id'` and filter on `calls.is_retrievable_by_client_agents` for client-scoped document types. Moves the invariant from the pipeline (where it lives today — `documents.is_active` is set from the computed retrievability at write time) down to the function layer.
- **Why deferred:** today's pipeline fix (option a) already enforces the invariant at write time, which is sufficient for the V1 backlog ingest. The function-side version is more principled (invariants at the lowest layer, same pattern as migration 0010) but adds a join on every retrieval call and requires careful handling of `metadata->>'call_id'` type coercion. Worth doing when we want defense-in-depth or when the write-side enforcement gets a real counter-example.
- **Revisit trigger:** someone manually flips `calls.is_retrievable_by_client_agents` and forgets to sync `documents.is_active` (production bug), OR a planned durability pass after Ella V1 beta validates the retrieval latency budget for the extra join.
- **Logged:** 2026-04-22.

## Atomic per-call ingest via Postgres RPC

- **What:** replace the non-atomic supabase-py writes in `ingestion/fathom/pipeline.py` with a PL/pgSQL `ingest_fathom_call(...)` function taking call fields + participants + chunks (with embeddings) as JSON and doing every insert/update in one `BEGIN/COMMIT`. Python computes embeddings, hands one RPC call the full payload, gets back row counts.
- **Why deferred:** V1 ingest is a batch job; re-runs are cheap; existing upsert shapes already converge to correct state on partial failure. The RPC would add ~150 lines of PL/pgSQL that's harder to test and evolve than Python.
- **Revisit trigger:** first time partial-failure recovery becomes a real operational problem, OR the first non-batch ingest path (Fathom webhook) where re-run isn't free.
- **Logged:** 2026-04-22.

## Drop denormalized call_category from documents.metadata

- **What:** remove `call_category` from the metadata blob the Fathom pipeline writes to `documents`. It's denormalized from `calls.call_category` for "filter-side speed" but isn't used as a filter in `match_document_chunks`. Removing it means re-classification on the `calls` table can't drift from the documents copy.
- **Why deferred:** small cleanup, not blocking. The denormalized value is harmless until it drifts.
- **Revisit trigger:** tomorrow or this week; dedicated 30-minute PR.
- **Logged:** 2026-04-22.

## Filler filter — collapse adjacent short utterances by the same speaker

- **What:** extend `ingestion/fathom/chunker.py`'s filler filter to also collapse adjacent short utterances from the same speaker within a 1–2 second window. Current filter catches isolated short fillers but lets orphan fragments through when they're their own utterance. Observed in the backlog: `Owen Nordberg [00:02:06]: And.` immediately before the substantive `"He wants just a way..."`; `Rifat Chowdhury [00:01:59]: But I. / I. / I started it...` — three utterances in the same second that should merge into the next one.
- **Why deferred:** retrieval quality is unaffected — embeddings capture semantic meaning, not orphan conjunctions. The fix is a small chunker change but benefits from real-data tuning (threshold: same-speaker + <N-second gap + short text) which is easier once CSM QA starts surfacing read-quality complaints.
- **Revisit trigger:** first time a CSM in QA says "Ella retrieved the right chunk but the content reads janky," OR a systematic read of ~20 chunks spots the pattern >20% of the time.
- **Logged:** 2026-04-22.

## Chunker overlap calibration

- **What:** tighten the ~50-word overlap spec in `ingestion/fathom/chunker.py` §3. Observed overlap on sampled backlog calls is 70–90 words because the speaker-boundary alignment rolls back to include the full preceding utterance, even when that utterance is long. Not breaking, just more retrieval redundancy than intended.
- **Why deferred:** redundancy helps retrieval hit-rate at chunk boundaries and costs nothing on storage at current scale (3528 chunks total). The spec is an aspirational target, not a hard constraint. Fixing means adding a word-count cap on the overlap reach — easy change, low value right now.
- **Revisit trigger:** Ella's retrieval feels like it's surfacing "the same content twice" across adjacent chunks in sampled results, OR storage cost becomes a real line item (not at V1 scale, maybe at 100K+ chunks).
- **Logged:** 2026-04-22.

## Cool-down-on-correction for Ella

- **What:** when Ella receives a `thumbs_down` or `correction` feedback in a channel within the last 24 hours, lower her confidence threshold in that channel so she escalates more eagerly rather than confidently repeat a just-corrected mistake.
- **Why deferred:** V1 optimizes for shipping speed. Correction feedback volume in the first week of client beta is too low for this logic to matter, and the downside (a CSM correcting a confident answer) is the same with or without cool-down for the first handful of corrections.
- **Revisit trigger:** first week of client beta done, first visible correction patterns in `agent_feedback`, OR a specific channel surfaces 2+ corrections in a day.
- **Logged:** 2026-04-22.

## Golden dataset eval harness for Ella

- **What:** curated set of 20+ Q&A pairs covering the four response categories (in-scope, out-of-scope-escalate, out-of-scope-decline, edge/injection). 90% pass rate as the ship gate for future Ella iterations. Replaces "team feel-test" with a reproducible check.
- **Why deferred:** V1 replaces formal eval with live team testing in `#ella-test` over Thursday/Friday for speed. The harness is real work and gets more valuable once we have real-world examples of things Ella got wrong to seed it with.
- **Revisit trigger:** first non-trivial Ella iteration after V1 (prompt changes, retrieval changes, chunking changes), OR first client correction that suggests regression risk from a future change.
- **Logged:** 2026-04-22.

## Per-channel ella_enabled beta gating

- **What:** use the existing `slack_channels.ella_enabled` boolean as the live gate — Ella responds in channels where it's `true`, skips everything else. Controlled per channel via a manual UPDATE or a small admin CLI, no code deploy needed to add or remove a channel.
- **Why deferred:** V1 hardcodes the pilot channel set (7 clients + `#ella-test`) directly in the agent config for speed. `ella_enabled` is already in the schema but the agent doesn't read it yet.
- **Revisit trigger:** first time we need to add or remove a channel without a code deploy — e.g., expanding to a second client cohort, or pulling a specific pilot channel during an incident.
- **Logged:** 2026-04-22.

## Team-test mode flag

- **What:** when a team member (`author_type=team_member`) @mentions Ella, stamp the `agent_runs` row with `trigger_metadata.is_team_test = true` so real-usage analytics can filter out test traffic. Ella still responds normally — the flag is telemetry-only.
- **Why deferred:** V1 has no real-usage metrics to protect yet. Both pilot-client and team-test interactions land in `agent_runs` equivalently for now.
- **Revisit trigger:** when post-launch metrics are being analyzed for the first time and team-generated test traffic in `#ella-test` starts distorting the view.
- **Logged:** 2026-04-22.

## Thumbs-up/down reaction capture

- **What:** Slack reaction-emoji events on Ella's messages feed into `agent_feedback` as `thumbs_up` / `thumbs_down` entries automatically. Requires the Slack Events API subscription (separately deferred — see "Slack real-time ingestion via Events API" below) and a small reaction handler that maps emoji → feedback type → insert.
- **Why deferred:** V1 team testing gets verbal feedback in the test channel directly to Drake/Nabeel. Formal reaction capture becomes valuable post-launch when clients (not team members) are the ones reacting.
- **Revisit trigger:** client beta running AND team wants a passive feedback signal without CSMs having to report issues manually, OR the Slack real-time ingestion pathway ships first and this becomes a cheap bolt-on.
- **Logged:** 2026-04-22.

## Impersonation mode for Ella testing

- **What:** team member can test how Ella would respond as if a specific client were asking — via slash command (`/ella-as <client-email> <question>`) or a message prefix. Drives Ella's retrieval through the target client's scope (their call summaries, their Slack history) so team-test output matches what the real client would see.
- **Why deferred:** V1 testing uses direct @mentions in `#ella-test` by team members. Less realistic than impersonation (the client's specific retrieval context is missing), but faster to stand up and sufficient for "does she embarrass us" sign-off.
- **Revisit trigger:** team wants to simulate specific client scenarios before rolling out significant Ella changes — e.g., testing how a prompt change would affect a known-tricky client's experience.
- **Logged:** 2026-04-22.

## Drive-sourced content ingestion pipeline

- **What:** `ingestion/drive/` that pulls HTML / Google Doc content from Google Drive via the Drive API with version-awareness — re-ingest triggered on `modifiedTime` change, old versions auto-archived (tags `v1_content` → `is_active=false`, new row carries `v2_content`). Complements the filesystem-based `ingestion/content/` that ships today. When it lands, inspect_ingestion query #7 (distinct tag counts) becomes the active/archived-content surface.
- **Why deferred:** filesystem copy handles V1 — the course content is relatively stable and Nabeel can trigger re-ingest manually after a content pass by dropping fresh HTML exports into `data/course_content/`. Drive API + version-awareness + auth setup is real work; not worth it until content revamp cadence exceeds "once a quarter."
- **Revisit trigger:** content stabilizes and Nabeel wants edits to propagate without manual re-copy, OR a second content source (Notion SOPs, methodology docs) needs ingesting — both get addressed by the same API-aware pipeline shape.
- **Logged:** 2026-04-22.

## Client-facing rollout announcement template for Ella beta

- **What:** standard message posted in each client channel before Ella gets added. Draft: *"You've been selected to take part in the beta of our new AI assistant, Ella. She's a pilot to help you get what you need faster, trained on nearly a million data points from client interactions over the last 12 months. @mention her in this channel anytime for help with course content, methodology, or resources. Your CSM is still your primary contact for anything else."*
- **Why deferred:** Ella V1 rollout concern — message only matters the moment a channel gets `ella_enabled = true`. Template + tone want review by Scott/Lou alongside the system prompt before going live.
- **Revisit trigger:** Ella V1 is deployable and ready for first pilot-client channel.
- **Logged:** 2026-04-22.

## Test-fixture client for team-only Ella test channels

- **What:** dedicated synthetic "Test Client" row in `clients` with Drake (or Scott) as primary advisor, plus team-only test channels (`#ella-test-drakeonly`, and a newly-set-up `#ella-test`) mapped to that client's UUID via `slack_channels.client_id`. Alternative shape: a `slack_channels.team_test_channel` boolean that teaches the handler to run without a client mapping at all — pick one, not both. Replaces the current workaround of pointing `#ella-test-drakeonly` at Javi Pena's UUID.
- **Why deferred:** the workaround (Javi Pena's UUID) muddies the team's mental model of what a pilot channel is and what a test channel is, but doesn't break behavior. Was promoted to "active" 2026-04-24; sidelined during the Gregory CS-focus pivot. Resumes when Ella V2 work begins.
- **Revisit trigger:** Ella V2 cycles begin (after Gregory V2 batches A–C stabilize per the canonical batch ordering in `docs/future-ideas.md`), OR the Javi-Pena-as-test-fixture confusion causes a real misclassification or wrong-fact incident.
- **Logged:** 2026-04-23.

## Slack real-time ingestion via Events API

- **What:** Vercel serverless function receiving Slack Events API `message` subscriptions. Parses via `ingestion/slack/parser.py`, upserts to `slack_messages`. Reuses the parser verbatim; adds signing-secret verification and `event_id` deduplication. Complements the REST-based backfill, which stays the right tool for historical imports.
- **Why deferred:** the 90-day backfill covers tonight's team testing and the early pilot. Real-time ingestion only moves the needle once Slack history is embedded into retrieval (see "Slack messages as a retrieval surface" below) — stale-but-embedded Slack history is less useful than live-but-embedded, so the two entries are best revisited together.
- **Revisit trigger:** the retrieval-surface entry ships, OR Ella starts getting asked about same-day Slack conversations she can't see, OR a second manual backfill run becomes necessary inside a week.
- **Logged:** 2026-04-23.

## Backfill team_members.slack_user_id from ingested messages

- **What:** a sweep that takes every `slack_user_id` in `slack_messages` with `author_type = 'unknown'`, calls Slack's `users.info`, and when the email ends in `@theaipartner.io`, updates the matching `team_members` row with the resolved `slack_user_id`. Makes subsequent ingest runs classify those same authors as `team_member` rather than `unknown`. Also helps future Slack-bot features (@mentioning a team member).
- **Why deferred:** today's seed left `team_members.slack_user_id` null. Resolution lazily via messages costs a `users.info` call per unknown author; we'd rather batch that and run it once after the first backfill surfaces the unknown set.
- **Revisit trigger:** query #11 in `docs/runbooks/inspect_ingestion.md` shows more than ~20 distinct unresolved authors OR the first time a team @mention in a Slack channel needs to resolve to a `team_members.id`.
- **Logged:** 2026-04-22.

## Slack messages as a retrieval surface (V1.1)

- **What:** chunk + embed `slack_messages` text into `document_chunks` under a new `document_type = 'slack_message_chunk'`, metadata-gated per client the same way transcript chunks are. Maximally useful alongside real-time ingestion (see "Slack real-time ingestion via Events API" above), but the backfilled 90-day window alone would already let Ella reference prior in-channel conversations.
- **Why deferred:** V1 ships with course content plus Fathom call summaries as Ella's retrieval surface. Slack history embedding is additive — more ingest tokens, more noise in the retrieval pool — worth doing once live testing shows a concrete gap Ella can't cover from the two existing surfaces.
- **Revisit trigger:** a team-test or client question surfaces that Slack history would have answered AND course content + Fathom calls didn't, OR strong signal on that immediately after Monday's launch.
- **Logged:** 2026-04-23.

## LLM post-processing for Fathom speaker misattribution

- **What:** a Claude pass per transcript to fix obvious speaker misattributions from Fathom's diarization. Observed in the backlog: quotes attributed to the wrong speaker based on conversational flow (e.g., `"you have a tendency to over-engineer"` attributed to the person being described rather than the person doing the describing). This is a Fathom quality ceiling, not a pipeline bug — the TXT export faithfully records what Fathom produced.
- **Three paths** (not mutually exclusive):
  - **(a) Hedge in Ella's system prompt** — ships for free when Ella's prompt is written. Captured below.
  - **(b) LLM post-processing pass over stored transcripts** — ~$5–10 one-time for the 389-call backlog, rewrite `calls.transcript` + chunk content with corrections; requires an eval because "fix based on conversational flow" is LLM judgment that can itself misattribute.
  - **(c) Improve Fathom upstream** — voice profiles, speaker labels in calendar invites, post-meeting tagging by the host. Reduces future drift; doesn't fix the backlog.
- **Why deferred:** path (a) is cheap and sufficient until we have evidence of real client-facing impact. Paths (b) and (c) add real cost and don't solve the backlog-vs-future-calls problem cleanly on their own.
- **Revisit trigger:** first client complaint of "Ella said I said X but I didn't," OR multiple CSM QA flags on misattributed quotes in retrieved chunks.
- **Logged:** 2026-04-22.

## `duration_ms` instrumentation on agent_runs

- **What:** pass `duration_ms` through to `shared.logging.end_agent_run` from every agent. The column exists on `agent_runs`, the helper accepts the kwarg, but no agent currently times the turn — every row written by Ella today has `duration_ms = NULL`. Minimal fix: capture `time.monotonic()` at the top of `respond_to_mention` and pass the delta to `end_agent_run` on every terminal path (success / escalated / error / skipped).
- **Why deferred:** surfaced during the 2026-04-23 local harness run; decided not to block Ella V1 beta on it. Token counts and cost already land on the row via `shared.claude_client.complete()`, which covers the "is she expensive?" question; latency observability is a nice-to-have for perf tuning, not a safety property. Also: the same gap likely exists in whatever agent ships next, so fixing it once globally (e.g., a context manager in `shared/logging.py` that wraps `start_agent_run` / `end_agent_run`) is worth more than a per-agent patch.
- **Revisit trigger:** (1) first time we need to diagnose a perceived-slow Ella response from a real client thread, OR (2) when the eval harness lands and we want per-run latency as a metric, OR (3) CSM Co-Pilot gets built and would benefit from the same instrumentation — whichever lands first.
- **Logged:** 2026-04-23.

## pg_dump local embeddings to cloud to skip re-embedding on large loads

- **What:** for ingestion runs where the chunks + embeddings already exist in the local Supabase, `pg_dump` the `documents` + `document_chunks` rows from local and restore into cloud, instead of re-running the ingestion pipeline against cloud (which re-chunks and re-pays the OpenAI embedding cost). Narrow scope: just rows whose embeddings are stable — typically `course_lesson` and `call_transcript_chunk` where the source hasn't changed.
- **Why deferred:** for the Fathom backlog at ~389 calls / ~3,528 chunks the re-embed is ~$5–15 and ~10–30 min — not painful enough to justify the dump/restore dance, which brings its own risks (row-id collisions, RLS interactions, accidentally copying stale metadata). The cost/complexity crossover point is somewhere north of 10k chunks or a corpus that'd cost >$50 to re-embed.
- **Revisit trigger:** next corpus load that'd cost >$50 to re-embed OR take >1 hour, whichever lands first. Likely candidates: a Drive-sourced content ingestion once we have the full course library (vs. today's curated subset), or a second pass that re-chunks call transcripts with topic-based chunking (see entry above).
- **Logged:** 2026-04-24.

## Ella profile picture + branding

- **What:** upload a custom app icon for Ella in the Slack app console (api.slack.com/apps → your app → Basic Information → App-Level App Icon) so she stops showing up as the default Slack gear avatar in client channels. Branding direction (warm / on-theme-with-TAP / distinctive) is TBD — needs a design pass or a handful of options to choose from.
- **Why deferred:** purely cosmetic; doesn't block any V1 functionality. Real clients will see her as the default avatar in the pilot, which looks unfinished. Worth landing before wide pilot rollout but not before the core loop is validated.
- **Revisit trigger:** before the expanded beta (beyond the 7 pilot clients), OR the first time a client reacts to Ella's appearance in a way that suggests the avatar's hurting trust.
- **Logged:** 2026-04-24.
