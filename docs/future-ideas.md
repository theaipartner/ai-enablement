# Future Ideas — Gregory V2

This file enumerates Gregory's V2 work organized into batches A–E. Active focus is **Batch A — CSM accountability visibility**. Each entry has a revisit trigger so it doesn't go stale.

For Ella's deferred work see `docs/agents/ella/future-ideas.md`. For Gregory's known bugs and ops gaps see `docs/known-issues.md`. For architectural decisions, see `docs/decisions/` (when populated).

**Entry format.** Short. Four lines:

- **What:** one-sentence description.
- **Why deferred:** what made this not-now.
- **Revisit trigger:** the concrete event that should pull it back onto the table.
- **Logged:** date.

---

## Batch A — CSM accountability visibility

**Top priority. Active.** The CS-focus pivot for Gregory V2 starts here. Goal: make every CSM's daily accountability signal visible without anyone having to remember to look at the dashboard.

### Per-call CS Slack summary

- **What:** Fathom call summary auto-posts to a cross-CSM Slack channel on every call completion. Triggered by the existing Fathom realtime webhook (M4.1). Each post carries client name, call date, primary CSM, and the Fathom-generated summary. Cross-CSM channel so the team sees what each other are doing without having to ask.
- **Why deferred:** Batch A scope-of-work; not blocked on anything technical (the Fathom webhook is live, summaries land in `documents` with `document_type='call_summary'`). Implementation is a small Slack `chat.postMessage` from inside the existing webhook handler or a separate trigger.
- **Revisit trigger:** active — start of Batch A work.
- **Logged:** 2026-05-05.

### Daily 7am EST accountability notification

- **What:** three Slack messages per CSM, posted to an internal CS channel at 7am EST daily, listing clients who skipped accountability the prior day. Reads from Path 2 outbound roster's `accountability_enabled` filter. Cron-scheduled.
- **Why deferred:** Batch A scope-of-work. Path 2 outbound roster (M5.7) provides the actionable client roster; the daily Slack post is the consumer. Shape of the three messages (likely: green-light list of who DID complete accountability + amber-list of who skipped + red-list of multi-day skippers) needs Drake's confirmation before build.
- **Revisit trigger:** active — start of Batch A work.
- **Logged:** 2026-05-05.

### Missed/unrecorded call detection

- **What:** Google Calendar integration that reads each CSM's calendar daily, diffs against the `calls` table, and Slack-alerts when a calendar event tagged as a CSM call has no matching `calls` row within the expected time window. Catches both "the call happened but Fathom didn't record" and "the call didn't happen but the calendar said it would."
- **Why deferred:** depends on (a) Google Calendar API auth setup per CSM, (b) clear naming convention for "this is a CSM call" calendar events so the diff logic is unambiguous. Both are operational decisions Drake handles before the build.
- **Revisit trigger:** Batch A active work; depends on Fathom team-settings cleanup landing first (see entry below).
- **Logged:** 2026-05-05.

### Call tagging dashboard — per-CSM monthly call counts split by tag

- **What:** dashboard view that shows each CSM's monthly call counts split by tag (sales / coaching / churn-save / handover / etc.). Surfaces who's spending time on what. Depends on CSM ops adoption of a tagging convention — without consistent tagging, the view is meaningless.
- **Why deferred:** the tagging convention itself is the bigger lift. Once tags are reliable the dashboard is straightforward (M5.5 filter framework already supports adding new dropdowns; same `.in()` pattern).
- **Revisit trigger:** CSM ops adopts a tagging convention AND ~2 weeks of tagged calls accumulate to validate consistency.
- **Logged:** 2026-05-05.

### Fathom team settings cleanup (CSM call duplicate-recording bug)

- **What:** CSM calls are getting recorded multiple times when participants leave/rejoin in sequence. The notetaker is tied to the host's session, so when the host leaves, the notetaker leaves; if another participant stays and re-triggers a notetaker, a second recording starts. A third can spawn the same way. Result: same call ingested as 2-3 separate `calls` rows in Gregory.
- **Why deferred:** ops fix on Drake's side (reconfigure Fathom team-level notetaker behavior), not a code change. Will be addressed during the same Fathom team-settings sweep that locks down per-CSM recording behavior for the missed-call detection feature.
- **Revisit trigger:** Drake to handle as part of Batch A Fathom-side ops work alongside the missed/unrecorded call detection feature. Once team settings are clean, verify by checking for duplicate `external_id`-adjacent rows in `calls` over a recent window — if the pattern persists, the cause is something other than the leave-rejoin sequence and we'd need a Gregory-side dedupe.
- **Logged:** 2026-05-05.

---

## Batch B — Call review + health score activation

Activate the dormant Gregory brain pieces and tune the health score to be driven by real call data instead of placeholder neutrals.

### ~~Activate Gregory concerns generation~~ — RESOLVED 2026-05-07

Subsumed by the V2 AI call signal. `concerns.py` + the `GREGORY_CONCERNS_ENABLED` gate retired; concerns now flow directly from `agents/gregory/ai_call_signal.py` based on the LLM's read of call_review documents (richer input than the V1.1 raw-summaries approach). See `docs/agents/gregory.md` § "Brain V2".

### ~~Tune concerns generation to run on Fathom summaries~~ — OBSOLETE 2026-05-07

Concerns are now generated from `call_review` documents (which the call_reviewer agent produces from full transcripts via Sonnet, M6.x). The "transcript vs Fathom-summary" tuning question is moot — the AI call signal reads the higher-signal call_review distillation rather than either of the V1.1 candidate inputs.

### ~~Health score driven by call data~~ — RESOLVED 2026-05-07

Delivered. V2 rubric: `ai_call_signal` 0.50 + `call_cadence` 0.20 + `overdue_action_items` 0.10 + `latest_nps` 0.20. The AI signal is the dominant qualitative contributor; `open_action_items` retired (was double-counting with overdue + the AI signal's read of action items). Calibration followup logged in `docs/known-issues.md`.

### ~~Never-called-clients-land-green rubric fix~~ — RESOLVED 2026-05-07

Delivered by the V2 weight rebalance. Never-called clients now land at score=55 (yellow) under the new weights: `0.50×50 + 0.20×50 + 0.10×100 + 0.20×50 = 55`. The AI signal's 0.50 weight on a neutral-50 default structurally pulls no-data clients out of green. Pinned by `test_never_called_client_lands_yellow_not_green` in `tests/agents/gregory/test_scoring.py`.

### NPS score piping (V1.5)

- **What:** ingest the NPS score (0-10) alongside the segment classification. Path 1 receiver only handles segment; the score field on `nps_submissions` stays empty for clients who submit through Airtable (the manual NpsEntryForm in Section 2 is the only score-write path today). Score piping would extend the receiver's payload contract to include `score`, validate, write to `nps_submissions` via `insert_nps_submission` RPC alongside the `update_client_from_nps_segment` call.
- **Why deferred:** Path 1 segment-only is sufficient for the M5 V1-adoption phase. Score adds complexity (two writes per webhook, idempotency on duplicate score submissions, Airtable Score field shape questions) and Batch B's health-score work uses `nps_standing` (segment) for its current weighting, not raw score.
- **Revisit trigger:** Batch B rubric overhaul, OR a reporting need surfaces the gap (e.g. "show me clients whose NPS score dropped this month").
- **Logged:** 2026-05-03.

---

## Batch C — Action item HITL flow (Nabeel's "transcript vision", V2 flagship)

The flagship V2 feature. AI drafts action item messages from call transcripts, CSM reviews and edits in Gregory, CSM approves and the message lands in the client's Slack channel.

### AI drafts action item message for client from transcript

- **What:** background agent reads each new client call's transcript + summary, drafts an action-item-shaped message addressed to the client. Uses Claude with a prompt tuned for the agency's tone. Drafts land in a new `action_item_drafts` table tied to the call + the proposed recipient client.
- **Why deferred:** Batch C is V2 flagship work. Depends on the existing Fathom webhook + summary pipeline (already live) and Claude API integration (already live via `shared/claude_client.py`).
- **Revisit trigger:** Batch C kickoff after Batch A + B settle.
- **Logged:** 2026-05-05.

### CSM reviews + edits draft in Gregory

- **What:** dashboard surface (likely a new section on the Calls detail page or the client's Activity section) where CSMs see pending drafts, edit content inline, approve / reject. Mirrors the M5.6 pattern of inline-edit + history-row writes for an audit trail.
- **Why deferred:** depends on the AI drafter shipping first.
- **Revisit trigger:** Batch C, after the drafter pieces are live.
- **Logged:** 2026-05-05.

### CSM approves → Slack send to client channel

- **What:** approval triggers a `chat.postMessage` to the client's Slack channel (the same `slack_channel_id` Path 2 outbound roster uses). Posted from the @ella user token (M1.4) so the message renders without the APP tag, OR posted from a dedicated bot token if the action-item flow needs distinct attribution.
- **Why deferred:** depends on the drafter + reviewer surfaces shipping first.
- **Revisit trigger:** Batch C, after reviewer ships.
- **Logged:** 2026-05-05.

### Track assigned vs completed action items per client

- **What:** dashboard view of action item completion rate per client (assigned / completed / overdue). Builds on the existing `call_action_items` table. Surfaces in the Activity section as a small completion-rate badge or in a dedicated tab.
- **Why deferred:** value compounds once Batch C's AI-drafted action items are flowing — manual action items from the existing Fathom pipeline will provide a baseline but the picture sharpens with the new flow.
- **Revisit trigger:** after Batch C's CSM-approval flow has been live for ~2 weeks of real action items.
- **Logged:** 2026-05-05.

---

## Batch D — Classifier tuning (small backstop work)

**Address only any FP that survives the titling convention rollout.** CSM titling discipline (a separate ops effort) should suppress most of the classifier false-positives we've seen. If hiring-interview / spousal-rep / iMIP patterns keep recurring after CSMs are titling cleanly, fix the classifier. Otherwise leave.

The specific FP entries (hiring-interview, representative-of-existing-client, iMIP) live in `docs/known-issues.md` with reframe notes — they'll get pulled into Batch D work if the titling rollout doesn't suppress them.

---

## Batch E — Client business context vault

Build a per-client context vault: credentials, brand assets, hosting info, domain registrar, email setup. Eventually feeds a CSM-facing chatbot for quick lookups. Long-arc destination; pulls from Batch B (health score data) + Batch E (this) + Gregory brain.

### Login credentials surface

- **What:** encrypted-at-rest store for client credentials (CRM, hosting, GHL, etc.) accessible to CSMs through the dashboard. Likely a `client_credentials` table with encrypted columns, plus a Section in the client detail page that requires explicit click-to-reveal.
- **Why deferred:** Batch E scope. Depends on a security review (encryption key management, access logging, who can see what) before the schema lands.
- **Revisit trigger:** Batch E kickoff.
- **Logged:** 2026-05-05.

### Logos / brand assets storage

- **What:** per-client logo + brand asset uploads, surfaced on the client detail page. Likely a `client_assets` table referencing files in Supabase Storage.
- **Why deferred:** Batch E scope. Lower priority than credentials but trivially additive once credentials infrastructure is in place.
- **Revisit trigger:** Batch E kickoff.
- **Logged:** 2026-05-05.

### GHL snapshots

- **What:** periodic snapshots of each client's GoHighLevel state — pipelines, contacts, automations — captured into the dashboard so CSMs can see GHL adoption without leaving Gregory.
- **Why deferred:** Batch E scope. Depends on a GHL API integration (read-only).
- **Revisit trigger:** Batch E kickoff.
- **Logged:** 2026-05-05.

### Website URLs / hosting info

- **What:** each client's website URL, hosting provider, and access notes. Free-text per-field for V1; could promote to dedicated columns if usage demands.
- **Why deferred:** Batch E scope.
- **Revisit trigger:** Batch E kickoff.
- **Logged:** 2026-05-05.

### Domain registrar info

- **What:** which registrar holds each client's domain, login info (encrypted), expiration dates. Surfaces upcoming renewal windows.
- **Why deferred:** Batch E scope.
- **Revisit trigger:** Batch E kickoff.
- **Logged:** 2026-05-05.

### Email setup (forwarders, DNS)

- **What:** record of each client's email-forwarding configuration, DNS records (SPF, DKIM, DMARC), and provider login. Useful when a client reports email deliverability issues — CSM can diagnose without a separate spreadsheet hunt.
- **Why deferred:** Batch E scope.
- **Revisit trigger:** Batch E kickoff.
- **Logged:** 2026-05-05.

### CSM-facing chatbot for vault + history queries (long-arc)

- **What:** internal-only chatbot that queries Batch E (vault) + Gregory brain (health, concerns) + call history for CSMs. Use cases: "what's client X's hosting login?", "summarize Y's last three calls", "show me all clients churning this month + their primary blockers." Long-arc destination; pulls from B + E + brain.
- **Why deferred:** capstone of Batch E. Flagged but not specced — depends on B + E being substantially populated before the chatbot has anything meaningful to query.
- **Revisit trigger:** Batch E + B both have ~4 weeks of populated data.
- **Logged:** 2026-05-05.

---

## Newer ideas (post-redesign, Gregory side)

Three ideas Drake surfaced during the day-end-wrap conversation 2026-05-14. Each is a Gregory-side feature, not part of the existing Batch A-E themes. Land as their own specs when Drake's perceived priority pulls them forward (current ordering in `CLAUDE.md § Next Session Priorities` items 2-4, after Send-to-Slack production cutover).

### Gregory CSM utilization audit

- **What:** a routine that audits whether CSMs are actually using Gregory — logging into the dashboard, editing action items, marking journey stages, sending Slack messages from the Action items box, completing items via the checkbox flow. Surface for Nabeel/Drake to see which CSMs lean on Gregory vs. ignore it. Could be a dashboard view, a weekly Slack digest, or both. Format and scope deferred.
- **Why deferred:** post-2026-05-14 day-end-wrap idea. Needs a scoping conversation: which actions count as "using"? What's the comparison baseline (per-CSM, per-week, per-client load-adjusted)? Where does the audit live — a `/admin/utilization` page, a cron-scheduled Slack post, or both? Drake names the priority order before Builder drafts.
- **Revisit trigger:** when Drake decides CSM-by-CSM adoption visibility is the next thing he wants — either because a specific CSM is suspected of under-using Gregory, or because a leadership conversation surfaces the question.
- **Logged:** 2026-05-14.

### Teams page (calendar-based meeting tracker)

- **What:** a meeting-tracker view for CSMs backed by Google Calendar. V1 permission model: each CSM sees only their own meetings; Nabeel sees all team members'. Surfaces cadence (how often each CSM meets each client), late-flag candidates (clients with no recent meeting), and end-of-week aggregate views. Builds toward CSM cadence tracking + a late-flag workflow that bridges into the existing accountability surface.
- **Why deferred:** depends on Google Calendar API auth setup per CSM (each CSM authorizes Gregory to read their calendar). Permission scoping is the load-bearing architectural piece — who can see what across the team boundary needs explicit design before any code. Overlaps with the existing carried "Meeting tracking" priority (`CLAUDE.md § Next Session Priorities` item 6); the two may fuse into one spec when scoping happens.
- **Revisit trigger:** when Drake wants a dashboard-side view of CSM cadence rather than the current Slack-post-only surface (the daily 7am EST accountability cron + per-call CS Slack summary). Most likely pulled forward by a Nabeel ask for visibility into meeting frequency.
- **Logged:** 2026-05-14.

### Admin cost hub

- **What:** admin-only dashboard view showing costs across the tools Gregory + the agency use — Anthropic API spend (already trackable via `agent_runs.llm_cost_usd`), Supabase database + storage, Vercel hosting + cron + function invocations, Slack (if usage-billed in our tier), maybe OpenAI embeddings, Fathom subscription, ElevenLabs voice if applicable. Surface for Nabeel to spot cost-reduction opportunities. Likely starts with Anthropic + Supabase (both have queryable APIs + we already store per-run cost) and grows tool-by-tool as integration cost is justified.
- **Why deferred:** post-2026-05-14 day-end-wrap idea. Each external API integration has its own auth + rate-limit + data-shape work. Anthropic + Supabase are cheap firsts because we already have the data (Anthropic) or direct admin access (Supabase project settings). Vercel cost data lives in their billing dashboard — may or may not have an API. Scoping starts with "which providers are queryable" before the dashboard exists.
- **Revisit trigger:** when Nabeel asks for total monthly cost or when a specific bill spike prompts a "where is this coming from?" question that needs a real surface, not a one-off SQL query.
- **Logged:** 2026-05-14.

---

## Tooling / Infrastructure (Director's working layer)

Items here aren't Gregory features. They're improvements to the operational layer Director uses day-to-day. Distinct from the agency-product batches above.

### `scripts/apply_migration.py` — migration wrapper

- **What:** a thin Python wrapper Director can call to apply a single migration end-to-end. Reads `supabase/migrations/<NNNN>_<name>.sql`, applies via psycopg2 against the pooler URL (using `SUPABASE_DB_PASSWORD` from `.env.local`), inserts the matching row into `supabase_migrations.schema_migrations`, runs the dual-verify queries (schema reality + ledger registration), returns a structured result. Replaces the raw `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes` invocation Director uses today.
- **Why deferred:** the raw CLI invocation works correctly post-Phase-3 (2026-05-08) and the value of a wrapper is ergonomic, not bug-resilience. Building it before Director hits friction is premature. The hybrid gate model means Drake's SQL review stays upstream regardless — the wrapper doesn't change the gate, it just changes the apply-and-verify mechanism Director uses.
- **Revisit trigger:** Director feels friction in the CLI-direct path frequently enough to justify the wrapper's build cost. Concrete signals that would tip the balance: (a) the `--password $DB_PW` boilerplate gets re-typed enough to feel error-prone; (b) the dual-verify queries get re-written ad-hoc per migration in ways that miss what a templated wrapper would catch; (c) a CLI behavior change (auto-update, command-flag deprecation, output format shift) breaks the documented `apply_migrations.md` flow and the wrapper would have absorbed that drift.
- **What it would NOT change:** Drake's SQL review stays the upstream gate. The wrapper handles apply + verify (Director's operational layer per CLAUDE.md § Director / Builder System § Gate trajectory), not the SQL-review gate. Building the wrapper does not move migrations out of the (a) gate set.
- **Logged:** 2026-05-08 (Phase 3 fix session — wrapper deferred per Drake's "build only when friction surfaces" call).

### `gregory-ts-test-infra` — install vitest + RTL and backfill Part 1 primitive tests

- **What:** install `vitest` + `@testing-library/react` + `@testing-library/jest-dom` + `jsdom`, add a `vitest.config.ts`, wire a `test` script in `package.json`, and write unit tests for the six Gregory Redesign Part 1 primitives (`HeaderBand`, `EmptyStateAwareSection`, `DiagnosticsCollapse`, `InlineEditableField`, `InlineEditableActionItemRow`, `SentimentPill`). Test coverage matches the Part 1 spec's § D (render correctness, empty/stub/show modes, expand/collapse, optimistic-save + revert-on-failure, null-tier render-nothing).
- **Why deferred:** the Part 1 spec required tests but the repo has no TypeScript/React test infrastructure today — no jest/vitest, no `.test.tsx` files, no `test` script. Installing a test framework crosses the "never install a new major dependency without asking first" working norm and would expand the Part 1 spec past its foundation focus. Drake approved deferral 2026-05-12; Part 1 ships with visual-verification-only at the deploy preview.
- **Revisit trigger:** before the first Part 2 spec lands changes that consume the Part 1 primitives at runtime (`HeaderBand` migration on `/clients`, etc.) — having tests in place catches primitive regressions during the per-page migrations. Could also be triggered earlier if Drake wants test-driven development on the next primitive added in Part 2.
- **Logged:** 2026-05-12 (Gregory Redesign Part 1 ship — tests deferred per spec patch).
