# Report (PARTIAL): Ella Unanswered-Message Flagger
**Slug:** ella-unanswered-message-flagger
**Spec:** docs/specs/ella-unanswered-message-flagger.md
**Status:** halted — gate (a) migration SQL review pending + gate (d) env vars unsettable in this sandbox; nothing deployed

All code, tests, and behavior/design docs are complete and pushed to
the working branch. The spec cannot reach "Done means" this session
because two independent gates block the deploy: gate (a) (migration
0041 SQL review — Drake away, not pre-authorized) and gate (d) (the
`vercel` CLI is unavailable in this execution sandbox, so the
pre-authorized env-var commands could not run). Detail in § Surprises
and § What's needed to unblock.

## 1. Files touched

**Created**
- `supabase/migrations/0041_pending_digest_items_unanswered_flag.sql` — adds 3 `unanswered_*` columns + a partial scan index. **Written, not applied.**
- `api/ella_unanswered_flagger_cron.py` — the new 15-min safety-net cron.
- `tests/api/test_ella_unanswered_flagger_cron.py` — 15 cases for the cron.
- `docs/runbooks/ella_unanswered_flagger.md` — full operational runbook (mirrors the FAQ-digest runbook structure).

**Modified**
- `shared/slack_post.py` — `call_chat_post_message` now returns `(ok, slack_error, ts)`; `post_message` result dict gains `"ts"`. Additive.
- `api/slack_events.py` — two `call_chat_post_message` unpack sites absorb the new third element (`ok, slack_error, _ = ...`).
- `tests/conftest.py` — `_noop` returns `"ts": None`; registered `api.ella_unanswered_flagger_cron.post_message` in the safety-net list per the conftest convention.
- `vercel.json` — function entry + `*/15 * * * *` cron for the new endpoint.
- `.env.example` — `ELLA_UNANSWERED_FLAGGER_ENABLED` + `ELLA_UNANSWERED_CHANNEL_SLACK_ID`.
- `tests/agents/ella/test_passive_dispatch.py` — one no-op guard test (existing insert path doesn't write the new columns).
- `docs/schema/pending_digest_items.md` — 3 new column rows, new index, new reader.
- `docs/agents/ella/ella.md` — new "Unanswered Message Flagger" section + changelog entry.
- `docs/runbooks/cron_schedule.md` — new cron row + interval-cron note.

**Deferred (not touched — see § Out of scope)**
- `docs/state.md` — the "shipped" ledger entry is intentionally NOT written. Rationale below.

## 2. What I did, in plain English

**Acclimatization (confirmed):**
- `pending_digest_items` is the existing daily-digest queue (0040); the new columns are purely additive and the insert site in `passive_dispatch.py` (`insert_digest_item`) is untouched, so the migration is a no-op for existing inserts. `0040` is the latest migration → `0041` is the correct next number.
- The daily-digest cron is the structural template (auth via `CRON_SECRET`, testable `run_*` function, `webhook_deliveries` audit pattern, `post_message`, `SLACK_WORKSPACE` permalink builder); the accountability cron is the channel-post + "return 500 if channel env var unset" template. I mirrored both.
- `shared.slack_post.post_message` returns `{"ok", "slack_error"}` and does **not** expose the posted message `ts` — a real gap against the spec's step 7/8 ("capture the returned ts"). Resolved additively (see § Surprises).
- No contradictions found between the spec and what's shipped.

Built the cron exactly to the spec's 10-step flow: kill switch → channel-env check → candidate query (`unanswered_posted_at IS NULL`, age in `[2h, 7d]`, ≤50/tick, oldest first) → per-row human-intervention check against `slack_messages` (`author_type='team_member'`, `sent_at > created_at`) → resolve Scott (head_csm) + primary advisor (`client_team_assignments`) with dedup → format the channel post → `post_message` → stamp the row → audit row. Per-item Slack failures are isolated. Threaded the Slack `ts` through `shared.slack_post` additively so the audit columns get real data instead of NULL. Wrote the tests, the runbook, the schema/agent/cron-schedule doc updates, and the `.env.example` entries.

## 3. Verification

- **Full suite:** `python -m pytest tests/` → **626 passed** (clean baseline was 610; +16 new tests). Above the spec's ≥610 hard stop, no regression. (The sandbox shipped without project deps; I installed them via pip — see § Surprises — before establishing the 610 baseline.)
- **New cron tests:** all 15 pass, including the query-window cases (the fake `pending_digest_items` select genuinely applies the `IS NULL` + `[2h,7d]` filters, so "too new / too old / already posted" are real assertions, not no-ops).
- **`ruff check`** (the repo's enforced linter — `ruff format` is its formatter; black is *not* repo-clean even on HEAD): **All checks passed** on every file I created/modified. Applied `ruff format` to match repo style. The 30 `ruff check` items in `tests/` are pre-existing on HEAD (verified by stash) — not introduced here.
- **`tsc --noEmit` / `npm run lint`:** not run — zero TypeScript touched, so the spec's hard-stop #4 is clean by definition.
- **Migration:** NOT applied, so the dual-verify (schema reality + ledger) was NOT performed — gate (a), Drake away. This is the primary halt.
- **Phase 1 smoke (manual curl):** NOT performed — nothing is deployed.

## 4. Surprises and judgment calls

- **`post_message` doesn't return the Slack `ts` (spec-vs-reality gap).** The spec's steps 7–8 assume it does. I extended the shared helper additively: `call_chat_post_message` → 3-tuple `(ok, slack_error, ts)`, `post_message` dict gains `"ts"`, the two `slack_events.py` unpack sites absorb the extra element, `conftest._noop` returns `"ts": None`. No behavior change anywhere; the `ts` is audit/future-v2 data only. Judgment call: storing NULL would have been spec-non-compliant and thrown away genuinely useful audit data; the additive thread is low-risk and the cleaner choice. Flagging because it touches a widely-used shared helper + the Slack ingestion path (`slack_events.py`), which the spec framed as "no changes to the dispatch layer" — this is the shared *transport* helper, not the decision/dispatch logic, and the change is behavior-neutral.
- **Branch + deploy interaction.** The session's git requirement is to develop + push on `claude/set-slack-env-vars-xWJla`, not `main`. This is fortunate: pushing the feature branch preserves the work without triggering Vercel's production auto-deploy — which is exactly what we want, because deploying a cron that reads `unanswered_*` columns *before* migration 0041 is applied would error every 15 minutes. The branch requirement and the gate (a) hard stop point the same way.
- **`docs/state.md` deliberately NOT updated.** The spec lists it as a mandatory "shipped state" doc-update (40→41 migrations, 12→13 functions). But the work is not shipped — the migration is unapplied and nothing is deployed. `state.md`'s own preamble says it tracks reality and "if this file drifts from reality, it becomes a doc nobody trusts." Writing a "shipped today" entry now would be exactly that drift. Deferred to the resume pass (post-apply, post-deploy). The other docs track the committed branch (schema file, vercel.json, behavior) so they're correct to land now.
- **Sandbox missing dependencies.** This execution environment started without `dotenv`/`anthropic`/`openai`/`supabase`/`openpyxl` and without `pytest` in the project interpreter; the repo's own `supabase/` dir also shadows the pip package. I installed the deps via pip (network is available for pip) and worked around a debian-PyJWT RECORD conflict with `--ignore-installed`. Once resolved, the canonical 610-test baseline collected cleanly, confirming the environment now matches the spec's stated count. No code change was needed for this — environment-only.

## 5. Out of scope / deferred

- **Migration apply + dual-verification** — gate (a). Builder wrote the SQL and is surfacing it (below). NOT applied.
- **Vercel env vars** (`ELLA_UNANSWERED_CHANNEL_SLACK_ID`, `ELLA_UNANSWERED_FLAGGER_ENABLED`) — gate (d), pre-authorized by Drake but **un-executable here**: no `vercel` CLI, no `VERCEL_TOKEN`, `npx vercel` times out. Surfaced, not done.
- **Deploy + Phase 1 smoke** — blocked by the two gates above; nothing pushed to `main`.
- **`docs/state.md` shipped-ledger entry** — deferred until the work actually ships (rationale in § Surprises). This is the one mandatory-doc-list item not completed; called out explicitly per the spec's "if a doc doesn't need updating, say so" — here it *does* need updating, just not until ship.

## 6. Side effects

- **Real-world actions:** none. No Slack posts, no emails, no shared-DB writes, no external API calls, no migration applied, no deploy. All Slack/DB in tests is mocked (conftest belt-and-suspenders + per-test patches).
- **Sandbox-local only:** pip-installed project dependencies into the container's Python (ephemeral; not committed, not in the repo). No repo files outside the committed diff were created.
- **Git:** 5 commits on `claude/set-slack-env-vars-xWJla` + this report commit. Pushed to that branch only — **not** `main`, so **no Vercel production deploy was triggered** (intended).

## 7. What's needed to unblock

Two gates, both needing Drake. Resume is a short pass once cleared.

**Gate (a) — migration 0041 SQL review.** The exact SQL to review (`supabase/migrations/0041_pending_digest_items_unanswered_flag.sql`):

```sql
ALTER TABLE pending_digest_items
  ADD COLUMN unanswered_posted_at timestamptz,
  ADD COLUMN unanswered_post_slack_channel_id text,
  ADD COLUMN unanswered_post_slack_ts text;

CREATE INDEX pending_digest_items_unanswered_scan_idx
  ON pending_digest_items (created_at)
  WHERE unanswered_posted_at IS NULL;
```

Pure additive: 3 nullable columns + one partial index, no constraints, no backfill, no data touched. Existing rows get NULLs (correctly = "never checked yet"). On approval, a resumed Builder applies via `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes`, then dual-verifies (information_schema columns + pg_indexes AND `supabase_migrations.schema_migrations` version 0041).

**Gate (d) — Vercel env vars.** Drake pre-authorized the CLI commands, but the `vercel` CLI is not present in this sandbox (no binary, no token, `npx vercel` times out — outbound network policy). Options:

- **A (recommended).** Drake (or Zain) sets both in Vercel Production from a machine with the CLI / dashboard: `ELLA_UNANSWERED_CHANNEL_SLACK_ID=C0B4K3S0L85`, `ELLA_UNANSWERED_FLAGGER_ENABLED=true`. Then a resumed Builder (after gate (a)) pushes to `main` to deploy and runs Phase 1 smoke.
- **B.** Re-run this spec in an environment where the `vercel` CLI is available + authenticated, so the pre-authorized commands execute as written.

Either way, ordering is fixed: **migration applied → env vars set → push to `main` (deploy) → Phase 1 smoke.** Deploying before the migration is applied would error the cron every 15 minutes, so the branch was deliberately kept off `main`.

Once both gates clear, the resume pass is: apply + dual-verify migration, confirm env vars, fast-forward the branch to `main` (deploy), Phase 1 smoke, write the `docs/state.md` shipped entry (40→41 migrations, 12→13 functions), flip the spec `Status:` to `shipped`, and overwrite this report as complete (dropping the `(PARTIAL)` prefix + this section).
