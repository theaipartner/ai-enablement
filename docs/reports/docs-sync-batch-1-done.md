# Report: Docs sync — Batch 1 done, known-issues cleanup

**Slug:** docs-sync-batch-1-done
**Spec:** docs/specs/docs-sync-batch-1-done.md

## Files touched

**Modified:**
- `CLAUDE.md` — replaced the "live ingestion is NOT yet operational" sentence in the § Live System State Batch 1 entry with the verified-operational version (root cause: missing `message.groups`); folded in the 8-channel client list per the spec's suggested wording.
- `docs/known-issues.md` — struck through the "Ella V2 Batch 1 — realtime live ingestion not operational" entry header with `— RESOLVED 2026-05-10`, prepended a resolution paragraph, preserved the original bullets for diagnostic-reference value, and updated the **Logged** line. Added a new active entry: "Vercel auto-deploys silently failed on recent pushes to main (intermittent)". Left the `--channel-id` design-bug entry alone.
- `docs/runbooks/slack_message_ingest.md` — appended a `message.channels` vs `message.groups` paragraph to the Event-subscriptions section (with the 2026-05-10 caught-the-hard-way callout). Added a "First check (private channels)" bullet at position 0 of the "a message I sent isn't in `slack_messages`" debugging section.
- `docs/specs/ella-v2-batch-1-finish-rollout.md` — flipped line 4 from `**Status:** in-flight` to `**Status:** shipped`. Did NOT delete the file — EOD batch is Drake's per the 2026-05-10 cleanup-cadence policy.

**Created:**
- This report (`docs/reports/docs-sync-batch-1-done.md`).

## What I did, in plain English

Walked the spec's enumerated doc updates one file at a time. Four logical commits as the spec suggested (`docs: mark... operational`, `docs: resolve... known-issue, add Vercel... entry`, `docs: note message.groups...`, `docs: mark... spec as shipped`) plus this report. Each commit is one file, one logical change. No code touched. Used `Edit` (str_replace) against the actual file content rather than the spec's paraphrase, so wording drift between spec and the live file didn't bite.

For the known-issues resolved entry, matched the file's existing pattern (struck-through header + `— RESOLVED <date>` suffix, with a leading paragraph explaining the resolution and the original bullets preserved below for future diagnostic value). Modeled on the `~~Vercel build cache can carry forward bloated function bundles~~` entry already in the file — same shape.

For the runbook, the existing § Failure modes step 1 already mentioned "the `message.channels` / `message.groups` subscription isn't active" as a possible cause — but generically. The new "step 0" bullet is more specific (calls out the private-channel silent-failure-mode and points at the diagnostic signature in known-issues) and sits at position 0 to be the first thing a debugger sees.

## Verification

Ran `git diff --stat` on each commit before pushing to confirm only the intended file changed. Read the post-edit state of each file (specifically the lines around the edits) to confirm the `Edit` landed where intended. No tests run — pure docs change. Browsed the `/run` slash command's behavior via `git log --oneline` after each push to confirm nothing else accidentally landed.

Confirmed the EOD-batch policy update from commit `36736e6 docs: defer spec/report cleanup to EOD batch` (which itself landed mid-day 2026-05-10) by re-reading § Spec and report convention before deciding NOT to delete the shipped spec/report pair. Status flip only.

## Surprises and judgment calls

- **The runbook's § Failure modes step 1 already mentioned `message.channels` / `message.groups` generically.** Could have read this as "already covered" and skipped the spec's "First check" addition. Didn't, because the existing wording lumps `message.groups` together with `message.channels` and treats both as a single might-not-be-active concern — it doesn't surface the private-vs-public distinction that's the actual root cause, and it doesn't tell a future debugger to check that distinction first. The spec was right to ask for a more specific bullet at position 0; I added it and left the existing step 1 in place.
- **Resolved-entry pattern in known-issues.md.** Two patterns exist in the file: some resolved entries are completely replaced with a short "RESOLVED" stub (e.g. `~~Studio + manual ledger registration is the temporary canonical migration pattern~~ — RESOLVED 2026-05-08`), others preserve the original entry beneath the strike-through (e.g. the Vercel cache-contamination one). I chose the second pattern for the live-ingestion resolution because the diagnostic checklist in the original entry is genuinely reusable — if any future event-subscription change leaves the path silently broken, the four-step "Slack app config in this order" walkthrough is what a debugger would want. Cheap to keep.
- **Did NOT add a known-issues entry for the spec's "129 channels pending Drake-led ops work" remaining work.** That's a forward-looking ops note, not a known-issue. CLAUDE.md § Live System State Batch 1 entry already mentions it; no need to duplicate.
- **The Vercel auto-deploy entry's "Diagnostic open question" the spec suggested is folded into "Next action" rather than being its own bullet.** The 4-line known-issues format (What / Why it matters / Next action / Logged) is what every other entry in the file uses. Adding a 5th bullet would have broken the convention; the diagnostic question slots naturally into "Next action" since it IS the action.
- **The spec's suggested CLAUDE.md sentence wording was longer than the existing sentence I was replacing.** I tightened it slightly: kept the 8-channel client list, the `message.groups` root-cause clause, and the 129-channels-remaining note, but cut a clause about "no further code changes" because the next sentence already says "(backfill script's `bot_not_in_channel` hard-stop was softened in this same rollout pass...)" which conveys the same thing. Still more verbose than what was there before, which is fine — it's now load-bearing as the canonical post-rollout summary.
- **Four commits felt right vs bundling.** The spec said "one logical commit per file edited" with permission to bundle. Four files, four genuinely independent edits, each with a clean message — no reason to bundle. Each commit reads cleanly in `git log` as a single intent.
- **Did NOT touch the two pre-convention specs** (`cs-call-summary-review-content.md`, `ella-v2-batch-1-cloud-slack-ingestion.md`). Per the spec's hard stop ("No changes to docs/specs/<other-slug>.md files beyond the status update on this rollout's spec"), even though `/run` will continue flagging them as unparseable on every invocation until they're either backfilled-with-front-matter or moved to an archive. Director's call.

## Out of scope / deferred

- The 129 client channels still need bot invites. Not in this spec.
- The backfill `--channel-id` design-bug entry remains active — no fix in this spec.
- The Vercel auto-deploy intermittent failure stays open as "watch and capture next time it happens" rather than chasing a fix on a single observation.
- Spec/report cleanup for both `ella-v2-batch-1-finish-rollout` (now shipped per this commit) and `docs-sync-batch-1-done` (will be shipped after Drake reads this report) is Drake's EOD batch.

## Side effects

- **Four commits pushed to `origin/main`** during this work: `docs: mark Ella V2 Batch 1 live ingestion operational in CLAUDE.md`, `docs: resolve live-ingestion known-issue, add Vercel auto-deploy entry`, `docs: note message.groups requirement in slack_message_ingest runbook`, `docs: mark ella-v2-batch-1-finish-rollout spec as shipped`. This report will land as a fifth commit immediately after.
- **No code changes**, no test runs, no API calls, no DB writes, no Slack posts. Pure doc-hygiene pass.
- **No external services touched.** The only network egress was the four `git push` calls during commits.
