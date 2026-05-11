# CLAUDE.md

Primary context for any Claude instance working on this repo. Read this fully before making changes.

## Project Purpose

Internal AI enablement system for a coaching/consulting agency. Replaces and augments human work across customer success, sales, and operations. The consumer business runs on this system first; later, the same system will be deployed to other agencies as a productized consulting offering.

**Active focus:** Gregory V2, organized into batches A–E (`docs/future-ideas.md`). Batch A — CSM accountability visibility — is the in-flight priority. See § Current Focus and § Next Session Priorities.

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
| Secrets | Bitwarden master list + env vars | `.env.local` locally, Vercel env vars in production. See `.env.example` — required keys today: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`. `SUPABASE_DB_PASSWORD` is also set in `.env.local` for ops scripts that connect directly via psycopg2 (migrations, seeds, diagnostics) — not required by webhooks or the agent runtime. |

## Working Norms

This section captures how Drake works with Director (chat-Claude on claude.ai) and Builder (the Claude Code session executing specs). The Director / Builder mechanics live in the next section; this one is about the human-collaboration shape.

### Drake / Director / Builder

Drake is the strategic and judgment layer — vision, product calls, architecture decisions. He doesn't write code, doesn't review every line. He's the human gate at agreed boundaries (see § Director / Builder System for the four gates).

Director is chat-Claude (this surface, claude.ai). Director ideates with Drake on what to do, decomposes into Builder tasks, writes specs to `docs/specs/<slug>.md` for non-trivial work, commits those specs and any CLAUDE.md / docs / runbook updates to GitHub via the GitHub MCP connector, reads Builder's reports out-of-loop after Drake points to them, and reports back to Drake. Director does NOT commit or review Builder's code work — Builder pushes its own code and reports.

Builder is the Claude Code session that executes specs. Builder pulls latest from `origin/main` at session start (a SessionStart hook handles this), reads the spec it's pointed at, executes the work, runs tests, commits and pushes per the existing one-logical-change-per-commit rule, then writes a report to `docs/reports/<slug>.md` and pushes that as a final commit. Builder is not headless — Drake interacts with it directly during execution if needed for gate moments.

Drake's role at runtime is the four gates in § Director / Builder System § Drake's gates: irreversibles (incl. SQL-review for migrations), context-confusing decisions, post-deploy testing on real surfaces, credentials / env vars. Everything else is Director's call (for planning / spec / doc work) or Builder's call (for code execution).

### Communication preferences

- **Direct feedback.** Flag bad moves. If Drake's about to make a wrong call, push back before agreeing. The working norm is "tell me what you actually think, not what I want to hear."
- **Use analogies for novel technical concepts.** Drake is not deeply technical.
- **Short messages during active work, longer framing at breakpoints.** Smoke test clicks don't need essays. Scoping a feature does.
- **Avoid forced-answer prompts (`ask_user_input_v0`-style tools) for clarifying questions.** Drake prefers questions laid out in response prose so he can read at his own pace and reply in his own words. Forced-answer tools feel constraining. Lay clarifying questions inline; let Drake answer however suits him.
- **Option A / B / C framing for tradeoff decisions.** Lay out realistic options, name tradeoffs honestly, give your lean and why, let Drake decide.
- **Capture decisions in writing as you make them.** CLAUDE.md / spec / runbook updates land in the same chat turn as the decision, committed via GitHub MCP. Drake wants to be able to look back and see why calls were made.
- **Strong leans → make the call.** If you have a strong lean and the consequence of being wrong is recoverable, make the call and note it for Drake to check. Hard stops are reserved for: irreversible actions, credential touches, deploys, migrations, anything where being wrong costs significant cleanup time, decisions with no good default. Don't pile on stops where there's no real boundary.
- **Time references mean workflow position, not calendar position.** When Drake says "EOD," "end of session," or "today," these refer to the *workflow phase* (the end of the current focused work session), not the literal calendar end of day. Director historically misread "EOD" as "before midnight tonight" and made urgency calls that didn't match Drake's intent. When in doubt about which sense applies, ask Drake to clarify rather than guess.

### Tools available to Director (chat surface)

Director runs on claude.ai with these tools available across sessions:

- **GitHub MCP connector.** Director uses this to read repo state (specs, CLAUDE.md, docs, code) and to commit doc changes (CLAUDE.md edits, new specs, runbook updates, ADRs). Director does NOT use it to commit code or to commit Builder's reports — those are Builder's responsibility, pushed from the Code session.
- **Project knowledge search.** Indexed snapshot of the repo. Recency lags pushes by minutes-to-hours; ask Drake to confirm the index is fresh before searching for post-push state. Stale-index reads against fresh-push reality is a known failure mode.
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

Director starts fresh per chat conversation. Auto-loads CLAUDE.md and recent specs/reports via project knowledge search (asking Drake first to confirm the index is fresh, since it lags pushes).

Director's first move on a new conversation:

1. Read § Live System State for what's currently shipped.
2. Read § Next Session Priorities for where to start.
3. Read § Current Focus for what's in flight.
4. Wait for Drake to say what he wants to tackle, in chat or via the Telegram channel.

Builder starts fresh per Code session. The SessionStart hook pulls latest from `origin/main` before any spec read or code work. Within a session, if Director pushes a new spec mid-flight, Builder explicitly re-pulls before reading it (project knowledge / git fetch state isn't automatic mid-session).

If anything in CLAUDE.md seems wrong or out of date, Director updates it directly via GitHub MCP with Drake's confirmation in chat. Don't silent-edit during active work; batch into a doc-hygiene commit.

### Things Director can update without asking

- Working norms sections, when norms genuinely shift (with Drake's confirmation in chat — don't silent-edit).
- `docs/known-issues.md` after a decision is made or a constraint is logged.
- `docs/specs/<slug>.md` entries Director writes during chat work.
- `CLAUDE.md` § Live System State + § Next Session Priorities + § Current Focus, during chat work as state changes. Drake reviews at gate moments.

### Things Drake updates himself

- Loom videos (no AI substitutes).
- Conversations with Nabeel, Zain, Aman.

## Director / Builder System

The Director / Builder system is the runtime shape of how work gets done. Working norms (the human-collaboration shape) live in the previous section; this section is about the agent topology.

### Roles

- **Director** — chat-Claude on claude.ai. Plans with Drake, decomposes work, writes specs to `docs/specs/<slug>.md`, commits specs + CLAUDE.md / docs / runbook updates via GitHub MCP, reads reports out-of-loop when Drake points to them, reports back. Does NOT commit or review Builder's code work.
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

**Cleanup cadence.** When work ships, Director updates the spec's `Status:` to `shipped` (via GitHub MCP) but leaves both spec and report files in place during the working day. Drake batches the deletion of all `shipped` spec/report pairs at end of day in a single doc-hygiene commit. Rationale: keeping shipped pairs around mid-day makes it easier to refer back to recent work without git-spelunking; EOD batching keeps the long-term repo clean. Director must NEVER delete a spec or report without an explicit "delete now" or "EOD cleanup" cue from Drake — silent deletion is a hard rule against. The durable record lives in CLAUDE.md § Live System State + git history once the EOD cleanup lands.

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

If something in the work was unusually expensive (e.g., "the test suite re-run ate ~half the runtime"), call it out in the relevant section above.

### Director behavior

Plan with Drake. Decompose the work into discrete Builder tasks. For non-trivial work, write a spec to `docs/specs/<slug>.md` (committed via GitHub MCP) and tell Drake the spec is ready. Drake hands the spec to Builder when ready to execute.

Director does NOT review Builder's code work pre-push. The topology has Builder pushing on its own, and Director can't see new pushes automatically — Drake reads the report after Builder lands the work, and points Director at it if there's something to discuss. When Drake points at a report, read it critically — verify what Builder claims it did against the diff if Drake wants a second opinion, flag anything off. The review is real, just out-of-loop.

**The push-without-review tradeoff.** The old topology had Director gate-keeping push by reviewing the diff. The new topology removes that gate because Director (chat) can't see new commits without Drake telling it to look. The remaining quality gates are: the spec itself (Director's upstream design check), Drake's four gates, Builder's own commit hygiene (no failing tests, no secrets, one logical change per commit), and Drake's out-of-loop report read. Spec quality becomes load-bearing — a sloppy spec executed blind by Builder and pushed without review can land bad code in `main`. Tighten specs accordingly.

**Director's own commits.** Director uses GitHub MCP to commit doc work — CLAUDE.md edits, new specs, runbook updates, ADRs, known-issues entries. These are Drake-present chat-driven changes (Drake reads the diff in chat as Director drafts), so the no-pre-push-review concern doesn't apply. Director does NOT use GitHub MCP to commit code or to commit Builder's reports — those are Builder's responsibility from the Code session.

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
├── api/                        # Vercel Python serverless functions (8 deployed)
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

**Commit policy.** Builder commits at the end of each meaningful unit of work (a feature complete, a migration applied, a file fully refactored) with a clear message following the convention. Don't commit half-finished work. Don't commit if tests/validation fail. Director commits doc work (CLAUDE.md, specs, runbooks, ADRs) via GitHub MCP as Drake confirms changes in chat.

**Push policy.** Builder pushes its own code commits and report commits. Director does not gate push — push is reversible (`git revert`, Vercel rollback) and stays out of the gate set. Drake's push-related role is post-deploy verification on real surfaces (gate (c)), not pre-push review.

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

Gregory is the CSM-facing agent: a Next.js dashboard backed by a deterministic brain (signals + scoring rubric + gated Claude-driven concerns) and three Airtable integration paths. Active development focus.

**Dashboard surfaces.** Routes: `/login`, `/clients`, `/clients/[id]`, `/calls`, `/calls/[id]`. The client detail page is a 7-section v3 layout (Identity & Contact / Lifecycle & Standing / Financials / Activity & Action Items / Profile & Background / Adoption & Programs / Notes) with full inline-edit. Status / journey_stage / csm_standing edits route through the migration-0018 RPC functions for atomic update + history-row writes. The `/clients` list page has a 9-dropdown filter bar (M5.5 → M5.7): 8 active multi-selects (Status / Primary CSM / CSM Standing / NPS Standing / Trustpilot / Country / Accountability / NPS toggle) + 1 single-value toggle (Needs review). Section 4 surfaces monthly-meetings tracker + inactivity flag (M5.7). Section 6 NPS Standing pill renders `clients.nps_standing` (M5.4). Auth via Supabase Auth (email/password, manually invited users) via the (authenticated) layout. Two Supabase clients by privilege: anon key + cookies for the auth gate, service role + `'server-only'` guard for data reads. Source: `app/`, `components/client-detail/`, `lib/db/clients.ts`, `lib/client-vocab.ts`. Spec + build log: `docs/agents/gregory.md`.

**Database (Supabase Postgres + pgvector).** Cloud project `sjjovsjcfffrftnraocu` (us-east-2, Ohio). Migration count, key tables, and RPC patterns documented in § Live System State below. Key tables: `clients` (with `metadata.alternate_emails`/`alternate_names` arrays for identity resolution), `calls`, `call_action_items`, `call_classification_history`, `client_status_history` + `client_journey_stage_history` + `client_standing_history` (history tables, application-layer write pattern), `client_health_scores` (Gregory brain output with `factors.concerns[]` jsonb), `nps_submissions`, `client_team_assignments`, `client_upsells`, `slack_channels`, `slack_messages` (local-only today), `documents` + `document_chunks` (Ella retrieval surface), `webhook_deliveries` (audit ledger for inbound webhooks), `agent_runs` + `agent_feedback` (agent telemetry). History-row RPC pattern (M4 Chunk B2): atomic update + history-row insert in one transaction, idempotent when value unchanged, attribute via `changed_by` UUID with structured note string. Cascade triggers on `clients` for status (M5.6) and csm_standing→happy (M5.7). Schema docs: `docs/schema/`.

**Ingestion paths.** Fathom transcripts land via two parallel paths: realtime webhook at `/api/fathom_events` (M4.1, signature-verified), and a daily Vercel cron at `/api/fathom_backfill` as the backstop. Both use the same `ingestion/fathom/` pipeline (classifier, chunker, pipeline) which writes `calls` + `call_participants` + `call_action_items` + `documents` (with `document_type='call_summary'` + `'call_transcript_chunk'`) + `document_chunks` with embeddings. Auto-creates a minimal `clients` row tagged `needs_review` when a participant doesn't match an existing client by email or name. Slack history (~2,914 messages across 8 channels) is local-only — cloud ingestion is sidelined Ella V2 work.

**CS visibility surfaces (M6.1, Batch A — shipped 2026-05-05).** Two Slack-channel surfaces give CSMs at-a-glance visibility into client-call activity and accountability submission gaps. Both reuse a shared `shared/slack_post.py` helper (factored out of Ella's `api/slack_events.py` two-token post path) and the `webhook_deliveries` audit pattern (with new source labels `cs_call_summary_slack_post` and `accountability_notification_cron`). Per-call CS summary fires inside the Fathom webhook pipeline whenever a `call_category='client'` call is ingested — posts a one-message summary (CSM / client / call-review content with Sentiment / Pain points / Wins / Conversation pivots sections; deep-link to Gregory) to `SLACK_CS_CALL_SUMMARIES_CHANNEL_ID`. When no usable `call_review` exists for the call (missing / malformed / degenerate), the hook **skips the Slack post entirely** and records the gap in `webhook_deliveries` (`processing_status='malformed'`, `processing_error='no_review_available'`, `payload.content_source='skipped_no_review'`); the pre-2026-05-09 Fathom-`default_summary` fallback was retired (old rows preserved). Audit payload's `content_source` field (`'call_review'` vs `'skipped_no_review'`) splits the two paths cleanly. Slack-post failure NEVER fails the underlying Fathom delivery. Pytest hermeticity is enforced by `tests/conftest.py` — an autouse fixture monkeypatches `shared.slack_post.post_message` plus the import-time-bound re-export inside `cs_call_summary_post` so no test can hit real Slack regardless of which code path it exercises. Daily accountability notification cron runs at 12:00 UTC (7am EST / 8am EDT) — fetches yesterday's submissions from Airtable, queries Gregory for active accountability-enabled clients, computes the missing list, posts one Slack message per CSM to `SLACK_CS_ACCOUNTABILITY_CHANNEL_ID` (skipped entirely when no CSM has missing clients; loud `:warning:` Slack alert on Airtable failure so silent breakage isn't possible). See `docs/runbooks/cs_call_summary.md` and `docs/runbooks/accountability_notification_cron.md` for operational guides.

**External integrations (Make.com / Airtable).** Three paths bridging Gregory ↔ Airtable through Make.com:

- **Path 1 inbound** — `api/airtable_nps_webhook.py` (M5.4). Make.com fires this when an Airtable NPS Survey row changes Segment Classification. Receiver normalizes the segment, calls `update_client_from_nps_segment` RPC (migration 0021, replaced 0027) which mirrors `nps_standing` and **always** auto-derives `csm_standing` from the segment (NPS-is-gospel post-2026-05-08, flipped from override-sticky in 0027). Auth via `X-Webhook-Secret` header (`AIRTABLE_NPS_WEBHOOK_SECRET`).
- **Path 2 outbound** — `api/accountability_roster.py` (M5.7+). Make.com pulls this daily; replaces the Financial Master Sheet as the source of truth for Zain's accountability + NPS automation. Returns the actionable client roster with email / full_name / country / advisor_first_name / Slack identifiers / accountability + NPS toggles. Auth via `MAKE_OUTBOUND_ROSTER_SECRET`.
- **Path 3 inbound** — `api/airtable_onboarding_webhook.py` (M5.9). Make.com fires this once per new client when Zain's onboarding flow completes. 7-field payload, calls `create_or_update_client_from_onboarding` RPC (migration 0025) which match-or-creates on email + alternate_emails with three branches (created / updated / reactivated), seeds history rows attributed to Gregory Bot UUID, raises structured exceptions for Slack ID conflicts → HTTP 409. Auth via `AIRTABLE_ONBOARDING_WEBHOOK_SECRET`.

Future Path 4 outbound writeback (Gregory → Airtable for fields beyond accountability/NPS, e.g. csm_standing changes flowing back) is deferred until a concrete need surfaces.

**Hosting.** Single Vercel project at `https://ai-enablement-sigma.vercel.app`. Mixed-framework: Next.js 14 dashboard at repo root + 9 Python serverless functions. `vercel.json` declares `"framework": "nextjs"` (required to suppress framework auto-detection when `functions` is also explicit) plus per-file Python runtimes. Vercel Cron schedules: daily 08:00 UTC → fathom_backfill; daily 09:00 UTC → gregory_brain_cron (switched from weekly Mondays on 2026-05-08 paired with the AI-signal freshness filter); daily 12:00 UTC → accountability_notification_cron; per-minute → passive_ella_cron (Ella V2 Batch 2.3 passive-monitor queue drainer).

## Live System State

As of 2026-05-08 (Call Review V1 + Gregory V2 brain + Fathom auto-review + daily cron + freshness filter + NPS-is-gospel + latest_nps source fix + clients list V2 columns + journey stage taxonomy + default-collapse Financials/Profile sections all shipped):

- **Cloud Supabase** is the production target. Project ref `sjjovsjcfffrftnraocu` (region us-east-2, Ohio). **28 migrations applied** (`0001_core_entities` through `0028_journey_stage_check`); migrations `0029_rename_ella_enabled_to_passive_monitoring.sql` + `0030_pending_ella_responses.sql` are committed and queued for apply at the next Drake-gated migration window (Batch 2.3 — see Batch 2.3 entry below for what they do). Recent migrations: 0017 added 14 columns to `clients` + 1 column to `nps_submissions` + 4 history/upsell tables (M4 Chunk A). 0018 added 4 `security definer` Postgres functions for atomic update + history-row writes (M4 Chunk B2). 0019 (`status_add_leave`) added the first DB-level CHECK on `clients.status` and expanded the vocabulary to include `leave` (M5.3). 0020 (`trustpilot_rename_vocab`) renamed `clients.trustpilot_status` 1:1 to match Scott's master sheet (M5.3b). 0021 (`nps_standing_and_gregory_bot`) added `clients.nps_standing` + Gregory Bot sentinel team_member (UUID `cfcea32a-062d-4269-ae0f-959adac8f597`) + `update_client_from_nps_segment` RPC (M5.4 Path 1). 0022 (`status_cascade`) added `clients.accountability_enabled` + `clients.nps_enabled` + `team_members.is_csm` + Scott Chasing sentinel (UUID `ccea0921-7fc1-4375-bcc7-1ab91733be73`) + BEFORE/AFTER triggers for the negative-status cascade (M5.6). 0023 (`change_primary_csm_on_conflict`) replaced the 0014 RPC with an `ON CONFLICT DO UPDATE` variant (M5.6 hotfix). 0024 (`trustpilot_cascade_on_happy`) added a one-directional BEFORE UPDATE trigger that auto-flips `clients.trustpilot_status` to `'ask'` when `csm_standing` transitions to `'happy'` (M5.7). 0025 (`create_or_update_client_from_onboarding`) added the security-definer RPC for Path 3 inbound (M5.9). 0026 (`onboarding_webhook_optional_slack`) made phone / slack_user_id / slack_channel_id optional on the Path 3 RPC (M6.x — supports Zain's two-pass onboarding flow). 0027 (`nps_is_gospel`) flipped `update_client_from_nps_segment` from override-sticky to always-auto-derive csm_standing from segment + one-time backfill of 16 stale rows (2026-05-08). 0028 (`journey_stage_check`) added a CHECK constraint on `clients.journey_stage` pinning the six-value funnel taxonomy (2026-05-08). Migrations 0001–0010 applied via the CLI; 0011–0028 applied via Studio + manual ledger insert during the CLI-broken era (2026-04-28 to 2026-05-08, see `docs/known-issues.md` § resolved entries); migration 0029 onward uses the CLI again per `docs/runbooks/apply_migrations.md` post-Phase-3 (psql not installed in this environment, so dual-verify uses psycopg2 against the pooler URL — discipline held throughout). Accessed via the pooler URL stored in `supabase/.temp/pooler-url`; the DB password lives in `.env.local` as `SUPABASE_DB_PASSWORD` (quoted because it contains a `#`).
- **Vercel deployment** live at `https://ai-enablement-sigma.vercel.app`. Single project, mixed-framework: Next.js 14 dashboard at repo root + **nine** Python serverless functions in `api/`. `vercel.json` declares `"framework": "nextjs"` plus per-file Python runtimes for: `api/slack_events.py` (Ella's Slack handler, `maxDuration: 60`), `api/fathom_events.py` (Fathom webhook, `maxDuration: 60`), `api/fathom_backfill.py` (daily cron, `maxDuration: 300`), `api/gregory_brain_cron.py` (daily cron, `maxDuration: 300`), `api/airtable_nps_webhook.py` (Path 1 inbound, `maxDuration: 60`), `api/accountability_roster.py` (Path 2 outbound GET, `maxDuration: 60`), `api/airtable_onboarding_webhook.py` (Path 3 inbound, `maxDuration: 60`), `api/accountability_notification_cron.py` (daily 7am EST CS-visibility cron, `maxDuration: 60` — added M6.1), `api/passive_ella_cron.py` (per-minute Ella passive-monitor queue drainer, `maxDuration: 60` — added Batch 2.3). Vercel Cron schedules: `0 8 * * *` daily → `/api/fathom_backfill`; `0 9 * * *` daily → `/api/gregory_brain_cron` (switched from weekly to daily 2026-05-08, paired with the freshness filter on `ai_call_signal` so each sweep only fires Sonnet for clients with new call_reviews since their last compute); `0 12 * * *` daily → `/api/accountability_notification_cron`; `* * * * *` per-minute → `/api/passive_ella_cron`. Env vars in production: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_USER_TOKEN`, `FATHOM_WEBHOOK_SECRET`, `FATHOM_API_KEY`, `CRON_SECRET` (validated by all cron endpoints — fathom_backfill, gregory_brain_cron, accountability_notification_cron, passive_ella_cron; consolidated to single-var pattern in M6.2), `AIRTABLE_NPS_WEBHOOK_SECRET`, `MAKE_OUTBOUND_ROSTER_SECRET`, `AIRTABLE_ONBOARDING_WEBHOOK_SECRET`, `SLACK_CS_CALL_SUMMARIES_CHANNEL_ID` (M6.1), `SLACK_CS_ACCOUNTABILITY_CHANNEL_ID` (M6.1), `AIRTABLE_ACCOUNTABILITY_PAT` (M6.1), `AIRTABLE_ACCOUNTABILITY_BASE_ID` (M6.1), `AIRTABLE_ACCOUNTABILITY_TABLE_ID` (M6.1), `ELLA_PASSIVE_MONITORING_ENABLED` (Batch 2.3 global kill switch — must be `'true'` for any passive behavior; default unset = off), `ELLA_PASSIVE_KB_RELEVANCE_THRESHOLD` (Batch 2.3 optional, default 0.3). (`GREGORY_CONCERNS_ENABLED` was the V1.1 concerns gate — retired in V2 brain ship 2026-05-07; if still set in Vercel it's a no-op.)
- **Gregory dashboard** live with the V1 client page schema (M4) + M5 vocab updates + M5.5 filter bar + M5.6 cascade + M5.7 monthly-meetings/inactivity/country/accountability/NPS-toggle filters. 188 non-archived clients post-M5 cleanup, perfect 1:1 with the canonical master sheet.
- **`clients` table population (post-cleanup, 2026-05-05):** 188 non-archived clients. Every negative-status client has `csm_standing='at_risk'` + `accountability_enabled=false` + `nps_enabled=false` (M5.6 cascade); every active client has the toggles at default `true`. `country` populated USA/AUS for every CSV-matched client. `clients.nps_standing` populated for 61 active clients via Path 1 backfill + alternate-emails resync.
- **Path 2 outbound roster live count:** 128 actionable / 188 non-archived (60 filtered for missing slack_user_id / channel / email). Surfaces a Slack-identity coverage gap; followup logged.
- **CS visibility surfaces (M6.1):** `agents/gregory/cs_call_summary_post.py` hooks into `ingestion/fathom/pipeline.py:ingest_call` for client-category calls (audit trail via `webhook_deliveries.source='cs_call_summary_slack_post'`). `api/accountability_notification_cron.py` runs daily at 12:00 UTC (`webhook_deliveries.source='accountability_notification_cron'`); 91 active accountability-enabled clients in scope at ship, all with active primary_csm assignments (the cron's no-CSM silent-drop bucket is empty today). Two new harnesses: `scripts/test_cs_call_summary_locally.py` (28/28) and `scripts/test_accountability_notification_cron_locally.py` (31/31). Slack-post infrastructure factored to `shared/slack_post.py` (Ella's two-token logic stays in `api/slack_events.py` and imports the transport from there; 14/14 Ella post-tests still pass after the refactor).
- **Call Review V1 (2026-05-07).** New `call_reviewer` agent at `agents/call_reviewer/` (Sonnet-only, system prompt + `review_call` + `upsert_call_review`). Generates a four-section structured review per call (pain_points / wins / dodged_questions / sentiment_arc) stored as `documents` rows with `source='fathom'`, `document_type='call_review'`, `is_active=False` (retrieval-side safety net — never lands in `match_document_chunks` results). May 2026 backfill complete: 31/31 reviewed, $1.5349 total Sonnet cost. One-shot script at `scripts/backfill_call_reviews.py` with `--smoke` / `--apply` / `--limit` modes; smoke mode is the working norm for all future backfills (see § Working Norms § Operational patterns). Calls detail page surfaces the review as Section 4.5 between Summary and Action items — sentiment_arc paragraph + three list subsections + "Generated <timestamp>" header. The "Conversation pivots" subsection renders the underlying `dodged_questions` data (renamed user-facing only in V2 brain ship).
- **Fathom pipeline auto-review (2026-05-07).** `ingestion/fathom/pipeline.py:_ensure_call_review_document` fires after each successful summary write for client-category calls with a non-null `primary_client_id`. Three-layer idempotency (existence guard + persistence upsert + pipeline invariant) keeps Fathom retries free. Fail-soft try/except — review-generation failure never breaks Fathom delivery. The 30-day call_review lookback window the V2 brain reads now refills automatically as calls land. `review_call` gained optional `trigger_type` kwarg (default `manual_backfill`; pipeline passes `fathom_pipeline`).
- **Gregory brain V2 (2026-05-07).** New `ai_call_signal` at `agents/gregory/ai_call_signal.py` is the dominant contributor (weight **0.50**) — reads each client's last 30 days of call_review documents, sends to Sonnet, returns a 0-100 contribution + 1-3 sentence reasoning + 0-3 concerns matching the existing dashboard `{text, severity, source_call_ids}` shape. Rubric rebalanced: `ai_call_signal 0.50 + call_cadence 0.20 + overdue_action_items 0.10 + latest_nps 0.20`. `open_action_items` retired (double-counting with overdue + the AI signal's qualitative action-item read). `concerns.py` + `GREGORY_CONCERNS_ENABLED` gate retired — concerns flow directly from the AI signal. Never-called-clients-land-green (M3.4 known issue) fully resolved by the rebalance: never-called clients now land at score=55 yellow. SweepResult carries `duration_ms + avg_per_client_ms` for the cron-ceiling watchpoint.
- **Default-collapse Financials + Profile sections on detail page (2026-05-08).** `components/client-detail/financials-section.tsx` and `components/client-detail/profile-section.tsx` now pass `defaultOpen={false}` to the shared `Section` primitive. Other 5 sections (Identity, Lifecycle, Activity, Adoption, Notes) stay default-expanded. Always-collapse-on-load (no localStorage / per-user state) — Financials + Profile are under-used and cluttered the page; CSMs click to expand when needed.
- **Journey stage taxonomy pinned (2026-05-08, migration 0028).** Six-value funnel CHECK constraint on `clients.journey_stage`: `business_setup` / `business_setup_activation_done` / `prospecting` / `first_closing_call_taken` / `first_closed_deal` / `ten_k_month` (or null). Replaced the V1 free-text shape that 0017 + 0018 explicitly anticipated formalizing later. Pre-apply data was 100% NULL across all 192 active clients — zero backfill needed; the cheapest possible window to add the constraint. Detail-page edit field switched from free-text to enum dropdown via `JOURNEY_STAGE_OPTIONS` in `lib/client-vocab.ts`. `JourneyStagePill` becomes label-aware. `agents/ella/prompts.py` fallback updated `"active"` → `"unknown"` since "active" is no longer in the taxonomy. CHECK applies to `clients.journey_stage` only, NOT to `client_journey_stage_history.journey_stage` — mirrors the 0019 status pattern; history is append-only audit.
- **Clients list V2 columns (2026-05-08).** 1-to-1 column swap on `app/(authenticated)/clients/clients-table.tsx`: out — Last call / Open action items / Tags. In — NPS standing / Trustpilot / Meetings this month. New `NpsStandingPill` + `TrustpilotPill` components with palettes matching the existing pill family (emerald/amber/rose/sky). Vocab labels in `lib/client-vocab.ts` updated so filter dropdown labels exactly match table pill labels: NPS_STANDING_OPTIONS now uses "Promoter" (was "Strong / Promoter" — Airtable-form artifact dropped); TRUSTPILOT_OPTIONS now uses "Given"/"Declined" (was "Yes"/"No"). Underlying enum values unchanged. Default sort flipped from `last_call_date desc` to `latest_health_score asc` (worst first) — surfaces attention-needing clients at the top now that V2 brain produces reliable scores; NULL-score clients sink to bottom via NULLS-LAST.
- **`latest_nps` signal source fix (2026-05-08).** `agents/gregory/signals.py:compute_latest_nps` now reads from `clients.nps_standing` (Airtable mirror via Path 1 + the 0027 NPS-is-gospel auto-derive) instead of `nps_submissions.score` (which stayed empty in production through M5). Mapping: promoter→100, neutral→50 (with distinct "(passive)" note), at_risk→0, NULL→neutral 50 with "no record" note. Defensive unexpected-value fallback past the 0021 CHECK. Score-shift on next sweep: at-risk clients drop ~10 points, promoter clients rise ~10 points — the rubric becomes appropriately discriminating; not a regression.
- **NPS-is-gospel auto-derive (2026-05-08, migration 0027).** Override-sticky semantics on `update_client_from_nps_segment` (M5.4 / 0021) flipped to "NPS is gospel" — every NPS Survey segment write now unconditionally auto-derives `csm_standing` via the existing `update_client_csm_standing_with_history` delegation. Override-sticky branches removed; `'problem'` stays manual-only because no segment maps to it. One-time backfill in the migration realigned 16 stale rows (14 master-sheet seeds + 2 stale Gregory Bot auto-derives, zero current CSM manual overrides per dry-run 2026-05-08). Receiver's `auto_derive_applied` flag is now always `true` on the 200 path; preserved for response-shape stability. NPS harness refactored to self-seeded fixture pattern (per-run RUN_TOKEN-suffixed unique email, hard-deleted on teardown) replacing the static-Branden fixture that broke when Branden was archived in M5 cleanup; 10 paths total (2 happy + 2 NPS-is-gospel + 6 negative).
- **Gregory brain V2 daily-cron + freshness filter (2026-05-08).** Cron schedule switched weekly→daily and `compute_ai_call_signal` gained a freshness check: before any LLM work, query `agent_runs` for the last successful compute timestamp for this client + max `documents.created_at` for `call_review` docs; if no new reviews since last compute, return the prior Signal verbatim (note rewritten to surface skip provenance + preserve original LLM-judged reasoning) and skip the Sonnet call. Skip-path opens an `agent_runs` row with `output_summary` starting with `"skipped"` so cost rollups split skip-rate from compute-rate. Each daily sweep now fires Sonnet for ~10 clients (typical new-review velocity) instead of all 188, fitting the 300s `maxDuration` ceiling. Trigger_type renamed `weekly_brain` → `scheduled_brain`. Defensive fallback: V1.1→V2 transition rows (no `ai_call_signal` entry in factors.signals[]) trigger recompute rather than returning malformed prior data. Freshness applies ONLY to `ai_call_signal`; deterministic signals (cadence, overdue, NPS) always recompute every sweep. Accepted 24h-max race: a Fathom auto-review landing AFTER the brain has read freshness for that client mid-sweep goes invisible until the next daily sweep — explicit trade-off of the architecture, not a bug.
- **Ella V2 Batch 1 — cloud Slack ingestion (2026-05-09).** Realtime ingestion of every `message`-type event from every client-mapped Slack channel, plus a one-shot historical backfill, both writing to `slack_messages`. Modules: `ingestion/slack/realtime_ingest.py` (new) is wired into `api/slack_events.py`'s `event_callback` dispatcher with a parallel branch alongside the existing (preserved-verbatim) `app_mention` handler. `shared/slack_identity.py` (new) resolves Ella's user_id behind `SLACK_USER_TOKEN` via `auth.test` so her own posts tag as the new `author_type='ella'`. Author-type vocab now: `client / team_member / ella / bot / workflow / unknown` (no migration — `slack_messages.author_type` has no CHECK; verified 2026-05-09). Parser now also includes `message_deleted` in `_SYSTEM_SUBTYPES` (preserve audit trail rather than overwrite). Audit ledger via `webhook_deliveries.source='slack_message_ingest'` with dual-discriminator pattern matching `cs_call_summary_post.py` precedent (CHECK on `processing_status` only allows `received/processed/failed/duplicate/malformed` — skip rows use `'processed'` + `processing_error='skipped_*'` + `payload.skip_reason=*`). Operational scripts: `scripts/backfill_slack_client_channels.py` (smoke + apply for the historical pull, hard-stops on `bot_not_in_channel` and on >250 channels), `scripts/invite_ella_and_bot_to_client_channels.py` (dry-run + apply for inviting Ella + bot to every client channel). Local backfill (`ingestion/slack/pipeline.py`) now also threads `ella_user_id`. Operational runbook: `docs/runbooks/slack_message_ingest.md`. Slack app config (event subscriptions + scopes) is Drake's gate (d). **Operational rollout (2026-05-10):** backfill of 8 known-good channels completed — 3,641 rows in `slack_messages` (Musa Elmaghrabi, Javi Pena production + #ella-test-drakeonly, Trevor Heck, Dhamen Hothi, Jenny Burnett, Art Nuno, Fernando G; per-channel counts in `docs/reports/ella-v2-batch-1-finish-rollout.md`). Backfill script's `bot_not_in_channel` hard-stop softened to log-and-continue + per-error-type summary so a future full-fleet bulk run won't abort on the first non-member channel. Live ingestion verified operational 2026-05-10 after `message.groups` event subscription was added to the Slack app config — client channels are typically private (🔒), and `message.channels` alone fires only for public channels; both subscriptions are now active alongside the `channels:history` + `groups:history` scopes. The 129 remaining client channels are pending Drake-led ops work to invite Ella's bot — once added, both backfill and realtime ingestion light up automatically with no further code changes. Also surfaced (tracked in known-issues): `--channel-id` on the backfill script doesn't strictly scope to that channel id when the underlying client maps to multiple channels — workaround is the `extra_channel_names` path in `run_ingest`.
- **Ella V2 Batch 1.5 — behavioral fixes (2026-05-10).** Seven bundled changes informed by the V1 interaction audit (`docs/reports/ella-interaction-audit.md`). (1) `agents/ella/identity.py` (new) resolves real speaker `slack_user_id` → `client` / `advisor` / `unresolvable`. `slack_handler.py` stops impersonating the channel-mapped client; `agent.py` resolves channel-client and speaker separately. `agent_runs.trigger_metadata` now carries `real_author_role/name/id` for honest analytics. (2) `prompts.py:_render_speaker_section` renders audience-aware persona block — V1 client behavior stays for clients, advisors get an explicit "Do NOT escalate, Do NOT emit [ESCALATE]" persona, unresolvable speakers get a safer-fallback persona. (3) On escalation Ella now writes an explicit `<@advisor_slack_user_id>` Slack mention in the client-facing ack so the advisor gets notified in real time; advisor mention syntax comes from the WHO IS SPEAKING prompt section. (4) `[ESCALATE]` detector flipped from "match at start only" to "match anywhere"; everything before the marker → client message, everything after → `escalations.context.handoff_reasoning` for the reviewing CSM. Catches both audit-flagged mid-response leaks (runs c84d63e1 and da7a4ee1). (5) `_post_to_slack` no longer threads — main-channel-only responses, with conversational context coming from a new `agents.ella.retrieval.fetch_recent_channel_context` (last 15 messages in the channel before the trigger, oldest-first, capped ~8000 chars). Subsumes future-ideas V2.1 + V2.2. (6) Bare @-mentions (stripped text <5 chars) skip Claude and return a randomized warm opener via `_handle_bare_mention`; logged as `agent_runs` with `trigger_type='bare_mention'` and zero token cost. Fixes audit run 88556dea. (7) Dual-trigger detection in `api/slack_events.py:_should_dual_trigger` — `message` events that @-mention Ella's human user_id (and not the bot) get reshaped to `app_mention` shape and dispatched through `_process_mention`. Doc updates: `docs/agents/ella/ella.md` (Trigger, Response Location, escalation flow, Style examples, System Prompt Direction point 10), `docs/agents/ella/future-ideas.md` (V2.1/V2.2 superseded; V2.3/V2.4 completed). Test suite: +28 new Ella-related tests (`test_identity.py`, `test_prompts.py`, `test_retrieval_recent_context.py`, `test_slack_events_dual_trigger.py`, plus additions to `test_agent.py` for bare-mention / detector / speaker plumbing). Drake validates in `#ella-test-drakeonly` post-deploy (gate c).
- **Ella V2 Batch 2.2 — audit dashboard (2026-05-10).** New Gregory dashboard page at `/ella/runs` (list) + `/ella/runs/[id]` (detail). Read-only surface scoped to `agent_runs WHERE agent_name='ella'`. List view has a summary band (today / week / month run counts, status mix over 30 days, cost, anomaly count), a filter bar (date range, channel multi-select, speaker role, status, anomaly flag, "Show anomalies only" toggle — all URL-state-serialized), and a paginated table (50/page). Detail view shows run header (real author + role, status, anomaly flags, cost · tokens), input, surrounding thread context (resolved display names, triggering message highlighted), Ella's response (split into client-facing vs captured `handoff_reasoning` when `[ESCALATE]` was detected), escalation row when present, full `trigger_metadata` JSON. Five anomaly checks mirror `scripts/audit_ella_interactions.py`: A (ESCALATE leak), B' (real-author mismatch — uses Batch-1.5 `trigger_metadata.real_author_id` field, pre-1.5 runs render as `role=unknown`), C (error), D (length outlier ±5%), E (bare mention). Query layer: `lib/db/ella-runs.ts`. UI: `app/(authenticated)/ella/runs/`. Top-nav gains "Ella" link. Prereq landing before Batch 2.3 passive monitoring so post-passive run volume is operationally manageable. Drake validates in production via gate (c).
- **Ella V2 Batch 2.3 — passive monitoring (2026-05-11).** Passive trigger pipeline in `ingestion/slack/realtime_ingest.py` forks to `agents/ella/passive_monitor.py:evaluate_passive_trigger` for every client message in a `slack_channels.passive_monitoring_enabled=true` channel. Pre-Haiku gates (global kill switch via `ELLA_PASSIVE_MONITORING_ENABLED`, author-type, CSM-directed via mention or first-name match, KB-relevance via `shared.kb_query.search_for_client` against the channel-mapped client's scope, firm-after-first via keyword-overlap against recent escalations) cheap-skip; Haiku (`claude-haiku-4-5-20251001`) decides one of `respond_substantive` / `respond_general_inquiry` / `skip` / `escalate`. Respond decisions queue to the new `pending_ella_responses` table with a 4-minute delay via `agents/ella/passive_dispatch.py:persist_passive_evaluation`; the new per-minute Vercel cron at `/api/passive_ella_cron` drains the queue, re-checks the kill switches + per-channel toggle + CSM-intervention (via `slack_messages` table read — covers main + thread automatically), and on intervention-free rows dispatches to `agents/ella/agent.py:respond_to_passive_trigger` (substantive — full Sonnet generation reusing the reactive prompt path) or `:handle_passive_general_inquiry` (canned warm opener, zero LLM cost). Escalations are backend DMs to the channel's primary_csm via `shared/slack_post.post_message` with a Slack deep-link to the triggering message + truncated `haiku_reasoning` — no quoted client content; audited under `webhook_deliveries.source='ella_passive_escalation_dm'`. Default-stance is **stay out**: every uncertain case skips silently. Migrations 0029 (rename `slack_channels.ella_enabled` → `passive_monitoring_enabled` + atomic CREATE OR REPLACE of the onboarding RPC to use the new column name in its Branch C INSERT) + 0030 (create `pending_ella_responses` queue table). Dual kill switches — env var `ELLA_PASSIVE_MONITORING_ENABLED` + per-channel `slack_channels.passive_monitoring_enabled` boolean — both default OFF at ship; Drake enables `#ella-test-drakeonly` first for validation per `docs/runbooks/ella_passive_monitoring.md`. Firm-after-first instruction also added to the Sonnet system prompt (`agents/ella/prompts.py`) — affects both reactive @-mention substantive responses and passive substantive responses since they converge on the same `build_system_prompt` output. Test suite: +40 tests across `tests/agents/ella/test_passive_monitor.py` (18, six gates + Haiku parse), `tests/agents/ella/test_passive_dispatch.py` (6, four decision outcomes + cost accounting), `tests/api/test_passive_ella_cron.py` (13, per-row gates + auth), `tests/ingestion/slack/test_realtime_ingest_passive_fork.py` (3, fork dispatch). Total suite passing: 507 tests post-Batch-2.3 (run via `.venv/bin/python -m pytest tests/`). Drake validates in production via gate (c) after flipping `ELLA_PASSIVE_MONITORING_ENABLED=true` + the per-channel toggle on `#ella-test-drakeonly`.
- **Test suite:** 414 passing (up from 381 baseline at start-of-day 2026-05-07; +33 across `tests/agents/call_reviewer/`, `tests/shared/ingestion/test_validate.py`, `tests/agents/gregory/test_ai_call_signal.py`, plus updates to `test_signals.py` / `test_scoring.py` / `test_agent.py` / `tests/ingestion/fathom/test_pipeline.py`). After V2 Batch 1: +13 ingest tests in `tests/api/test_slack_events_message_ingest.py`, +9 in `tests/shared/test_slack_identity.py`, +5 parser additions in `tests/ingestion/slack/test_parser.py` — see `git diff --stat` post-merge for the new total.

## Current Focus

**Meeting tracking — bridge into Task Management.** Primary in-flight work as of 2026-05-08 close. Per-client + per-CSM cadence visibility, late flags, end-of-week report to Scott + Nabeel. Real scoping conversation needed at next session-start before any code work. Supersedes the previously-queued "missed-call detection" piece under Batch A. See § Next Session Priorities item 1 + `docs/future-ideas.md` once the scoping conversation defines the work.

## Next Session Priorities

Pick these up in order. **Read this section first** when starting a new session — it's the single source of truth for where to start.

1. **Ella V2 Batch 2.3 — passive monitoring rollout.** Code shipped 2026-05-11 (full spec executed; 40 new tests passing). Outstanding work to get it live: (a) Drake reviews migration SQL for 0029 + 0030 then Builder runs `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes` (§ Builder gate-trajectory: SQL-review is permanent, apply + dual-verify is Builder's); (b) Drake sets `ELLA_PASSIVE_MONITORING_ENABLED=true` + `SLACK_WORKSPACE` (optional, for cleaner DM permalinks) in Vercel env vars and redeploys (gate (d)); (c) Drake flips `slack_channels.passive_monitoring_enabled=true` on `#ella-test-drakeonly` only and validates per the runbook (`docs/runbooks/ella_passive_monitoring.md`). Production rollout to other channels is post-validation work — not in the Batch 2.3 spec.

2. **Ella V2 Batch 2.1 — Slack messages as retrieval surface.** Scheduled after 2.3 because 2.1 has anonymization and cross-client privacy constraints that need their own scoping pass. The 3,641 backfilled `slack_messages` rows + ongoing realtime ingestion produce a rich retrieval surface, but pulling another client's channel content into Ella's prompt context for client X would be a privacy violation. Will need a per-client retrieval-scope gate similar to the call-summary retrieval pattern.

3. **Meeting tracking — bridge into Task Management.** Gregory-side, was previous current focus before Ella jumped the queue. Per-client + per-CSM cadence visibility, late flags, end-of-week report to Scott + Nabeel. Real scoping conversation needed at session-start before any spec — don't pre-draft. Supersedes the "missed-call detection" piece previously queued under Batch A.

4. **Batch A — CSM accountability visibility (remaining: call-tagging dashboard).** Per-call CS summary + daily accountability notification shipped M6.1 (2026-05-05); cron auth consolidated to single `CRON_SECRET` M6.2 (2026-05-06); missed-call detection rolled into Item 3's meeting tracking work. Remaining: call-tagging dashboard (gated on CSM ops adoption of a tagging convention). See `docs/future-ideas.md` § Batch A.

5. **Batch B — Call review + health score activation (mostly delivered 2026-05-07/08; remaining: NPS score piping V1.5).** Call Review V1 + Gregory V2 brain (AI signal at 0.50, concerns subsumed) + the health-score rubric rebalance + the never-called-clients-land-green fix all shipped 2026-05-07/08. The remaining piece is **NPS score piping (V1.5)**: extend Path 1 to ingest the numeric NPS score alongside the segment classification, write to `nps_submissions.score`, surface in the dashboard. See `docs/future-ideas.md` § Batch B.

6. **Batch C — Action item HITL flow (Nabeel's "transcript vision", V2 flagship).** Queued. AI drafts action item messages from transcripts → CSM reviews + edits in Gregory → CSM approves → Slack send to client channel + assigned-vs-completed tracking.

7. **Batch D — Classifier tuning.** Backstop only. Address only if titling discipline doesn't suppress the existing FP patterns (hiring-interview / spousal-rep / iMIP — see `docs/known-issues.md`). Otherwise leave.

8. **Batch E — Client business context vault.** Queued. Login credentials, brand assets, GHL snapshots, hosting/domain/email-setup info. Long-arc destination: a CSM-facing chatbot that queries the vault + brain for quick lookups.

**~~Deferred-decision pending Monday onboarding~~** — resolved by NPS-is-gospel migration 0027 (2026-05-08). The 137 master-sheet-seed clients are no longer sticky against Path 1 NPS auto-derive; the override-sticky gate was retired entirely.

## Ella (active focus)

Ella V2 is now the active multi-batch focus alongside Gregory. State as of 2026-05-11:

- **Batch 1 — cloud Slack ingestion (shipped 2026-05-09):** realtime + backfill into `slack_messages` for 8 channels (3,641 messages); live ingestion verified operational after `message.groups` event subscription was added 2026-05-10.
- **Batch 1.5 — behavioral fixes (shipped 2026-05-10):** speaker identity resolution, audience-aware prompt, advisor @-mention on escalation, loosened `[ESCALATE]` detector, main-channel-only responses with last-15-turn context, bare-mention handler, dual-trigger detection. Validated in `#ella-test-drakeonly`.
- **Batch 2.2 — audit dashboard (shipped 2026-05-11):** `/ella/runs` + `/ella/runs/[id]` with summary band, filter bar, anomaly views. 5 follow-up fixes flagged during validation (placeholder in `docs/known-issues.md`).
- **Batch 2.3 — passive monitoring (code shipped 2026-05-11; rollout gated on Drake's (a) migration SQL review + (d) env-var setup + (c) post-deploy validation):** passive trigger pipeline + Haiku decision module + queue table + per-minute cron drainer + escalation DM path + firm-after-first prompt + 40 new tests. Default-stance stay-out. Dual kill switches default OFF at ship. See § Live System State Batch 2.3 entry for full detail and `docs/runbooks/ella_passive_monitoring.md` for ops.
- **Batch 2.1 — Slack messages as retrieval surface** is queued after 2.3 due to anonymization/cross-client privacy constraints (§ Next Session Priorities #2).

Ella-specific docs continue to live in `docs/agents/ella/`.

## Other agents / future

- **CSM Co-Pilot V1** — Batch C territory. Lives at `agents/csm_copilot/` (placeholder). The action-item HITL flow + transcript-driven CSM-facing reasoning is its surface area.
- **Internal "Scout" assistant** — second agent on the shared Ella layer with team-wide retrieval scope. Sidelined; revisit-context in `docs/agents/ella/future-ideas.md`.

## Update Policy for This File

Update CLAUDE.md whenever:
- A core principle is clarified or extended
- A stack choice changes
- A new major convention is adopted
- The current focus shifts to a new phase / batch
- The "Live System State" snapshot drifts from reality

Treat it as living documentation. A stale CLAUDE.md is worse than no CLAUDE.md.
