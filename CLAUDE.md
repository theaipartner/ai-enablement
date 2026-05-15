# CLAUDE.md

Primary context for any Claude instance working on this repo. Read this fully before making changes.

## Project Purpose

Internal AI enablement system for a coaching/consulting agency. Replaces and augments human work across customer success, sales, and operations. The consumer business runs on this system first; later, the same system will be deployed to other agencies as a productized consulting offering.

**Active focus:** Director-tier surfaces + role-gated visibility are the post-Gregory-V2 shape. Permissions infrastructure, `/teams` Meeting Tracker (Google-Calendar-backed), `/tasks` Director task list, plus the May 18 title-convention forcing function all shipped 2026-05-15. The original batch-A-through-E V2 framing in `docs/future-ideas.md` is the queued backlog beneath this. See § Current Focus and § Next Session Priorities.

## Core Principles (Non-Negotiable)

These four principles protect the system from lock-in and rebuilds. Apply them to every decision.

1. **Our database is the source of truth.** Every piece of data we touch is mirrored into Supabase. External tools are secondary.
2. **Agents query our database, not external tools.** An agent never calls Fathom, Slack, or the CRM directly for data. Ingestion pipelines populate Supabase; agents read from Supabase.
3. **External tools are replaceable adapters.** Each integration lives in its own module. Swapping any one is a contained rewrite, not a system-wide migration.
4. **Interfaces are thin clients on a shared brain.** Agent logic lives in one place, exposed via API. Slack, future web portals, email — all just front doors. No business logic in interface code.

## Stack

| Layer | Tool | Notes |
|-------|------|-------|
| Database | Supabase (Postgres + pgvector) | Source of truth. All data mirrored here. |
| Backend / Agents | Python 3.11+ | Primary language. FastAPI for services. |
| Frontend | Next.js 14 + TypeScript | Gregory dashboard + approval UI. |
| Orchestration | n8n (self-hosted) + Make.com | Workflows, scheduling, HITL routing. Make.com handles Airtable ↔ Gregory automation; n8n holds the workflow library. |
| LLM | Anthropic Claude API | Sonnet as default, Opus for complex reasoning, Haiku for simple/cheap tasks. |
| Embeddings | OpenAI `text-embedding-3-small` | 1536 dims. Used by `shared/kb_query.py` and all ingestion that writes `document_chunks`. |
| Hosting | Vercel | Frontend + serverless Python functions. |
| Voice | ElevenLabs | Course audio, future voice agents. |
| Dev environment | WSL2 Ubuntu on Windows | All dev happens inside WSL. VS Code with Remote-WSL extension. |
| Secrets | Bitwarden master list + env vars | `.env.local` locally, Vercel env vars in production. See `.env.example` for the full inventory and `docs/state.md` for the live production set. Core keys (all environments): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`. Feature-specific: `ESCALATION_RECIPIENT_SLACK_USER_ID` (Ella head-CSM DM target), `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` + `NEXT_PUBLIC_APP_URL` (`/teams` Meeting Tracker Calendar API), `SLACK_DRY_RUN` (Preview-mode flag for Send-to-Slack on `/clients/[id]`), `ELLA_PASSIVE_MONITORING_ENABLED` (passive monitor kill switch). `SUPABASE_DB_PASSWORD` is also set in `.env.local` for ops scripts that connect directly via psycopg2 (migrations, seeds, diagnostics) — not required by webhooks or the agent runtime. |

## Working Norms

This section captures how Drake works with Director (chat-Claude on claude.ai) and Builder (the Claude Code session executing specs). The Director / Builder mechanics live in the next section; this one is about the human-collaboration shape.

### Drake / Director / Builder

Drake is the strategic and judgment layer — vision, product calls, architecture decisions. He doesn't write code, doesn't review every line. He's the human gate at agreed boundaries (see § Director / Builder System for the four gates).

Director is chat-Claude (this surface, claude.ai). Director ideates with Drake on what to do, decomposes into Builder tasks, writes specs to `docs/specs/<slug>.md` (via the GitHub MCP connector), reads Builder's reports out-of-loop after Drake points to them, and reports back to Drake. Director does NOT edit any other documentation directly — every CLAUDE.md / runbook / known-issues / future-ideas / ADR / schema-doc change rides in a spec that Builder executes (the spec body can be as small as "rewrite paragraph X in § Y to say Z"). Director does NOT commit or review Builder's code work — Builder pushes its own code and reports.

Builder is the Claude Code session that executes specs. Builder pulls latest from `origin/main` at session start (a SessionStart hook handles this), reads the spec it's pointed at, executes the work, runs tests, commits and pushes per the existing one-logical-change-per-commit rule, then writes a report to `docs/reports/<slug>.md` and pushes that as a final commit. Builder is not headless — Drake interacts with it directly during execution if needed for gate moments.

Drake's role at runtime is the four gates in § Director / Builder System § Drake's gates: irreversibles (incl. SQL-review for migrations), context-confusing decisions, post-deploy testing on real surfaces, credentials / env vars. Everything else is Director's call (for planning / spec / doc work) or Builder's call (for code execution).

**Design workflow for visual work.** When work is primarily visual (page redesigns, new UI surfaces, layout changes that need design judgment more than code execution), the workflow is three-stage: Drake and Director ideate the visual direction in chat, Director writes a Design-facing prompt that Drake hands to Claude Design (a separate claude.ai session with the GitHub MCP connector authorized for this repo), Design produces annotated single-file HTML mocks and commits them to the repo (recent precedent: repo root as `Gregory <Surface> Redesign.html`; future sessions confirm a path with Drake). Director then reads the mocks and writes a UI spec for Builder that references the mocks by path, the existing primitives at `components/gregory/*`, and the data fields available. Builder implements against the spec, visually verifies via Playwright on the deploy preview (see `docs/runbooks/design-handoff.md`), and reports. The split keeps each agent in its specialty: Design designs, Code codes, Director sequences. Used end-to-end on the Gregory Calls + Clients redesigns; default to this pattern for future visual work rather than trying to spec design from chat alone or trying to have Code generate design.

### Communication preferences

- **Direct feedback.** Flag bad moves. If Drake's about to make a wrong call, push back before agreeing. The working norm is "tell me what you actually think, not what I want to hear."
- **Use analogies for novel technical concepts.** Drake is not deeply technical.
- **Short messages during active work, longer framing at breakpoints.** Smoke test clicks don't need essays. Scoping a feature does.
- **Avoid forced-answer prompts (`ask_user_input_v0`-style tools) for clarifying questions.** Drake prefers questions laid out in response prose so he can read at his own pace and reply in his own words. Forced-answer tools feel constraining. Lay clarifying questions inline; let Drake answer however suits him.
- **Option A / B / C framing for tradeoff decisions.** Lay out realistic options, name tradeoffs honestly, give your lean and why, let Drake decide.
- **Capture decisions in writing as you make them.** Director writes a spec capturing the decision (`docs/specs/<slug>.md`) — typically the same spec whose body implements the decision, or a tiny dedicated spec when the decision is doc-only. Builder executes the spec, which is where the actual CLAUDE.md / runbook / known-issues edit happens. Decisions that ride along with active Builder work (and would land in the same spec anyway) can be held in chat memory short-term. Drake wants to be able to look back and see why calls were made — the spec + Builder commit pair is the durable record.
- **Strong leans → make the call.** If you have a strong lean and the consequence of being wrong is recoverable, make the call and note it for Drake to check. Hard stops are reserved for: irreversible actions, credential touches, deploys, migrations, anything where being wrong costs significant cleanup time, decisions with no good default. Don't pile on stops where there's no real boundary.
- **Time references mean workflow position, not calendar position.** When Drake says "EOD," "end of session," or "today," these refer to the *workflow phase* (the end of the current focused work session), not the literal calendar end of day. Director historically misread "EOD" as "before midnight tonight" and made urgency calls that didn't match Drake's intent. When in doubt about which sense applies, ask Drake to clarify rather than guess.

### Tools available to Director (chat surface)

Director runs on claude.ai with these tools available across sessions:

- **GitHub MCP connector.** The primary surface for both reading and writing. Read any file via `get_file_contents`. Write new spec files via `create_or_update_file` or `push_files` — a single step that commits + pushes to `origin/main` in one operation. Under the Director-writes-specs-only rule, the only write Director performs is creating new spec files at `docs/specs/<slug>.md`; all other doc changes ride in specs Builder executes. Director does NOT use GitHub MCP to commit code or Builder's reports — those are Builder's responsibility from the Code session.
- **Project knowledge search (secondary).** Indexed snapshot of the repo. Recency lags pushes by minutes-to-hours and the index can drift from disk. Use only for fuzzy semantic search across the codebase when you don't know the file path; prefer GitHub MCP for any specific file you can name. Ask Drake to confirm the index is fresh before treating it as ground truth for post-push state.
- **Web search / web fetch.** For external research (library docs, API references, current events).

A future Director session inherits these as defaults — no need for Drake to explain the tooling each new session.

### Spec-writing standards

Specs are how Director hands work to Builder. Builder reads the spec blind in a fresh Code session — there's no chat context to fall back on — so spec quality is load-bearing under the current topology. Every non-trivial spec includes:

- **Title + slug + status header.** First three lines: `# <Title>`, `**Slug:** <slug>`, `**Status:** in-flight | shipped | superseded`.
- **Context Builder needs.** What surface this lives in, what files it touches, what existing patterns to follow. Link to relevant runbooks, schema docs, agent specs.
- **Acclimatization checklist.** Explicit list of files Builder reads first with a "confirm in 4-5 bullets" requirement. Catches the case where Builder skims context.
- **What success looks like.** Concrete acceptance criteria — tests pass, endpoint returns 200, dashboard renders the new pill, etc. Not vibes.
- **Hard stops.** Irreversible / shared-state boundaries where Builder must stop and surface to Drake (gate (a) territory). Examples: before applying migrations (Drake reviews the SQL diff first), before modifying `vercel.json`, before deploying, at smoke-test gates that bill the subscription.
- **Hard-numerical thresholds.** When a meaningful failure mode is "we won't notice until it gets out of hand," include a concrete threshold (e.g., "if affected count exceeds N, stop and surface"). The M5.6 silent-toggle case is the working example: 17 clients exceeded the single-digit threshold, Builder stopped, surfaced (a)/(b)/(c)/(d), the (a)+(d) decision closed an audit-recovery gap that would otherwise have shipped silently.
- **"What could go wrong" framing.** Phrase as interrogative: "think this through yourself, what could go wrong." Forces Builder to surface risks the spec didn't anticipate.
- **Mandatory doc-update list.** Explicit list of which docs Builder updates at end of work. Don't say "if needed" — make the calls explicit. If a doc doesn't need updating, Builder says so explicitly in the report.
- **Senior-engineer level of context, not wish-granter level.** Bad: "Build the Slack bot." Good: "We're building Slack Bot V1 per `docs/agents/ella/ella.md`. Ingest from the `documents` and `slack_messages` tables via `shared/kb_query.py`. Follow the HITL pattern in `shared/hitl.py`. Start with the incoming Slack event handler. Update `docs/agents/ella/ella.md` as you go, add at least 10 golden examples to `evals/ella/`."

Director does NOT need to restate the report structure in the spec — Builder's CLAUDE.md-loaded behavior already specifies the six-section end-of-turn report (§ Director / Builder System § Builder behavior). Only mention it in the spec if the work needs an additional field beyond the standard six (rare).

### Operational patterns Director and Builder are strict about

- **Secrets handling.** Builder reads secrets directly from `.env.local` when the task requires it (auth headers, API calls during diagnostics). Never write secrets into committed code, logs, error output, or persistent files outside `.env.local`. Drake retains responsibility for reviewing how secrets are used in code paths + rotation if exposure is suspected.
- **Ephemeral secrets across stateless tool calls.** When Builder needs a secret to persist across stateless Bash tool calls, an ephemeral mode-600 `/tmp` file (shred-deleted post-use) is the preferred pattern over `argv` exposure. The "never write secrets to a file" rule is about persistent secret files in repos or home dirs, not ephemeral handoffs between tool calls.
- **Discovery before build** for any external integration — read docs, verify with one real authenticated call, inspect actual response shape against assumed adapter shape.
- **Read the actual schema before drafting schema changes.** Before proposing new tables, columns, or extensions, read the current state of the schema. Don't propose new tables without checking if they already exist. Don't draft migrations against a schema you remember vaguely. Applies to both Director (when writing specs) and Builder (when executing).
- **Default: ship highest-priority forward-motion work.** Non-blocking bugs get logged to `docs/known-issues.md`, deferred until they become a real blocker.
- **Migration verification requires DUAL verification, against cloud explicitly.** Schema reality (`pg_proc`, `information_schema`, or `to_regclass`) AND ledger registration (`supabase_migrations.schema_migrations`). Don't trust single-query verifications — they can pass against the wrong database. Builder runs both verifications post-apply; the discipline is permanent regardless of which apply path is canonical (CLI today, possibly a `scripts/apply_migration.py` wrapper later — see `docs/future-ideas.md`).
- **Autonomous default when Drake is AFK.** Diagnose + execute the likely fix path autonomously, hard-stop ONLY at human-required steps (smoke tests, irreversible deploys, decisions that need Drake's judgment). Lay out clear A/B/C options for any check-in moment so Drake can resolve via short replies on mobile. Before drafting an AFK spec, Director clarifies secret-handoff approach and proactivity level upfront (in chat prose, not via forced-answer tools).
- **Real-API smoke test before `--apply` on backfills.** Mocked unit tests pass while real-API integration breaks (TS-vs-Python SDK shape, schema column drift). Every backfill script gets a `--smoke` flag that exercises one record end-to-end against the real DB before bulk runs. Working example: `scripts/backfill_call_reviews.py --smoke`.
- **Deploys via git push are reliable post-2026-05-08 cache-contamination fix.** Builder's push to `main` fires Vercel's GitHub-integration auto-deploy, which now produces clean bundles. Drake watches deploy outcomes via the Vercel dashboard as the de-facto post-deploy verification — that role is gate (c) (post-deploy testing on real surfaces). **Recovery procedure if cache contamination ever recurs:** dashboard "Redeploy" with **Use existing Build Cache** unchecked. The no-cache build produces clean bundles and uploads a replacement cache; subsequent git-push deploys restore the now-clean cache and succeed. The 2026-05-08 occurrence was root-caused via Phase 3b discovery (build-log diff of commit d14770e's failed git-push vs successful no-cache redeploy); prevention landed in the same session (55 junk pkg dirs deleted, `data/` added to `.vercelignore`); validation deploy on the Phase 3b close commit confirmed clean. See `docs/known-issues.md` for the full diagnostic signature.

### The people

- **Drake** — solo developer, vision person, doesn't code.
- **Nabeel** — Drake's boss. Wanted more visibility into the work, so Drake records SOD + EOD Loom videos. Nabeel gave specific feedback on what makes a strong video: visual artifacts on screen, structured EOD reflecting on SOD first, specificity on bugs (which bugs, not "some bugs"). Don't suggest replacing Looms with written status — they're a deliberate visibility format choice.
- **Zain** — teammate, handles operational ops like creating service accounts. Delegating to him is part of how Drake moves fast — don't reflexively suggest Drake do operational work himself.
- **Aman** — newer to the team, doing sales. His prospect calls were going to drive a classifier-update task; deferred in favor of manual review via the Gregory Calls page (and Batch D classifier tuning if titling discipline doesn't suppress the FP patterns).

### What Drake wants that's hard to get from a manual

- **Honest pushback when he's about to make a bad call.** Past good catches: redirecting full-dashboard-scope-creep into a tighter ship-able scope; pushing back on wrapping a Python script in a Vercel function when a TypeScript port + Postgres function was cleaner.
- **Catch his drift.** Drake sometimes stops questioning Builder's output if it sounds confident. When Drake points Director at a Builder report, re-read it carefully and flag if you see something off Drake might miss.
- **Pre-flight checks on what's actually in the repo or cloud before drafting specs.** Don't draft a spec assuming a function signature; read the file via GitHub MCP. Don't draft a SQL migration spec against a column name you guessed at; check the schema.
- **Tooling research before drafting infra-touching specs.** Spend a few minutes verifying current package names, current API patterns, current CLI commands before drafting specs that touch new infrastructure. Use web search if needed.

### What Drake does NOT want

- **Cargo-cult spec boilerplate.** Skip lines that don't add value just because they were in a previous spec.
- **Reflexive agreement.** If Drake proposes something and Director has a real objection, raise it. The collaboration depends on that.
- **Over-formatting.** Headers and bullets when prose would do are noise. Match the formality of the conversation.
- **Suggesting Drake do operational work himself when Zain handles it.**
- **Suggesting written status reports as a replacement for Loom videos.**

### Session start

Director starts fresh per chat conversation. Loads CLAUDE.md and any recent specs/reports via GitHub MCP's `get_file_contents`. Project knowledge search is the fallback when Director doesn't have a specific file path.

Director's first move on a new conversation:

1. Read § Live System State for what's currently shipped.
2. Read § Next Session Priorities for where to start.
3. Read § Current Focus for what's in flight.
4. Wait for Drake to say what he wants to tackle, in chat or via the Telegram channel.

Builder starts fresh per Code session. The SessionStart hook pulls latest from `origin/main` before any spec read or code work. Within a session, if Director pushes a new spec mid-flight, Builder explicitly re-pulls before reading it (project knowledge / git fetch state isn't automatic mid-session).

If anything in CLAUDE.md seems wrong or out of date, Director writes a spec for the edit (typically tiny — body can be "rewrite paragraph X in § Y to say Z") and Builder executes. Director does not edit CLAUDE.md directly.

### Things Director can update without asking

- `docs/specs/<slug>.md` entries Director writes during chat work.

That's the entire list. Working-norms changes, known-issues entries, Live-System-State / Next-Session-Priorities / Current-Focus updates, runbook edits, ADRs — all route through specs Builder executes. If Director and Drake agree a CLAUDE.md edit needs to happen, Director writes a spec for that edit, even when the spec body is "rewrite paragraph X in § Y to say Z."

### Things Drake updates himself

- Loom videos (no AI substitutes).
- Conversations with Nabeel, Zain, Aman.

## Director / Builder System

The Director / Builder system is the runtime shape of how work gets done. Working norms (the human-collaboration shape) live in the previous section; this section is about the agent topology.

### Roles

- **Director** — chat-Claude on claude.ai. Plans with Drake, decomposes work, writes specs to `docs/specs/<slug>.md` (via GitHub MCP). Does not edit any other documentation directly — every CLAUDE.md / runbook / known-issues / future-ideas / ADR / schema-doc change rides in a spec Builder executes. Reads reports out-of-loop when Drake points to them, reports back. Does NOT commit or review Builder's code work.
- **Builder** — the Claude Code session that executes specs. Pulls from `origin/main` at session start, reads the spec, executes, runs tests, commits + pushes per the standard rules, writes a report to `docs/reports/<slug>.md`, pushes the report.
- **Drake** — the human gate at agreed boundaries (the four gates below). Reads reports after Builder pushes; doesn't gate the push itself.

### Spec and report convention

**Slug format.** kebab-case, descriptive, no dates, no number prefix. Match the existing `docs/specs/` precedent (e.g., `ella-v2-batch-1-cloud-slack-ingestion.md`).

**Paths.** Spec lives at `docs/specs/<slug>.md`. Report lives at `docs/reports/<slug>.md`. One spec → one report, same slug, paired. Report overwrites on iteration rather than stacking — iteration history lives in git.

**Multi-pass execution.** If a spec genuinely needs multiple distinct execution passes (e.g., the spec is large and Builder did it in two sessions), reports get a `-pt1` / `-pt2` suffix: `docs/reports/<slug>-pt1.md`. Default is the unsuffixed single file.

**Spec front-matter (first three lines):**

```
# <Title>
**Slug:** <slug>
**Status:** in-flight | shipped | superseded
```

**Report front-matter:**

```
# Report: <Title>
**Slug:** <slug>
**Spec:** docs/specs/<slug>.md
```

**Cleanup cadence.** When work ships, Builder flips the spec's `Status:` from `in-flight` to `shipped` as part of the same commit that lands the report (under the Director-writes-specs-only rule, Director no longer edits the spec post-ship — the flip is mechanically part of Builder's wrap-up). Both spec and report files stay in place during the working day. Drake batches the deletion of all `shipped` spec/report pairs at end of day in a single doc-hygiene commit. Rationale: keeping shipped pairs around mid-day makes it easier to refer back to recent work without git-spelunking; EOD batching keeps the long-term repo clean. Neither Director nor Builder deletes a spec or report without an explicit "delete now" or "EOD cleanup" cue from Drake — silent deletion is a hard rule against. The durable record lives in CLAUDE.md § Live System State + git history once the EOD cleanup lands.

`docs/reports/` has a `.gitkeep` so the folder exists even when empty post-cleanup.

`/run` is the conventional trigger from a Code session — typing `/run` finds the single in-flight spec under `docs/specs/` without a matching report and executes it per § Builder behavior. See `.claude/commands/run.md` for the command's logic; if zero or multiple specs match, `/run` reports and stops rather than guessing.

### Builder behavior

Execute, don't ideate. Builder is reading a spec written by Director — clarifying questions go back to Drake in chat, not back to a headless Director. Test what you build when feasible (run the code, hit the endpoint, verify the result).

**Commit and push.** Builder commits per the one-logical-change-per-commit rule (§ Commits) and pushes to `origin/main`. No "stop at ready to push" — the topology change moved Director out of the diff-review loop, so Builder owns push directly. Drake's gates still apply (don't commit with failing tests, never commit secrets, hard stops at irreversible boundaries from the spec) — the loosening is specifically on Director's diff-review step, not on Drake's gates or on Builder's own commit hygiene.

**End-of-turn report.** After committing the code work, Builder writes a report to `docs/reports/<slug>.md` and commits + pushes that as a final commit (`docs: add report for <slug>` or similar). Structure the report with these six sections (use them even when a section is empty; an explicit "none" is information):

1. **Files touched.** Group by operation (created / modified / deleted). Repo-relative paths. One line per file with a one-clause description of what changed in it ("added handler for foo", "flipped pronoun on three lines", "pure rename"). Drake uses this list to know where to spot-check if anything else feels off.
2. **What I did, in plain English.** High-level summary at the "added X functionality to Y, refactored Z to use the shared helper" level. Not file contents, not diff hunks. The "why" behind the touched-files list. 3-7 sentences typically.
3. **Verification.** What ran (tests by name or pattern, smoke scripts by what they exercised, manual checks like "curl'd the endpoint and got 200"), what passed, what failed. If a test is implied by the work but wasn't run, say so explicitly with a reason ("didn't run the full pytest suite because the change was docs-only"). If testing was constrained in a way that doesn't fully cover the change, flag the gap.
4. **Surprises and judgment calls.** Anything the spec didn't anticipate. Decisions made that Director might have specced differently — name them, even when confident in the call. Risks noticed but not fixed. Errors worked around. Drake uses this to decide whether to investigate.
5. **Out of scope / deferred.** What was explicitly NOT done that the spec could be read as covering. What would come next if continuing. Anything noticed that should become a `docs/known-issues.md` or `docs/future-ideas.md` entry. An explicit "none" is fine if the spec was tight and execution was clean.
6. **Side effects.** Real-world actions taken during this run that aren't captured in the committed diff — Slack posts, emails, shared DB writes (beyond cleanup), external API calls, file creations outside the repo. Inventory explicitly even if "none" — that's information too. Working examples to surface: pytest runs that hit production Slack channels, smoke scripts that posted real messages to live surfaces, DB rows seeded that weren't deleted in cleanup, webhook fires that produced audit-ledger rows in shared tables. Surface these even when the spec didn't ask, because Drake cannot tell from the diff alone what hit a shared system.

**Partial reports on hard stop.** When Builder hits a hard stop mid-spec (any of the spec's enumerated hard stops, or genuine context-uncertainty per gate (b), or an unrecoverable test/migration/build failure) — write the report at the same path (`docs/reports/<slug>.md`) and push it before stopping. **Don't drop the report just because the work isn't complete.** The partial report is the handoff artifact: Drake brings it to Director (chat) and Director uses it to decide what to do next without forcing Drake to triage Builder's blocker alone. Structurally:

- **Title becomes:** `# Report (PARTIAL): <Title>` so the file is obviously unfinished at a glance.
- **Add a status line under the front-matter:** `**Status:** halted — <one-line reason>`.
- **The six sections all still appear** (none-on-section-N is information). What changes is that "what I did" describes the portion completed, "Verification" describes what was verified for that portion, "Surprises" is where the blocker lives — quote the actual error / failed query / suspicious output so Director can evaluate it independently, name what you tried, name what you concluded the hard stop required Drake's call on. "Out of scope / deferred" carries the un-attempted remainder of the spec. "Side effects" matters more, not less — partial work often leaves shared-system state (half-applied migrations, posted Slack messages, written-but-uncommitted DB rows) that Drake or Director need to see explicitly.
- **Add a seventh section: "What's needed to unblock"** — Builder's read of what decision or action would clear the block. Frame as options when there's a real choice (A / B / C with tradeoffs); state the single path when there isn't. This is what Director will scope from when Drake hands the partial back.

When the spec is later resumed (same session or next), Builder reads the existing partial report at the canonical path, executes the remaining work, and overwrites with a complete report — the title loses the `(PARTIAL)` prefix, the status line goes away or flips to a completion note, "What's needed to unblock" gets removed. Iteration history lives in git; the final committed file is clean.

If something in the work was unusually expensive (e.g., "the test suite re-run ate ~half the runtime"), call it out in the relevant section above.

### Director behavior

Plan with Drake. Decompose the work into discrete Builder tasks. For non-trivial work, write a spec to `docs/specs/<slug>.md` (via GitHub MCP) and tell Drake the spec is ready. Drake hands the spec to Builder when ready to execute. Director does not edit any other documentation directly — every CLAUDE.md / runbook / known-issues / future-ideas / ADR / schema-doc change rides in a spec that Builder executes, even when that spec is tiny.

Director does NOT review Builder's code work pre-push. The topology has Builder pushing on its own, and Director can't see new pushes automatically — Drake reads the report after Builder lands the work, and points Director at it if there's something to discuss. When Drake points at a report, read it critically — verify what Builder claims it did against the diff if Drake wants a second opinion, flag anything off. The review is real, just out-of-loop.

**The push-without-review tradeoff.** The old topology had Director gate-keeping push by reviewing the diff. The new topology removes that gate because Director (chat) can't see new commits without Drake telling it to look. The remaining quality gates are: the spec itself (Director's upstream design check), Drake's four gates, Builder's own commit hygiene (no failing tests, no secrets, one logical change per commit), and Drake's out-of-loop report read. Spec quality becomes load-bearing — a sloppy spec executed blind by Builder and pushed without review can land bad code in `main`. Tighten specs accordingly.

**Director's own commits.** Director writes specs and only specs. New specs are committed + pushed via GitHub MCP's `push_files` / `create_or_update_file` in a single step. Director does NOT commit or push any other documentation; every non-spec doc change rides in a spec Builder executes. Director does NOT use GitHub MCP to commit code or Builder's reports.

**Why specs-only — the MCP-edit constraint.** The GitHub MCP connector Director uses for writes (`create_or_update_file`, `push_files`) only supports full-file overwrites — there's no patch / diff capability. Editing a standing doc means rewriting the whole file from chat memory, which is slow (a 500-line CLAUDE.md takes a full response turn to regenerate cleanly) and error-prone (any unrelated paragraph the Director didn't intend to change can drift in the rewrite). New files (specs at `docs/specs/<slug>.md`) are cheap to write because there's nothing to preserve. Standing-doc edits are expensive and risky. That's why the rule is "Director writes new specs, every other doc change rides in a spec Builder executes" — Builder has `str_replace` and can edit precisely. The rule is mechanical, not stylistic; don't drift back to direct edits when the spec-cost feels heavy.

**Bundling escape valve.** If a task feels too small to justify spinning up a fresh Builder session, bundle it with other related or sequential tasks into a single spec. Caveats:

- *Independence rule* — only bundle related or sequential tasks. Bundling unrelated independent concerns muddles the diff, complicates review, and can leak cross-task design reasoning (Builder treats task A's fix as relevant to task B's design when it isn't).
- *Soft cap of ~3-4 tasks per bundle* — past that, the spec becomes unwieldy and the report hard to follow.
- *Spec rule still applies per task* — bundling doesn't let you skip a spec for any task that warrants one. Each non-trivial task gets its own brief in the spec; the spec becomes "implement task A per § A, then task B per § B (small enough to inline)."
- *Commit-splitting at execution time* — per the "one logical change per commit" convention (§ Commits), Builder splits the bundled work into multiple commits. Bundling for spec efficiency doesn't override commit hygiene.

### Drake's gates

Builder operates autonomously between four narrow gates. Drake handles:

- **(a) Irreversible actions.** Production deploys, anything destroying data, and the SQL review for cloud migrations (the apply + verify steps belong to Builder — see § Gate trajectory below).
- **(b) Genuinely context-confusing decisions.** When Builder truly cannot determine the right outcome AND the call needs Drake's specific lived context (team dynamics, customer relationships, business strategy, scope/architectural choices with long-term implications). The bar is "Drake's judgment is the load-bearing input," not "I'm slightly uncertain."
- **(c) Post-deploy testing on real surfaces.** Slack delivery, Fathom webhook ingest, dashboard render — anything that requires eyeballing the live system.
- **(d) Credentials and env vars.** Vercel env var changes, secret rotation, Bitwarden touches.

Everything else is Builder's call — including push (push is reversible via `git revert` / Vercel rollback, so it stays out of the gate set).

**Things Builder should NOT stop for** (explicit non-examples to prevent gate creep):

- *Routine commits and pushes.* Push is reversible. Just commit and push, then write the report. Don't ask "should I push now?"
- *Bundling small tasks within a spec.* If the spec includes multiple related/sequential tasks, just execute them in sequence. Don't ask permission to proceed to the next.
- *Choosing among options when one has a clear lean.* If Builder has a strong lean and consequences are recoverable (commit can be reverted, deploy can be rolled back, doc edit can be re-edited), make the call and note it in the Surprises section of the report.
- *Following up on a directive Drake just gave.* If Drake said "execute this spec and the next one," do all of it; don't ask to confirm before each step.

Gates exist for moments where Drake's specific judgment is genuinely load-bearing OR an action is irreversible. Gates do NOT exist as a politeness check before routine actions. When in doubt: if the worst case is "Drake reads the report and says 'undo X'," it wasn't a gate moment — just do the thing and report.

### Gate trajectory — what's temporary vs permanent

Today's gate set is its near-final shape. The two infrastructure pain points that previously forced human handling (Supabase CLI routing bug, Vercel build-cache contamination) are both resolved post-Phase-3/3b. The credentials gate stays as a Drake-by-preference choice, revisitable. Everything else is either permanent by design or already in Builder's lane.

**No temporary infrastructure-blocked gates today.** Migrations operational layer (apply + dual-verify) moved to Builder post-Phase-3 (2026-05-08); Deploys retired entirely as a gate post-Phase-3b (validated 2026-05-08) — git-push being Builder-driven implies deploys are too, by side effect via the GitHub integration's auto-deploy trigger. See § Operational patterns above and `docs/known-issues.md` for recovery procedures if either issue recurs.

**Drake-gated by current preference (revisitable):**

- **(d) Credentials and env vars.** Drake handles these for now; not infrastructure-blocked. Drake is open to revisiting later as the system proves itself, but no concrete trigger is set today. A future Director / Builder should not assume this gate dissolves on any specific schedule — it dissolves when Drake explicitly says so.

**Permanent by design (will not narrow regardless of infrastructure improvements):**

- **Destroying-data subset of (a).** Data loss is irreversible at the operational level; a human gate stays forever.
- **Migrations — SQL-review portion of (a).** Drake reviews the SQL diff before apply; that judgment gate is permanent. The operational layer (apply + dual-verify) sits with Builder — via `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes` today, possibly via `scripts/apply_migration.py` later (see `docs/future-ideas.md`). Was Drake-gated end-to-end during the CLI-broken era (2026-04-28 to 2026-05-08) when migrations went through Studio + manual ledger; Phase 3 discovery (2026-05-08) moved apply + verify to Builder once the CLI was confirmed correct. The operational mechanism may shift further; the SQL-review gate stays. See `docs/runbooks/apply_migrations.md` § Gate model for operational details.
- **(b) Result-uncertainty.** Builder should always surface uncertain decisions to Drake. Confidence calibration is the human's job; Builder's job is to recognize when it's outside its envelope.
- **(c) Post-deploy testing on real surfaces.** Eyeballing live Slack / Fathom / dashboard behavior is a human-judgment task no agent should claim done. With deploys retired as a gate (Builder triggers via push), Drake's role on deploys reduces to this (c) post-deploy verification — which stays permanent regardless.

The pattern: gates (b), (c), the data-loss subset of (a), and the SQL-review portion of migrations stay forever. The credentials gate (d) narrows when Drake explicitly relaxes it.

## Language Policy

- **Python first** for agents, ingestion pipelines, evals, scripts, data work
- **TypeScript** for Next.js frontend and browser code
- **Other languages only when no reasonable Python or TS option exists.** Ask before introducing a new language.

## Folder Structure

```
ai-enablement/
├── CLAUDE.md                   # This file
├── README.md                   # Human-facing project overview
├── .env.example                # Template for required env vars
├── .gitignore
├── pyproject.toml              # Python project config
├── docs/
│   ├── architecture.md         # System overview, data flow, component map
│   ├── collaboration.md        # How Drake and Zain divide work
│   ├── future-ideas.md         # Gregory V2 batches A–E (active focus)
│   ├── known-issues.md         # Real bugs / ops reminders
│   ├── specs/                  # Director-written specs Builder executes
│   ├── reports/                # Builder-written reports after execution
│   ├── schema/                 # One markdown file per database table
│   ├── agents/
│   │   ├── gregory.md          # Gregory full spec + build log (active)
│   │   └── ella/               # Ella docs (sidelined; resumes post Gregory V2)
│   │       ├── ella.md         # Ella full spec
│   │       ├── ella-v1-scope.md # Team-facing V1 scope summary
│   │       ├── future-ideas.md # Ella deferred work
│   │       └── followups.md    # Ella known bugs / ops gaps
│   ├── decisions/              # Architecture Decision Records (ADRs)
│   └── runbooks/               # How to do recurring tasks
├── supabase/
│   ├── migrations/             # Numbered SQL migration files
│   └── seed/                   # Seed data for local testing
├── ingestion/                  # Data ingestion pipelines
│   ├── fathom/                 # Call transcripts — backlog `.txt` path + realtime webhook
│   ├── slack/                  # Channel history backfill (REST only; Events API deferred to Ella V2)
│   ├── content/                # Filesystem-sourced HTML lessons (Drive API deferred to Ella V2)
│   └── crm/                    # (planned)
├── api/                        # Vercel Python serverless functions (10 deployed — see state.md § Vercel deployment for the inventory)
├── app/                        # Next.js 14 dashboard routes (Gregory)
├── components/                 # Dashboard UI — top-nav, ui/* primitives, client-detail/*
├── lib/                        # Dashboard utilities — db/, supabase/, etc.
├── agents/                     # Agent implementations
│   ├── ella/                   # Slack Bot V1 (sidelined)
│   ├── gregory/                # Brain V1.1 — signal computations, scoring rubric, concerns gen
│   └── csm_copilot/            # (planned — Batch C territory)
├── orchestration/              # n8n workflow exports (JSON)
├── shared/                     # Shared Python utilities (claude_client, kb_query, hitl, logging, db, ingestion validators)
├── evals/                      # Golden datasets + eval runner (empty for now)
├── scripts/                    # Active tooling — seeds, harnesses, admin tasks, one-shots
└── tests/                      # pytest suite — see § Live System State for count
```

## Conventions

### Code

- **Python:** PEP 8. Type hints everywhere. Format with `black`, lint with `ruff`.
- **TypeScript:** Strict mode on. Format with Prettier, lint with ESLint.
- **No one-letter variables** except tight loops (`i`, `j`).
- **Functions do one thing.** Split if exceeding ~50 lines.
- **Pure functions where possible.** Side effects (DB writes, API calls) isolated in thin layers.

### Naming

- Python files/modules: `snake_case.py`
- Python classes: `PascalCase`
- Python functions/variables: `snake_case`
- TypeScript files: `kebab-case.ts` or `PascalCase.tsx` for components
- Database tables: `snake_case`, plural (`clients`, `calls`, `messages`)
- Database columns: `snake_case`
- Environment variables: `SCREAMING_SNAKE_CASE`

### Documentation (Non-Negotiable)

Every substantive change updates documentation in the same commit.

- **New database table** → new file in `docs/schema/` with: purpose, columns, relationships, what populates it, what reads from it, example queries
- **New agent** → new file/folder under `docs/agents/` with: purpose, inputs, outputs, data dependencies, escalation rules, eval criteria
- **New ingestion pipeline** → runbook in `docs/runbooks/` covering: what it does, schedule, failure modes, debugging
- **Significant architectural decision** → new ADR in `docs/decisions/` using the standard template

Documentation is not optional and not written "later." It ships alongside the code.

### Commits

- Commit frequently — every meaningful unit of work, even if imperfect
- **One logical change per commit.** If you find yourself typing " and " or " also " in a commit message, split it.
- Commit messages: short, declarative, present tense (imperative mood)
- **Never commit with failing tests.** Run `pytest tests/` first.
- Never commit secrets. Run `git diff` before every commit to scan for keys.

**Commit policy.** Builder commits at the end of each meaningful unit of work (a feature complete, a migration applied, a file fully refactored) with a clear message following the convention. Don't commit half-finished work. Don't commit if tests/validation fail. Director writes specs only; every non-spec doc change (CLAUDE.md, runbooks, known-issues, future-ideas, ADRs, schema docs) is Builder's, bundled into whatever spec produces the underlying work.

**Push policy.** Push at end of logical task, not per commit. Multiple commits can land in one push; single-push-per-task is the rule (the 2026-05-11 EOD doc-hygiene cascade exposed how 16 cascading pushes were noisier than the underlying work warranted). Builder pushes its own code commits and report commits. Director does not gate push — push is reversible (`git revert`, Vercel rollback) and stays out of the gate set. Drake's push-related role is post-deploy verification on real surfaces (gate (c)), not pre-push review.

### Client Identity Resolution (alternate emails / alternate names)

The Fathom classifier resolves call participants to `clients` rows by email first, then by display name. Both lookups consult `clients.metadata` jsonb arrays:

- `metadata.alternate_emails` — emails the client has used historically.
- `metadata.alternate_names` — display names the client has used historically.

Both arrays are consulted case-insensitively, whitespace-stripped. When you merge an auto-created duplicate client row into a canonical row, the auto row's email and full_name must be written into these arrays on the real row so future ingestion resolves cleanly without re-creating the duplicate. The canonical merge surface is the Gregory dashboard's "Merge into…" flow on the Clients detail page (migration `0015_merge_clients_function.sql` handles the alternates sync atomically as part of the merge). Any new ingestion path that resolves humans-to-clients should consult these fields before creating a new row.

### Error Handling

- External API calls always wrapped with retry + timeout + structured logging
- Database writes transactional when multiple tables are affected
- Agent failures escalate to HITL rather than silently failing
- Never swallow exceptions without logging them

## Critical Rules

### Never Do

- **Never commit `.env`, `.env.local`, or any file with credentials.**
- **Never install a new major dependency without asking first.**
- **Never write code without updating the corresponding documentation.** Code and docs ship together.
- **Never couple agent logic to a specific external tool.** Agents query the KB. If you find yourself writing `fathom_client.get_call(...)` inside an agent, stop — move the fetch into the ingestion layer, persist to Supabase, then query from the agent.
- **Never bypass the HITL pattern.** If an agent is uncertain, escalate. Do not guess confidently.
- **Never use `print()` for anything that should persist.** Use structured logging via `shared/logging.py`.
- **Never write to `documents` or `document_chunks` without running through the validator.** `shared.ingestion.validate.validate_document_metadata()` / `validate_chunk_metadata()` enforces the contract every chunk in the KB depends on.

### Always Do

- **Always ingest data through the ingestion layer, not from agents.**
- **Always run the metadata validator before inserting into `documents` / `document_chunks`.**
- **Always write an eval before considering an agent "done."** Target: minimum 20 golden examples per agent, 90% pass rate to ship.
- **Always ask before introducing new external services, libraries, or languages.**
- **Always read the relevant `docs/` files before editing a component.**

## Gregory (active focus)

Gregory is the CSM-facing agent: a Next.js dashboard backed by a deterministic brain (signals + scoring rubric + gated Claude-driven concerns) and three Airtable integration paths. Active development focus. **Full surface area — dashboard routes, database / RPC patterns, ingestion paths, CS visibility surfaces, Make.com / Airtable paths, hosting, build log — lives in `docs/agents/gregory.md`.** Read on demand when a spec touches Gregory.

## Live System State

Moved to `docs/state.md` as of 2026-05-11. Read on demand when a spec or task references recent shipped subsystems (migration counts, hosting / env-var snapshot, batch-by-batch shipped detail, test suite counts). Not auto-loaded — kept out of CLAUDE.md to stay lean per session. The spec that ships a batch updates `docs/state.md` in the same Builder commit-sequence.

## Current Focus

**Gregory V1 — closed 2026-05-15.** The Director-tier surfaces (permissions infrastructure with `team_members.access_tier`, `/teams` Meeting Tracker, the May 18 title-convention forcing function, the `/tasks` Director page) shipped 2026-05-14 + the morning of 2026-05-15. The admin-tier cost hub at `/cost-hub` shipped 2026-05-15 evening and closed out Gregory V1 — Nabeel's cost-visibility ask is met: five Anthropic LLM-spend buckets, editable monthly subscriptions + one-off extras with `effective_from` month-attribution, a 12-month history view.

Operational refinements landed in parallel that evening: Ella's passive-monitor escalation thresholds were lowered so softer signals (uncertainty / confusion / clarification-seeking) surface through Gate 4; the Trustpilot cascade gained a first-month carve-out; the `call_reviewer` prompt went to v2 with `questions_asked` extraction feeding a weekly Friday Slack DM to Scott (the FAQ digest). Title convention v2 (`[Client Name] - Coaching/Sales Call with {Scott|Lou|Nico}`) extends the May 18 forcing function with name-prefix-as-primary client resolution. Timezone handling was codified as ADR 0003 (store-UTC, render-ET, EST calendar periods, UTC crons with a doc-mapped EST equivalent) after a cost-hub-vs-`/ella/runs` discrepancy was diagnosed and aligned via a shared `lib/time/est-periods.ts`.

The 39 migrations + 11 Python serverless functions + 6-tab TopNav (Clients / Calls / Teams / Ella / Cost Hub / Tasks) describe the post-state. Full per-spec detail in `docs/state.md`. ADRs: 0001 foundational stack, 0002 title-convention enforcement (+ v2 revision), 0003 timezone conventions.

**Next major arc: Gregory V2 — sales-side.** Specifics TBD; the scoping conversation happens in a future session. See § Next Session Priorities.

## Next Session Priorities

**Read this section first** when starting a new session — it's the single source of truth for where to start.

1. **Gregory V2 — sales-side.** The next major arc. Gregory V1 served CSM operations; V2 turns attention to the sales team. Scope and shape are open — needs a scoping conversation with Drake + Nabeel before any spec is drafted. Backlog items previously on this pointer (Ella V2 Batch 2.1 retrieval scope, NPS V1.5 piping, Client Business Context Vault, etc.) are shelved in `docs/future-ideas.md` so this stays a tight pointer to the live arc.

**Watch posture (no spec yet — EOD-eyeball, not forward work):**

- **Ella weekly cost trend.** Per Nabeel's "90% of messages through Ella" goal, cost-per-message matters at scale. Run rate today is ~$1.25/month — premature to optimize. Check the `/cost-hub` Ella buckets weekly; if the month-total trends toward a sustained $200+/month, spec optimization (model routing, prompt caching, output-token caps).
- **FAQ digest first real fire** — Friday May 22, 15:00 EDT. Pending Drake gate (d): set `FAQ_DIGEST_CC_SLACK_USER_ID=U0AMC23G1SM` in Vercel + manual curl to test, then confirm Scott receives the DM.
- **Post-2026-05-18 title-convention adoption.** Zain's booking-link rollout. Audit SQL in `docs/runbooks/call_title_convention.md`; Drake runs it Monday afternoon / Wednesday / Thursday next week to catch stragglers (both v1 and v2 patterns are valid).

## Ella (active focus)

Ella V2 is the active multi-batch focus alongside Gregory. **Full surface area — behavior spec, retrieval strategy, batch-by-batch state, build log — lives in `docs/agents/ella/ella.md`.** Read on demand when a spec touches Ella. Per-batch shipped detail also in `docs/state.md`.

## Other agents / future

- **CSM Co-Pilot V1** — Batch C territory. Lives at `agents/csm_copilot/` (placeholder). The action-item HITL flow + transcript-driven CSM-facing reasoning is its surface area.
- **Internal "Scout" assistant** — second agent on the shared Ella layer with team-wide retrieval scope. Sidelined; revisit-context in `docs/agents/ella/future-ideas.md`.

## Update Policy for This File

CLAUDE.md auto-loads into every Claude Code / Director session, so it stays lean. Kind B (state snapshots, shipped-batch detail) lives in `docs/state.md`; agent-specific surface area lives in `docs/agents/<agent>.md`. Both are read-on-demand, not auto-loaded.

Update CLAUDE.md (the always-loaded surface) only when:
- A core principle is clarified or extended
- A stack choice changes
- A new major convention is adopted
- § Current Focus or § Next Session Priorities shifts (these are the only state-y sections that stay in CLAUDE.md, because every session needs the "what's in flight" pointer)

Update `docs/state.md` whenever a batch ships — in the same Builder commit-sequence as the code. Update `docs/agents/<agent>.md` whenever the agent's surface area changes (behavior, retrieval, schema dependencies, build phases).

Treat all three files as living documentation. A stale CLAUDE.md is worse than no CLAUDE.md; the same is true of stale `state.md` and stale agent docs.
